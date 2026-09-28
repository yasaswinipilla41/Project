import { revalidatePath } from "next/cache";
import type { IssueStatus, IssueType, Prisma, Priority } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AUTOMATIC_ASSIGNMENT_ACTION } from "@/lib/activity";
import { planBacklogAllocation } from "@/lib/backlogAllocation";
import { eligibleDeveloperCandidates } from "@/server/queries/backlogAllocation";
import {
  assertCanCreateWork,
  assertProjectAccess,
  ProjectAtCapacityError,
  workRoleOf,
  workRolesFor,
} from "@/lib/authz";
import type { requireUser } from "@/lib/session";
import {
  ISSUE_TYPE_LABEL,
  canHoldAnotherIssue,
  doesDeveloperWork,
  filableStatusesFor,
  isClosedStatus,
  statusRefusalReason,
} from "@/lib/domain";
import {
  addWatchers,
  assignmentMessage,
  isTester,
  notify,
  recordFieldChanges,
  recordIssueCreated,
} from "@/server/activity";
import {
  createIssueSchema,
  fieldErrors,
  type CreateIssueInput,
  type FieldErrors,
} from "@/server/schemas";

/**
 * What it takes to make a work item, split from the action that makes one.
 *
 * `createIssue` used to hold all of this inline: read the input, apply every
 * rule, then write. That is one operation for one work item, and it is still
 * exactly that — but the spreadsheet import needs the two halves apart. It has
 * to know whether *every* row would be accepted before it writes *any* of
 * them, and then to write them all inside one transaction so that a failure
 * half-way leaves nothing behind.
 *
 * So the rules live in `checkNewIssue` and the write lives in `insertIssue`,
 * and both callers use both. There is no second set of rules for imports to
 * drift from: a row the import calls valid is a row `createIssue` would have
 * accepted, because it is the same function that decided.
 *
 * Deliberately not `"use server"`. Everything exported from a server-action
 * file is a public endpoint, and these take a transaction handle and a user —
 * things a browser must never be able to supply.
 */

type SessionUser = Awaited<ReturnType<typeof requireUser>>;

/* ------------------------------------------------------------- issue key */

/**
 * Allocates the next issue number for a project.
 *
 * The increment happens inside the caller's transaction, so concurrent creates
 * serialise on the project row and no two issues can take the same number. The
 * counter is never decremented, so a deleted issue's key is never reused (§10).
 */
export async function nextIssueNumber(
  tx: Prisma.TransactionClient,
  projectId: string,
): Promise<{ number: number; key: string }> {
  const project = await tx.project.update({
    where: { id: projectId },
    data: { issueSequence: { increment: 1 } },
    select: { key: true, issueSequence: true, maxIssues: true },
  });

  /*
   * The project's issue limit, checked here because here is where every new
   * issue necessarily passes.
   *
   * Filing work and allocating its key are the same act, so a creation path
   * that skipped this check could not produce a key — which is a stronger
   * guarantee than remembering to repeat the check in each caller, and is why
   * it is not written at the two call sites instead.
   *
   * The update above holds this project's row for the rest of the transaction,
   * so the count cannot be raced: a second create arriving at the same moment
   * waits here, and reads a count that already includes the first. Refusing by
   * `throw` rolls the transaction back, which also returns the sequence number
   * this call just took — a refused create leaves no gap in the keys.
   */
  if (project.maxIssues !== null) {
    const held = await tx.issue.count({ where: { projectId } });
    if (!canHoldAnotherIssue(held, project.maxIssues)) {
      throw new ProjectAtCapacityError();
    }
  }

  return {
    number: project.issueSequence,
    key: `${project.key}-${project.issueSequence}`,
  };
}

/* ------------------------------------------------------------ parenthood */

/**
 * Whether `parentId` may become the parent of an issue in `projectId`.
 *
 * The parent of an issue is another **issue** — never its project. The two are
 * separate relationships and neither substitutes for the other: `projectId`
 * says where the work is filed, `parentId` says what larger piece of work it
 * belongs to, and this only ever resolves the second.
 *
 * Returns the message to show, or `null` when the choice is legal. Four things
 * are refused, and the fourth is why this exists as a function at all:
 *
 *   - a parent in another project — a child would then belong to two;
 *   - a parent that is itself a sub-issue (Prio supports one level, §24);
 *   - the issue itself, which is a cycle of length one;
 *   - a parent chosen for an issue that already *has* sub-issues, which would
 *     make three levels and, if the two pointed at each other, a loop.
 *
 * `createIssue` checked the first two inline. `updateIssue` checked none of
 * them: it tracked `parentId` as ordinary text and wrote whatever it was
 * handed, so a crafted payload could file an issue under another project's, or
 * under itself. Both callers now go through here.
 */
export async function parentProblem(
  parentId: string,
  projectId: string,
  /** The issue being re-parented, or `null` when it does not exist yet. */
  childId: string | null,
): Promise<string | null> {
  if (childId !== null && parentId === childId) {
    return "An issue cannot be its own parent.";
  }

  const parent = await prisma.issue.findUnique({
    where: { id: parentId },
    select: { projectId: true, parentId: true },
  });

  if (!parent || parent.projectId !== projectId) {
    return "Choose an issue from this project.";
  }
  if (parent.parentId) {
    return "Prio supports one level of sub-issues.";
  }

  if (childId !== null) {
    const children = await prisma.issue.count({ where: { parentId: childId } });
    if (children > 0) {
      return "This issue has sub-issues of its own, so it cannot become one.";
    }
  }

  return null;
}

/* ---------------------------------------------------------------- checking */

export type NewIssueCheck =
  | {
      ok: true;
      input: CreateIssueInput;
      status: IssueStatus;
      /** A pure tester is filing — what the automatic hand-out keys on. */
      filesAsTester: boolean;
    }
  | { ok: false; error: string; code?: string; fieldErrors?: FieldErrors };

/**
 * Every rule for raising a work item, applied to `raw` on behalf of `user`.
 *
 * Reads only; writes nothing. Throws `AuthorizationError` / `NotFoundError`
 * where the caller has no access, exactly as `createIssue` always has — the
 * action turns those into a refusal, the import turns them into a row's error.
 */
export async function checkNewIssue(
  user: SessionUser,
  raw: unknown,
): Promise<NewIssueCheck> {
  const parsed = createIssueSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Please correct the highlighted fields.",
      fieldErrors: fieldErrors(parsed.error),
    };
  }
  const input = parsed.data;

  await assertProjectAccess(user, input.projectId);
  /* What may be raised, by this person, of this kind — the approved matrix,
     applied on the server because a hidden button is not what stops a direct
     call. Where it may be raised was settled on the line above. */
  await assertCanCreateWork(user, input.type);

  const role = await workRoleOf(user);

  /*
   * What this person may file work as.
   *
   * Raising work and moving it are separate decisions, so this is not the
   * transition list and, for a pure tester, not the settable list either. A
   * tester raises work into the Backlog or as New — what they file is a
   * request for somebody to pick up, and whether it is being built or
   * finished is not theirs to declare at the moment they raise it.
   *
   * Enforced here rather than by the form offering one option: a stale form,
   * a copied request or a clone of a finished issue would otherwise put a
   * different status back.
   *
   * Omitting the status means the first one they may file in, which is
   * Backlog for a tester and Backlog for an administrator.
   */
  const permitted = filableStatusesFor(role);
  const status = input.status ?? permitted[0] ?? "TODO";

  if (!permitted.includes(status)) {
    return {
      ok: false,
      error: statusRefusalReason(role, null, status),
      fieldErrors: { status: "Not a status you can file work as." },
    };
  }

  /*
   * A tester hands work to somebody who builds, and dates nothing.
   *
   * Raising a defect and saying who should fix it are one act for a tester,
   * so the assignee is theirs to set. Two limits still apply, and both are
   * enforced below rather than by the form: the person named must actually
   * build — a tester may not hand work to another tester, and may not hand
   * it to an administrator — and the project-membership rule every assignee
   * faces applies unchanged.
   *
   * The due date stays an administrator's. A tester reporting something is
   * not planning somebody's week, and unlike the assignee there is nobody
   * the work is being passed to. It is dropped rather than refused, because
   * it is an optional fact about the work rather than an instruction that
   * failed: a tester cloning a dated issue gets their copy, undated.
   *
   * None of this touches anybody who also builds; it is the pure tester's
   * rule, not QA's half of a fullstack job.
   */
  const filesAsTester = role === "QA";
  if (filesAsTester) {
    input.dueDate = null;

    if (input.assigneeId) {
      const [assigneeRole] = (
        await workRolesFor([input.assigneeId])
      ).values();

      if (!assigneeRole || !doesDeveloperWork(assigneeRole) ||
          assigneeRole === "ADMIN") {
        return {
          ok: false,
          error: "Work can only be handed to a developer.",
          fieldErrors: {
            assigneeId: "Choose a developer or full stack developer.",
          },
        };
      }
    }
  }

  // An assignee must be a member of the project they are being assigned in.
  if (input.assigneeId) {
    const member = await prisma.projectMember.count({
      where: { projectId: input.projectId, userId: input.assigneeId },
    });
    if (member === 0) {
      return {
        ok: false,
        error: "That person is not a member of this project.",
        fieldErrors: { assigneeId: "Not a member of this project." },
      };
    }
  }

  // Labels must belong to the same project.
  if (input.labelIds.length > 0) {
    const validLabels = await prisma.label.count({
      where: { id: { in: input.labelIds }, projectId: input.projectId },
    });
    if (validLabels !== input.labelIds.length) {
      return { ok: false, error: "One or more labels are not valid here." };
    }
  }

  // The parent is an issue in this project, and only one level deep (§24).
  if (input.parentId) {
    const problem = await parentProblem(
      input.parentId,
      input.projectId,
      null,
    );
    if (problem) {
      return { ok: false, error: problem, fieldErrors: { parentId: problem } };
    }
  }

  return { ok: true, input, status, filesAsTester };
}

/* ----------------------------------------------------------------- writing */

/**
 * Writes one work item inside the caller's transaction.
 *
 * Takes the transaction rather than opening one so that a caller creating
 * several can put them all in the same one. `input` and `status` are what
 * `checkNewIssue` returned; this trusts them and re-decides nothing.
 */
export async function insertIssue(
  tx: Prisma.TransactionClient,
  user: SessionUser,
  input: CreateIssueInput,
  status: IssueStatus,
) {
    const { number, key } = await nextIssueNumber(tx, input.projectId);

    // Place new work at the end of its column.
    const last = await tx.issue.findFirst({
      where: { projectId: input.projectId, status },
      orderBy: { sortIndex: "desc" },
      select: { sortIndex: true },
    });

    const issue = await tx.issue.create({
      data: {
        key,
        number,
        projectId: input.projectId,
        type: input.type,
        title: input.title,
        /* The schema has always accepted a description and this never
           wrote it, so every description handed to `createIssue` was
           silently dropped. Harmless while no form offered the field;
           not harmless now that every type has one. */
        description: input.description,
        status,
        priority: input.priority,
        severity: input.severity,
        assigneeId: input.assigneeId,
        reporterId: user.id,
        dueDate: input.dueDate,
        parentId: input.parentId,
        sortIndex: (last?.sortIndex ?? 0) + 1000,
        completedAt: isClosedStatus(status) ? new Date() : null,

        // The retired bug columns. Nothing collects them any more; they are
        // still accepted so an existing caller is not broken.
        environment: input.type === "BUG" ? input.environment : null,
        browser: input.type === "BUG" ? input.browser : null,
        operatingSystem: input.type === "BUG" ? input.operatingSystem : null,
        versionBuild: input.type === "BUG" ? input.versionBuild : null,
        affectedModule: input.type === "BUG" ? input.affectedModule : null,

        labels:
          input.labelIds.length > 0
            ? {
                createMany: {
                  data: input.labelIds.map((labelId) => ({ labelId })),
                },
              }
            : undefined,
      },
      select: {
        id: true,
        key: true,
        type: true,
        title: true,
        project: { select: { key: true } },
      },
    });

    await recordIssueCreated(tx, {
      issueId: issue.id,
      actorId: user.id,
      isBug: input.type === "BUG",
    });

    /*
     * Work that is born assigned is still work that was assigned.
     *
     * The creation row names the type and the actor but carries no field,
     * so an issue filed straight to somebody had no assignment history at
     * all — including every row brought in by the spreadsheet import and
     * every clone, which both go through here. The history then answered
     * "who gave this to me?" with silence for exactly the cases where
     * nobody remembers.
     */
    if (input.assigneeId) {
      await recordFieldChanges(tx, {
        issueId: issue.id,
        actorId: user.id,
        changes: [
          {
            field: "assigneeId",
            oldValue: null,
            newValue: input.assigneeId,
          },
        ],
      });
    }

    await addWatchers(tx, issue.id, [user.id, input.assigneeId]);

    if (input.assigneeId) {
      await notify(tx, {
        issueId: issue.id,
        actorId: user.id,
        userIds: [input.assigneeId],
        type: "ISSUE_ASSIGNED",
        message: assignmentMessage({
          issueKey: issue.key,
          issueTitle: issue.title,
          typeLabel: ISSUE_TYPE_LABEL[input.type].toLowerCase(),
          tester: await isTester(tx, input.assigneeId),
        }),
      });
    }

    return issue;
}

/* ------------------------------------------------- after a work item is made */

/**
 * What happens once a work item has been stored, for both ways of making one.
 *
 * Kept here so `createIssue` and the spreadsheet import cannot disagree about
 * it: a tester who files a backlog item through the Create form and one who
 * files the same item through an import get the same hand-out.
 */
export async function afterIssueCreated(params: {
  created: { id: string; key: string; title: string; type: IssueType };
  input: CreateIssueInput;
  status: IssueStatus;
  filesAsTester: boolean;
  actorId: string;
}): Promise<void> {
  const { created, input, status, filesAsTester, actorId } = params;

    /*
     * A tester's unclaimed backlog item is a request for somebody to pick it
     * up, so Prio picks somebody.
     *
     * Only for a pure tester, and only for work they left in the backlog with
     * nobody's name on it — the two facts that make it a request rather than a
     * decision. An administrator parking work in the backlog is planning, and
     * they have the Auto-assign backlog dialog for when they want it dealt out;
     * anybody who builds is filing work they may be about to start. Neither is
     * touched.
     *
     * Deliberately after the transaction rather than inside it. If this cannot
     * run, the issue is already safely stored as Backlog and unassigned, which
     * is exactly the state the rule falls back to when nobody is eligible — so
     * a failure here costs the hand-out and never the work.
     *
     * Which is also why it is caught rather than allowed to escape: the work
     * was raised and stored, and reporting the creation as failed would be
     * false. It is logged the way every other server-side fault here is, so it
     * is recoverable rather than invisible — an administrator can still deal
     * the item out from Auto-assign backlog.
     */
    if (filesAsTester && status === "BACKLOG" && !input.assigneeId) {
      try {
        await handOutNewBacklogWork({
          issueId: created.id,
          issueKey: created.key,
          issueTitle: created.title,
          type: created.type,
          priority: input.priority,
          projectId: input.projectId,
          actorId: actorId,
        });
      } catch (error) {
        console.error(
          `[prio] automatic assignment failed for ${created.key}:`,
          error,
        );
      }
    }
}

/**
 * Handing one newly raised backlog item to whoever is free to build it.
 *
 * Nothing about *who* is decided here. The candidates are
 * `eligibleDeveloperCandidates` — the project's members who do development
 * work, narrowed to the people a rule may hand work to, weighed by the
 * workload figure Admin Home already shows — and the choice is
 * `planBacklogAllocation`, the same engine the Auto-assign backlog dialog
 * runs. One issue is a one-element backlog to it, so the priority order, the
 * lightest-queue rule and the tie-break by name then id are all the existing
 * ones rather than a second implementation that agrees today.
 *
 * What this adds is the pair of writes the dialog does not do:
 *
 *  - **the assignment and the move out of the backlog together.** Backlog is
 *    where work waits for somebody; once it has somebody it is New. They are
 *    one `updateMany` so the intermediate state cannot be observed or left
 *    behind, and its `where` carries the state this ran against — still
 *    Backlog, still unassigned — so a second creation path, an administrator
 *    assigning by hand in the same moment, or a retry cannot take the work off
 *    whoever already has it. No rows matched means somebody got there first,
 *    and then nothing at all is written, including the history.
 *  - **the trail and the notice**, through `recordFieldChanges`, `addWatchers`
 *    and `notify` — the same three the rest of `issues.ts` writes an
 *    assignment with. The assignment row carries
 *    `AUTOMATIC_ASSIGNMENT_ACTION`, so the history says this was Prio's
 *    decision and not the tester's choice of developer.
 *
 * Nobody eligible means nothing happens: the issue stays Backlog and
 * unassigned rather than becoming New with no one on it, and rather than being
 * handed to somebody who should not have it.
 */
async function handOutNewBacklogWork(params: {
  issueId: string;
  issueKey: string;
  issueTitle: string;
  type: IssueType;
  priority: Priority;
  projectId: string;
  actorId: string;
}): Promise<void> {
  const candidates = await eligibleDeveloperCandidates(params.projectId);
  if (candidates.length === 0) return;

  const { allocations } = planBacklogAllocation(
    [
      {
        id: params.issueId,
        key: params.issueKey,
        title: params.issueTitle,
        priority: params.priority,
        stage: "BACKLOG",
      },
    ],
    candidates,
  );

  const placed = allocations[0];
  if (!placed) return;

  await prisma.$transaction(async (tx) => {
    const claimed = await tx.issue.updateMany({
      where: { id: params.issueId, status: "BACKLOG", assigneeId: null },
      data: { assigneeId: placed.assigneeId, status: "TODO" },
    });
    if (claimed.count === 0) return;

    /* Prio's decision, recorded as one. The actor is the person who raised the
       work — they caused it — and the action says they did not choose who. */
    await recordFieldChanges(tx, {
      issueId: params.issueId,
      actorId: params.actorId,
      action: AUTOMATIC_ASSIGNMENT_ACTION,
      changes: [
        { field: "assigneeId", oldValue: null, newValue: placed.assigneeId },
      ],
    });

    /* And the move it caused, as the ordinary status entry every other status
       change writes — `issue.assigned.auto` names an assignment, and putting it
       on a status row would make the assignment history read one that is not
       there. */
    await recordFieldChanges(tx, {
      issueId: params.issueId,
      actorId: params.actorId,
      changes: [{ field: "status", oldValue: "BACKLOG", newValue: "TODO" }],
    });

    await addWatchers(tx, params.issueId, [placed.assigneeId]);

    /*
     * The notice `createIssue` already sends whoever is handed new work, with
     * the same type and the same sentence — this is the same event, reached by
     * a rule instead of by a name in a form.
     *
     * `workflowActivity` is deliberately not set, matching the assignment
     * notice beside it in `createIssue`: it would divert a full stack
     * reporter's notice to the administrators, and the one person who must
     * hear that work is now theirs is the developer it went to. `tester` is
     * false because `eligibleDeveloperCandidates` only ever yields somebody
     * whose working role is DEVELOPER.
     */
    await notify(tx, {
      issueId: params.issueId,
      actorId: params.actorId,
      userIds: [placed.assigneeId],
      type: "ISSUE_ASSIGNED",
      message: assignmentMessage({
        issueKey: params.issueKey,
        issueTitle: params.issueTitle,
        typeLabel: ISSUE_TYPE_LABEL[params.type].toLowerCase(),
        tester: false,
      }),
    });
  });
}

/* ------------------------------------------------------------ revalidation */

/**
 * Every surface that lists or counts work, told a work item has appeared.
 *
 * Moved here from `issues.ts` unchanged so the import can use it too; a
 * function that decides which pages are stale is the wrong thing to have two
 * copies of.
 */
export function revalidateIssueSurfaces(projectKey: string, issueKey: string): void {
  revalidatePath("/");
  revalidatePath("/issues");
  revalidatePath("/bugs");
  revalidatePath("/my-work");
  revalidatePath(`/issues/${issueKey.toLowerCase()}`);
  revalidatePath(`/projects/${projectKey.toLowerCase()}`);
  /* Summary is a route of its own now, so the base path no longer covers it. */
  revalidatePath(`/projects/${projectKey.toLowerCase()}/summary`);
  revalidatePath(`/projects/${projectKey.toLowerCase()}/timeline`);
  revalidatePath(`/projects/${projectKey.toLowerCase()}/board`);
}
