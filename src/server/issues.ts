"use server";

import { revalidatePath } from "next/cache";
import type {
  IssueStatus,
  IssueType,
  Prisma,
  Priority,
  Severity,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { listIssues } from "@/server/queries/issues";
import {
  assertIssueAccess,
  assertProjectAccess,
  AuthorizationError,
  NotFoundError,
} from "@/lib/authz";
import { requireUser } from "@/lib/session";
import { ISSUE_TYPE_LABEL, isClosedStatus } from "@/lib/domain";
import {
  addWatchers,
  notify,
  recordFieldChanges,
  recordIssueCreated,
  watcherIds,
} from "@/server/activity";
import {
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
        where: { projectId: input.projectId, status: input.status },
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
          status: input.status,
          priority: input.priority,
          assigneeId: input.assigneeId,
          reporterId: user.id,
          dueDate: input.dueDate,
          parentId: input.parentId,
          sortIndex: (last?.sortIndex ?? 0) + 1000,
          completedAt: isClosedStatus(input.status) ? new Date() : null,

          /* Severity is a standard field on every type now, so it is stored
             as given rather than being thrown away for anything that is not a
             bug — which is what used to happen, and would have made the
             severity control on a task or story silently do nothing. */
          severity: input.severity,

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
          message: `assigned ${ISSUE_TYPE_LABEL[input.type].toLowerCase()} ${issue.key} to you`,
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
        severity: true,
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

    /*
     * Reassignment is an administrative act once the work already belongs to
     * somebody. Belonging to the project is enough to *work* on an issue —
     * comment on it, move it through the workflow — but not to take another
     * person's work off them or push work onto them.
     *
     * A member may still pick up unassigned work, and may hand back or pass on
     * work that is currently theirs. Admins are unrestricted, as before.
     *
     * Checked here against `existing.assigneeId` read from the database, so a
     * forged payload cannot claim the issue was already theirs.
     */
    if (
      "assigneeId" in input &&
      input.assigneeId !== undefined &&
      user.role !== "ADMIN" &&
      existing.assigneeId !== null &&
      existing.assigneeId !== user.id
    ) {
      throw new AuthorizationError(
        "Only an administrator can reassign work that belongs to someone else.",
      );
    }

    // Only fields actually present in the payload are considered.
    const tracked = [
      "title",
      "description",
      "status",
      "priority",
      "severity",
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

      const assigneeChange = changes.find((c) => c.field === "assigneeId");
      if (assigneeChange?.newValue) {
        await addWatchers(tx, issueId, [assigneeChange.newValue]);
        await notify(tx, {
          issueId,
          actorId: user.id,
          userIds: [assigneeChange.newValue],
          type: "ISSUE_ASSIGNED",
          message: `assigned ${existing.key} to you`,
        });
      }

      if (statusChange) {
        await notify(tx, {
          issueId,
          actorId: user.id,
          userIds: await watcherIds(tx, issueId),
          type: "STATUS_CHANGED",
          message: `moved ${existing.key} to ${statusChange.newValue}`,
        });
      }
    });

    revalidateIssueSurfaces(existing.project.key, existing.key);

    return { ok: true, data: { key: existing.key } };
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
  severity: Severity | null;
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
        severity: true,
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
        severity: source.severity,
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
          severity: input.severity,
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
