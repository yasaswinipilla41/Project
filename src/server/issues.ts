"use server";

import { revalidatePath } from "next/cache";
import type {
  IssueStatus,
  IssueType,
  Prisma,
  Priority,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { listIssues } from "@/server/queries/issues";
import {
  assertIssueAccess,
  assertProjectAccess,
  AuthorizationError,
  NotFoundError,
  assertCanCreateWork,
  workRoleOf,
} from "@/lib/authz";
import { requireUser } from "@/lib/session";
import {
  ISSUE_TYPE_LABEL,
  STATUS_LABEL,
  canEditDueDate,
  canEditIssueName,
  canEditPriority,
  canSetStatus,
  filableStatusesFor,
  doesDeveloperWork,
  isClosedStatus,
  statusRefusalReason,
} from "@/lib/domain";
import {
  addWatchers,
  assignmentMessage,
  isTester,
  notify,
  projectTesterIds,
  recordFieldChanges,
  recordIssueCreated,
  watcherIds,
} from "@/server/activity";
import {
  claimIssueSchema,
  cloneIssueSchema,
  createIssueSchema,
  fieldErrors,
  reportBugSchema,
  updateIssueSchema,
  type FieldErrors,
} from "@/server/schemas";
import { createIssueLink } from "@/server/links";

/**
 * Issue, story and bug writes.
 *
 * A Bug is `Issue.type = BUG` — there is no separate table and no separate code
 * path beyond the extra fields and their validation (§25).
 */

export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: FieldErrors };

function failure(error: unknown): ActionResult<never> {
  if (error instanceof AuthorizationError || error instanceof NotFoundError) {
    return { ok: false, error: error.message };
  }
  console.error("[prio] issue action failed:", error);
  return {
    ok: false,
    error: "Something went wrong. Please try again.",
  };
}

/* ------------------------------------------------------------- issue key */

/**
 * Allocates the next issue number for a project.
 *
 * The increment happens inside the caller's transaction, so concurrent creates
 * serialise on the project row and no two issues can take the same number. The
 * counter is never decremented, so a deleted issue's key is never reused (§10).
 */
async function nextIssueNumber(
  tx: Prisma.TransactionClient,
  projectId: string,
): Promise<{ number: number; key: string }> {
  const project = await tx.project.update({
    where: { id: projectId },
    data: { issueSequence: { increment: 1 } },
    select: { key: true, issueSequence: true },
  });

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
async function parentProblem(
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

/* --------------------------------------------------------------- create */

export interface CreatedIssue {
  id: string;
  key: string;
  type: string;
  title: string;
  projectKey: string;
}

export async function createIssue(
  raw: unknown,
): Promise<ActionResult<CreatedIssue>> {
  try {
    const user = await requireUser();

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
    /* Raising work is an administrator's or a tester's act, not a
       developer's. Enforced here rather than by hiding the button, because
       the button is not what stops a direct call. */
    await assertCanCreateWork(user);

    const role = await workRoleOf(user);

    /*
     * What this person may file work as.
     *
     * Raising work and moving it are separate decisions, so this is not simply
     * the transition list. Work is raised as New in Prio's workflow — a tester
     * finds a defect and files it for somebody to pick up — and New is
     * therefore filable by anybody who may raise work at all, alongside the
     * statuses their own half of the job may set.
     *
     * Everyone who builds already has New, so the union only ever adds it for
     * a pure tester, whose transition list starts at Ready for QA. Without it
     * a tester could not file the thing they are for: reporting something
     * nobody has looked at yet.
     *
     * Omitting the status means the first one they may file in, which is New
     * for a tester and Backlog for an administrator.
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
     * A tester files work; they do not hand it out or date it.
     *
     * Deciding who does a piece of work is an administrator's, and so is when
     * it is due — a tester raising a defect is reporting something, not
     * planning somebody's week. The QA create form does not offer either
     * field, and this is why that is not the protection: the values are
     * dropped here, so a stale form, a copied request or a clone of an issue
     * that had them cannot put them back.
     *
     * Dropped rather than refused because both are optional facts about the
     * work, not instructions that failed — a tester cloning an assigned issue
     * gets their copy, unassigned, which is what they are allowed to create.
     * Anyone who also builds keeps both fields; this is the pure tester's
     * restriction, not QA's half of a fullstack job.
     */
    const filesAsTester = role === "QA";
    if (filesAsTester) {
      input.assigneeId = null;
      input.dueDate = null;
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

    const created = await prisma.$transaction(async (tx) => {
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
    });

    revalidateIssueSurfaces(created.project.key, created.key);

    return {
      ok: true,
      data: {
        id: created.id,
        key: created.key,
        type: created.type,
        title: created.title,
        projectKey: created.project.key,
      },
    };
  } catch (error) {
    return failure(error);
  }
}

/* --------------------------------------------------------------- update */

/**
 * Applies a partial update and records one activity entry per changed field.
 * Fields absent from the payload are left untouched.
 */
export async function updateIssue(
  raw: unknown,
): Promise<ActionResult<{ key: string }>> {
  try {
    const user = await requireUser();

    const parsed = updateIssueSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        error: "Please correct the highlighted fields.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }
    const { issueId, ...input } = parsed.data;

    const projectId = await assertIssueAccess(user, issueId);

    // Same rule `createIssue` already enforces: an assignee must belong to
    // the issue's project. Checked here too — reassignment is a separate
    // write path and must not be able to hand an issue to an outsider.
    if (input.assigneeId) {
      const member = await prisma.projectMember.count({
        where: { projectId, userId: input.assigneeId },
      });
      if (member === 0) {
        return {
          ok: false,
          error: "That person is not a member of this project.",
          fieldErrors: { assigneeId: "Not a member of this project." },
        };
      }
    }

    /*
     * And the same rule for the parent, which this path did not check at all.
     * Re-parenting is a separate write from creation, so the constraints have
     * to be re-stated here or they simply do not apply — `parentId` was being
     * written as though it were a piece of text.
     */
    if (input.parentId) {
      const problem = await parentProblem(input.parentId, projectId, issueId);
      if (problem) {
        return { ok: false, error: problem, fieldErrors: { parentId: problem } };
      }
    }

    const existing = await prisma.issue.findUnique({
      where: { id: issueId },
      select: {
        id: true,
        key: true,
        type: true,
        status: true,
        priority: true,
        title: true,
        description: true,
        assigneeId: true,
        dueDate: true,
        parentId: true,
        environment: true,
        browser: true,
        operatingSystem: true,
        versionBuild: true,
        affectedModule: true,
        project: { select: { key: true } },
      },
    });
    if (!existing) throw new NotFoundError("This issue no longer exists.");

    const role = await workRoleOf(user);

    /*
     * Who work may be given to.
     *
     * Deciding who does a piece of work is an administrator's act. What is
     * left to everybody else is taking work *for themselves* — which is not
     * an assignment so much as picking something up — and putting down work
     * that is already theirs.
     *
     *   ADMIN      assigns anyone to anything.
     *   DEVELOPER  may set the assignee to themselves, whether the issue is
     *              unassigned or held by another developer, and may hand back
     *              work that is currently theirs. Nothing else.
     *   QA         raises work and verifies it; it does not decide who builds
     *              it, so it does not touch the assignee at all.
     *
     * This is deliberately narrower than the rule it replaces, which let any
     * member push unassigned work onto anybody — a developer could quietly
     * hand their queue to a colleague. Checked against `existing.assigneeId`
     * read from the database, so a forged payload cannot claim the issue was
     * already theirs.
     */
    if ("assigneeId" in input && input.assigneeId !== undefined) {
      const next = input.assigneeId;
      const changing = next !== existing.assigneeId;

      /* A pure tester does not decide who builds a thing, so they do not touch
         the assignee at all. Somebody who does development — a developer, or a
         full stack developer wearing that half of the job — takes work for
         themselves under the rule below. */
      if (changing && !doesDeveloperWork(role)) {
        throw new AuthorizationError(
          "Only an administrator can decide who a piece of work belongs to.",
        );
      }

      if (changing && role !== "ADMIN") {
        const takingItThemselves = next === user.id;
        const puttingDownTheirOwn =
          next === null && existing.assigneeId === user.id;

        if (!takingItThemselves && !puttingDownTheirOwn) {
          throw new AuthorizationError(
            "You can take work for yourself, but only an administrator can assign it to somebody else.",
          );
        }
      }
    }

    /*
     * Who may declare what.
     *
     * The workflow hands an issue between two people and the statuses are
     * where the hand-off happens, so each end owns the statuses that mean
     * something about its own half: a developer moves work through the build
     * and hands it over, a tester takes it, checks it and says what the
     * checking found. Neither writes work off — rejecting and cancelling are
     * an administrator's, who is unrestricted because they own the workflow
     * rather than a side of it.
     *
     * The lists themselves are in `domain.ts` and are keyed by the two halves
     * of the job rather than by role name, so somebody who does both gets both
     * — and so this check, the status menu, the board and the create form are
     * all reading the one table. `allowedStatusesFor` also carries the tester's
     * discipline: Done follows In QA, because it is what testing concluded.
     */
    if ("status" in input && input.status !== undefined) {
      const next = input.status;

      if (
        next !== existing.status &&
        !canSetStatus(role, existing.status, next)
      ) {
        throw new AuthorizationError(
          statusRefusalReason(role, existing.status, next),
        );
      }
    }

    /*
     * The three fields that describe and plan the work, rather than do it.
     *
     * Checked against what actually arrived and against what is already
     * stored, so re-saving a form without touching a field is never refused —
     * only a real change is. This is the whole of the enforcement: the issue
     * page renders these read-only for the same roles, and that is the
     * courtesy.
     */
    if (
      "title" in input &&
      input.title !== undefined &&
      input.title !== existing.title &&
      !canEditIssueName(role)
    ) {
      throw new AuthorizationError(
        "Renaming an issue is not a developer's — ask an administrator or the tester who raised it.",
      );
    }

    if (
      "priority" in input &&
      input.priority !== undefined &&
      input.priority !== existing.priority &&
      !canEditPriority(role)
    ) {
      throw new AuthorizationError(
        "How soon work is done is decided for you, not by you.",
      );
    }

    if ("dueDate" in input && input.dueDate !== undefined && !canEditDueDate(role)) {
      const before = existing.dueDate?.getTime() ?? null;
      const after = input.dueDate?.getTime() ?? null;
      if (before !== after) {
        throw new AuthorizationError(
          "Only an administrator can set when work is due.",
        );
      }
    }

    // Only fields actually present in the payload are considered.
    const tracked = [
      "title",
      "description",
      "status",
      "priority",
      "assigneeId",
      "dueDate",
      "parentId",
      "environment",
      "browser",
      "operatingSystem",
      "versionBuild",
      "affectedModule",
    ] as const;

    const data: Prisma.IssueUpdateInput = {};
    const changes: { field: string; oldValue: string | null; newValue: string | null }[] = [];

    for (const field of tracked) {
      if (!(field in input)) continue;

      const nextValue = input[field as keyof typeof input] as
        | string
        | Date
        | null
        | undefined;
      if (nextValue === undefined) continue;

      const prevValue = existing[field as keyof typeof existing] as
        | string
        | Date
        | null;

      const asText = (v: string | Date | null): string | null =>
        v === null ? null : v instanceof Date ? v.toISOString() : v;

      if (asText(prevValue) === asText(nextValue)) continue;

      (data as Record<string, unknown>)[field] = nextValue;
      changes.push({
        field,
        oldValue: asText(prevValue),
        newValue: asText(nextValue),
      });
    }

    if (changes.length === 0) {
      return { ok: true, data: { key: existing.key } };
    }

    const statusChange = changes.find((c) => c.field === "status");
    if (statusChange) {
      const nextStatus = statusChange.newValue as IssueStatus;

      /*
       * Any status the project has is accepted here.
       *
       * This used to refuse a move `STATUS_TRANSITIONS` did not describe. That
       * followed from the issue page offering only valid destinations -- with
       * the menu now offering every status, refusing the choice it just made
       * would leave a control that visibly does nothing. Authorization is
       * unchanged and still runs above: who may touch this issue is a security
       * question, which way the issue moves is a workflow one.
       *
       * `STATUS_TRANSITIONS` is still the description of the ordinary path,
       * and still shapes the board's drag and drop, where dragging a card into
       * a column it cannot reach has no other way to be explained.
       */

      data.completedAt =
        nextStatus === "DONE" || nextStatus === "CANCELLED" ? new Date() : null;
    }

    await prisma.$transaction(async (tx) => {
      await tx.issue.update({ where: { id: issueId }, data });

      await recordFieldChanges(tx, {
        issueId,
        actorId: user.id,
        changes,
      });

      /*
       * Assignment, and the tester case of it.
       *
       * `changes` only holds fields that actually moved, so re-saving an issue
       * without touching the assignee produces nothing here, and assigning
       * somebody to the person who already holds it is not a change at all --
       * neither can raise a second notification. `newValue` being null is an
       * unassignment: there is nobody to tell, so nothing is written. A
       * reassignment carries only the new holder, so the person who lost the
       * work is not notified they were given it.
       *
       * When that new holder is on the Testing team the wording says so; the
       * row, its type, its actor and where it opens are identical either way.
       */
      const assigneeChange = changes.find((c) => c.field === "assigneeId");
      if (assigneeChange?.newValue) {
        await addWatchers(tx, issueId, [assigneeChange.newValue]);
        await notify(tx, {
          issueId,
          actorId: user.id,
          userIds: [assigneeChange.newValue],
          type: "ISSUE_ASSIGNED",
          message: assignmentMessage({
            issueKey: existing.key,
            issueTitle: existing.title,
            typeLabel: ISSUE_TYPE_LABEL[existing.type].toLowerCase(),
            tester: await isTester(tx, assigneeChange.newValue),
          }),
        });
      }

      if (statusChange) {
        const nextStatus = statusChange.newValue as IssueStatus;

        await notify(tx, {
          issueId,
          actorId: user.id,
          userIds: await watcherIds(tx, issueId),
          type: "STATUS_CHANGED",
          message: `moved ${existing.key} to ${STATUS_LABEL[nextStatus] ?? nextStatus}`,
        });

        /*
         * Ready for QA is the one status that is a request rather than a
         * report: a developer has finished and is asking for the work to be
         * checked. The people who have to act on it are the project's testers,
         * and at this moment the issue is not assigned to any of them — often
         * it never is — so watching it is exactly what they have not done.
         * Hence a second notice, addressed to who can pick the work up rather
         * than to who was already following it.
         *
         * Whoever is both a watcher and a tester has the line above as well.
         * That row says the status moved; this one asks for something, and the
         * two are not the same sentence. The actor is filtered out of both, so
         * a tester moving an issue there themselves is not told about it.
         */
        if (nextStatus === "IN_REVIEW") {
          await notify(tx, {
            issueId,
            actorId: user.id,
            userIds: await projectTesterIds(tx, projectId),
            type: "STATUS_CHANGED",
            message: `marked ${existing.key} ready for QA — ${existing.title}`,
          });
        }
      }
    });

    revalidateIssueSurfaces(existing.project.key, existing.key);

    return { ok: true, data: { key: existing.key } };
  } catch (error) {
    return failure(error);
  }
}

/* ------------------------------------------------------- claim / takeover */

/**
 * Take a piece of work, and start it.
 *
 * One action for the two ways a developer picks something up: an unassigned
 * issue nobody has started, and one another developer is holding but is not
 * getting to. Both end in the same place — the issue is theirs and it is in
 * progress — and both are the same act, so they are one operation rather than
 * an assignment followed by a status change. Done as two calls there is a
 * window where an issue is assigned to somebody who has not started it, and a
 * second caller can land in the middle of it; done here the two fields move
 * together or not at all.
 *
 * The safety property is in the `updateMany` below: it carries the assignee
 * the caller read in its `where`, so two developers pressing Start on the same
 * unassigned issue cannot both succeed. The one that arrives second matches no
 * row, and is told the work has just been taken rather than silently
 * overwriting the first.
 *
 * A developer may only ever take work *for themselves*. There is no parameter
 * for who to give it to, which is what makes "assign it to a colleague"
 * unreachable through this path rather than merely refused by it.
 */
export async function claimIssue(
  raw: unknown,
): Promise<ActionResult<{ key: string; previousAssigneeId: string | null }>> {
  try {
    const user = await requireUser();

    const parsed = claimIssueSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: "That issue could not be identified." };
    }
    const { issueId } = parsed.data;

    await assertIssueAccess(user, issueId);

    /* Testers raise work and verify it; they do not take development on.
       Administrators may, because nothing is withheld from them. */
    const role = await workRoleOf(user);
    if (!doesDeveloperWork(role)) {
      throw new AuthorizationError(
        "Testers do not take development work; a developer picks this up.",
      );
    }

    const existing = await prisma.issue.findUnique({
      where: { id: issueId },
      select: {
        id: true,
        key: true,
        title: true,
        type: true,
        status: true,
        assigneeId: true,
        project: { select: { key: true } },
      },
    });
    if (!existing) throw new NotFoundError("This issue no longer exists.");

    const previousAssigneeId = existing.assigneeId;

    /* Already theirs and already running: nothing to do, and saying so is
       better than writing a second identical activity entry. */
    if (previousAssigneeId === user.id && existing.status === "IN_PROGRESS") {
      return {
        ok: true,
        data: { key: existing.key, previousAssigneeId },
      };
    }

    /* A closed issue is not picked up; it is reopened first, which is a
       tester's call. */
    if (isClosedStatus(existing.status)) {
      return {
        ok: false,
        error: "This work is closed. It has to be reopened before it can be picked up.",
      };
    }

    const taken = await prisma.$transaction(async (tx) => {
      /* The optimistic guard. `assigneeId` is the value this request was
         decided against, so a change since then means somebody else moved
         first and this update matches nothing. */
      const { count } = await tx.issue.updateMany({
        where: { id: issueId, assigneeId: previousAssigneeId },
        data: { assigneeId: user.id, status: "IN_PROGRESS" },
      });
      if (count === 0) return false;

      const changes: { field: string; oldValue: string | null; newValue: string | null }[] = [
        { field: "assigneeId", oldValue: previousAssigneeId, newValue: user.id },
      ];
      if (existing.status !== "IN_PROGRESS") {
        changes.push({
          field: "status",
          oldValue: existing.status,
          newValue: "IN_PROGRESS",
        });
      }

      /*
       * Taking work off somebody is a different event from being given it, so
       * it is recorded as one: same row shape, same fields, same filters —
       * only the action, and so the sentence the feed renders, differs.
       */
      const handover =
        previousAssigneeId !== null && previousAssigneeId !== user.id;

      await recordFieldChanges(tx, {
        issueId,
        actorId: user.id,
        changes,
        action: handover ? "issue.takeover" : undefined,
      });

      await addWatchers(tx, issueId, [user.id]);

      /* The developer who lost the work is told, because it left their queue
         without them doing anything. `notify` drops the actor, so nobody is
         told about their own act. */
      if (handover) {
        await notify(tx, {
          issueId,
          actorId: user.id,
          userIds: [previousAssigneeId],
          type: "ISSUE_ASSIGNED",
          message: `took over ${existing.key} — ${existing.title} — from you`,
        });
      }

      return true;
    });

    if (!taken) {
      return {
        ok: false,
        error: "Somebody else picked this up first. Reload to see who has it.",
      };
    }

    revalidateIssueSurfaces(existing.project.key, existing.key);
    revalidatePath("/my-work");

    return { ok: true, data: { key: existing.key, previousAssigneeId } };
  } catch (error) {
    return failure(error);
  }
}

/* --------------------------------------------------------------- delete */

/**
 * Delete an issue.
 *
 * Permitted for an administrator, or for the person who reported it — the same
 * "creator or admin" shape as project deletion and comment deletion, chosen
 * for the same reason: any project member can already *edit* an issue through
 * `updateIssue`, but destroying one outright is a step further than editing,
 * and is not something every member should be able to do to every other
 * member's report.
 *
 * Comments, mentions, activity, attachments, notifications, watchers and issue
 * links all cascade from the schema; a sub-issue's `parentId` is set to null
 * rather than deleted with it, so deleting a parent never silently destroys
 * its children. Attachment bytes are removed from storage after the database
 * row is gone, mirroring `deleteComment` — a stray file on disk is a cleanup
 * problem, a row pointing at a missing file is a broken page.
 */
export async function deleteIssue(
  issueId: string,
): Promise<ActionResult<{ key: string; projectKey: string }>> {
  try {
    const user = await requireUser();

    const existing = await prisma.issue.findUnique({
      where: { id: issueId },
      select: {
        id: true,
        key: true,
        reporterId: true,
        project: { select: { key: true } },
        attachments: { select: { id: true, storageKey: true } },
      },
    });
    if (!existing) throw new NotFoundError("This issue no longer exists.");

    await assertIssueAccess(user, issueId);

    if (existing.reporterId !== user.id && user.role !== "ADMIN") {
      throw new AuthorizationError(
        "Only an administrator or the person who reported this issue can delete it.",
      );
    }

    await prisma.issue.delete({ where: { id: existing.id } });

    if (existing.attachments.length > 0) {
      const { storage } = await import("@/server/storage");
      await Promise.allSettled(
        existing.attachments.map((a) => storage().remove(a.storageKey)),
      );
    }

    revalidateIssueSurfaces(existing.project.key, existing.key);

    return {
      ok: true,
      data: { key: existing.key, projectKey: existing.project.key },
    };
  } catch (error) {
    return failure(error);
  }
}

/* ---------------------------------------------------------------- clone */

/**
 * What the Clone dialog needs in order to open an editable draft.
 *
 * The draft lives entirely in the browser until it is saved, so it has to be
 * handed the source's editable content up front. Nothing here is written and
 * nothing is reserved — in particular no issue row and no key, which is the
 * point of §8: a clone has no ticket ID until somebody saves it.
 *
 * The two counts are what the options dialog reports back ("3 links, 2 files"),
 * so the person ticking the boxes can see what the boxes would carry.
 */
export interface IssueCloneDraft {
  sourceId: string;
  sourceKey: string;
  projectId: string;
  projectKey: string;
  projectName: string;
  type: IssueType;
  title: string;
  description: string | null;
  status: IssueStatus;
  priority: Priority;
  assigneeId: string | null;
  dueDate: string | null;
  labelIds: string[];
  parentKey: string | null;
  linkCount: number;
  attachmentCount: number;
}

export async function issueCloneDraft(
  issueId: string,
): Promise<ActionResult<IssueCloneDraft>> {
  try {
    const user = await requireUser();
    await assertIssueAccess(user, issueId);

    const source = await prisma.issue.findUnique({
      where: { id: issueId },
      select: {
        id: true,
        key: true,
        type: true,
        title: true,
        description: true,
        status: true,
        priority: true,
        assigneeId: true,
        dueDate: true,
        project: { select: { id: true, key: true, name: true } },
        parent: { select: { key: true } },
        labels: { select: { labelId: true } },
        _count: {
          select: {
            linksFrom: true,
            /* Files on the issue itself. A comment's files belong to the
               comment, and comments are not cloned. */
            attachments: { where: { commentId: null } },
          },
        },
      },
    });
    if (!source) throw new NotFoundError("This issue no longer exists.");

    return {
      ok: true,
      data: {
        sourceId: source.id,
        sourceKey: source.key,
        projectId: source.project.id,
        projectKey: source.project.key,
        projectName: source.project.name,
        type: source.type,
        /* The draft opens named for what it is. The person can rename it
           before saving — this is a starting point, not a decision. */
        title: `Clone of ${source.title}`.slice(0, 200),
        description: source.description,
        status: source.status,
        priority: source.priority,
        assigneeId: source.assigneeId,
        dueDate: source.dueDate
          ? source.dueDate.toISOString().slice(0, 10)
          : null,
        labelIds: source.labels.map((label) => label.labelId),
        parentKey: source.parent?.key ?? null,
        linkCount: source._count.linksFrom,
        attachmentCount: source._count.attachments,
      },
    };
  } catch (error) {
    return failure(error);
  }
}

export interface ClonedIssue extends CreatedIssue {
  copiedLinks: number;
  copiedAttachments: number;
}

/**
 * Save an edited clone.
 *
 * This is the *only* moment a cloned issue becomes real. Everything before it
 * — the options dialog, the editable draft, the title the person changed —
 * happened in the browser against no database row at all, which is what makes
 * §8 true by construction rather than by cleanup: there is no temporary issue
 * to expose a temporary key, and cancelling leaves nothing to remove.
 *
 * The creation itself goes through `createIssue`, so a clone is validated,
 * authorized, keyed, watched, notified and logged exactly like any other new
 * issue. There is no second create path and no second key generator; the key
 * is allocated by `nextIssueNumber` inside that call and not one moment
 * earlier.
 *
 * What this adds on top is the two copy choices:
 *
 *   - **links** — the source's own relationships, replayed through
 *     `createIssueLink`. That action already refuses a self-link, a duplicate
 *     and a target the caller cannot see, and it writes the matching inverse
 *     row; replaying through it means a copied link obeys the same rules as a
 *     hand-made one. A target that has since been deleted does not resolve,
 *     and is skipped rather than written as a dangling row.
 *   - **attachments** — the source's own files, copied *byte for byte* into
 *     new storage objects. Sharing a `storageKey` is impossible (it is unique)
 *     and would be wrong anyway: deleting the clone would take the original's
 *     file with it.
 *
 * With neither ticked the clone is a standalone issue carrying only its own
 * content, which is the default.
 */
export async function cloneIssue(
  raw: unknown,
): Promise<ActionResult<ClonedIssue>> {
  try {
    const user = await requireUser();

    const parsed = cloneIssueSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        error: "Please correct the highlighted fields.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }
    const { sourceIssueId, copyLinks, copyAttachments, ...draft } = parsed.data;

    // Reading the source is what grants the right to clone it.
    await assertIssueAccess(user, sourceIssueId);

    const source = await prisma.issue.findUnique({
      where: { id: sourceIssueId },
      select: {
        id: true,
        key: true,
        parentId: true,
        linksFrom: {
          select: { type: true, target: { select: { key: true } } },
        },
        attachments: {
          where: { commentId: null },
          orderBy: { createdAt: "asc" },
          select: {
            filename: true,
            storageKey: true,
            mimeType: true,
            width: true,
            height: true,
          },
        },
      },
    });
    if (!source) throw new NotFoundError("This issue no longer exists.");

    /*
     * The parent travels with the links and only with the links, and only if
     * it is still a legal parent where the clone is landing — a clone may be
     * filed into a different project from the one the source's parent lives
     * in, and `parentProblem` is what decides that rather than a guess here.
     */
    let parentId: string | null = null;
    if (copyLinks && source.parentId) {
      const problem = await parentProblem(
        source.parentId,
        draft.projectId,
        null,
      );
      if (problem === null) parentId = source.parentId;
    }

    const created = await createIssue({ ...draft, parentId });
    if (!created.ok) return created;

    let copiedLinks = 0;
    if (copyLinks) {
      for (const link of source.linksFrom) {
        const result = await createIssueLink({
          issueId: created.data.id,
          targetKey: link.target.key,
          type: link.type,
        });
        if (result.ok) copiedLinks += 1;
      }
    }

    const copiedAttachments = copyAttachments
      ? await duplicateAttachments(source.attachments, created.data.id, user.id)
      : 0;

    revalidateIssueSurfaces(created.data.projectKey, created.data.key);

    return {
      ok: true,
      data: { ...created.data, copiedLinks, copiedAttachments },
    };
  } catch (error) {
    return failure(error);
  }
}

/** One attachment as this module needs to read it in order to copy it. */
export interface CopyableAttachment {
  filename: string;
  storageKey: string;
  mimeType: string;
  width: number | null;
  height: number | null;
}

/**
 * Duplicates stored files onto another issue and returns how many made it.
 *
 * Bytes are re-streamed through the storage provider rather than the new row
 * being pointed at the same object: `storageKey` is unique, so two rows
 * *cannot* share one, and if they could, deleting either issue would destroy
 * the other's file. A source whose bytes have already gone is skipped — a row
 * pointing at a missing file is a broken attachment, and a clone should not
 * inherit one.
 */
async function duplicateAttachments(
  sources: CopyableAttachment[],
  issueId: string,
  uploadedById: string,
): Promise<number> {
  if (sources.length === 0) return 0;

  const { storage } = await import("@/server/storage");
  const provider = storage();
  let copied = 0;

  for (const source of sources) {
    try {
      if ((await provider.size(source.storageKey)) === null) continue;

      const extension = /\.[A-Za-z0-9]{1,8}$/.exec(source.filename)?.[0] ?? "";
      const stored = await provider.put(await provider.read(source.storageKey), {
        extension,
      });

      await prisma.attachment.create({
        data: {
          issueId,
          uploadedById,
          filename: source.filename,
          storageKey: stored.key,
          mimeType: source.mimeType,
          byteSize: stored.byteSize,
          width: source.width,
          height: source.height,
        },
      });
      copied += 1;
    } catch (error) {
      // One unreadable file must not cost the clone the rest of them.
      console.error("[prio] could not copy an attachment:", error);
    }
  }

  return copied;
}

/* ----------------------------------------------------------- report bug */

/**
 * A tester filing a problem against work they were verifying.
 *
 * This is not a second issue system — it is `createIssue`'s machinery reached
 * through a narrower door. The new row is an ordinary `Issue` of type BUG with
 * an ordinary key, watchers, activity entry and notification; what this adds
 * is that everything Prio already knows is filled in rather than asked for:
 *
 *   - the project, from the issue under test;
 *   - the assignee, from whoever owns that work, so the fix lands with them;
 *   - the reporter, from the caller;
 *   - a `RELATES_TO` link both ways, through the same `IssueLink` table the
 *     Related Issues panel uses — the inverse row is written here explicitly
 *     because `createIssueLink` is a separate action with its own session.
 *
 * The four fields the tester does fill in reuse existing columns, so this
 * needs no migration and keeps historical bugs shaped like new ones.
 */
export async function reportBug(
  raw: unknown,
): Promise<ActionResult<{ key: string; id: string }>> {
  try {
    const user = await requireUser();

    const parsed = reportBugSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        error: "Please correct the highlighted fields.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }
    const input = parsed.data;

    // Access to the issue under test is what grants the right to file against
    // it — checked before anything is read or written.
    await assertIssueAccess(user, input.issueId);

    const original = await prisma.issue.findUnique({
      where: { id: input.issueId },
      select: {
        id: true,
        key: true,
        title: true,
        projectId: true,
        assigneeId: true,
        project: { select: { key: true } },
      },
    });
    if (!original) throw new NotFoundError("This issue no longer exists.");

    const created = await prisma.$transaction(async (tx) => {
      const { number, key } = await nextIssueNumber(tx, original.projectId);

      const bug = await tx.issue.create({
        data: {
          key,
          number,
          projectId: original.projectId,
          type: "BUG",
          title: input.title,
          affectedModule: input.affectedModule,
          priority: input.priority,
          status: "TODO",
          reporterId: user.id,
          // Back to whoever owns the work being tested; unassigned if nobody
          // does, rather than guessing.
          assigneeId: original.assigneeId,
        },
        select: { id: true, key: true },
      });

      await recordIssueCreated(tx, {
        issueId: bug.id,
        actorId: user.id,
        isBug: true,
      });

      // Both directions, so the bug is visible from the feature and vice versa.
      await tx.issueLink.createMany({
        data: [
          {
            sourceId: bug.id,
            targetId: original.id,
            type: "RELATES_TO",
            createdById: user.id,
          },
          {
            sourceId: original.id,
            targetId: bug.id,
            type: "RELATES_TO",
            createdById: user.id,
          },
        ],
        skipDuplicates: true,
      });

      await addWatchers(tx, bug.id, [user.id, original.assigneeId]);

      await notify(tx, {
        issueId: bug.id,
        actorId: user.id,
        userIds: [original.assigneeId],
        type: "ISSUE_ASSIGNED",
        message: `reported ${bug.key} against your work on ${original.key}`,
      });

      return bug;
    });

    revalidateIssueSurfaces(original.project.key, created.key);
    revalidateIssueSurfaces(original.project.key, original.key);

    return { ok: true, data: { key: created.key, id: created.id } };
  } catch (error) {
    return failure(error);
  }
}

/* ---------------------------------------------------------- revalidation */

function revalidateIssueSurfaces(projectKey: string, issueKey: string): void {
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

/**
 * Issues matching a fragment typed after `#` in a comment.
 *
 * Deliberately a thin wrapper over `listIssues` rather than a query of its
 * own: that is where issue search already lives, and `buildIssueWhere` inside
 * it applies the caller's project scope. So this cannot surface an issue the
 * person could not already find on the Issues page, and an issue key matches
 * as a key here for the same reason it does there.
 */
export async function searchIssuesForReference(
  query: string,
): Promise<{ id: string; key: string; title: string; type: IssueType }[]> {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  const user = await requireUser();
  const result = await listIssues(user, {
    q: trimmed,
    sort: "updated",
    dir: "desc",
    pageSize: 6,
  });

  return result.rows.map((row) => ({
    id: row.id,
    key: row.key,
    title: row.title,
    type: row.type,
  }));
}
