"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
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
  createIssueSchema,
  fieldErrors,
  updateIssueSchema,
  type FieldErrors,
} from "@/server/schemas";

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

    // Only one level of nesting (§24): a sub-issue cannot itself have a parent.
    if (input.parentId) {
      const parent = await prisma.issue.findUnique({
        where: { id: input.parentId },
        select: { projectId: true, parentId: true },
      });
      if (!parent || parent.projectId !== input.projectId) {
        return {
          ok: false,
          error: "The parent issue is not in this project.",
          fieldErrors: { parentId: "Choose an issue from this project." },
        };
      }
      if (parent.parentId) {
        return {
          ok: false,
          error: "That issue is already a sub-issue.",
          fieldErrors: {
            parentId: "Prio supports one level of sub-issues.",
          },
        };
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
          description: input.description,
          status: input.status,
          priority: input.priority,
          assigneeId: input.assigneeId,
          reporterId: user.id,
          dueDate: input.dueDate,
          parentId: input.parentId,
          sortIndex: (last?.sortIndex ?? 0) + 1000,
          completedAt: isClosedStatus(input.status) ? new Date() : null,

          // Bug fields — null for tasks and stories.
          severity: input.type === "BUG" ? input.severity : null,
          stepsToReproduce: input.type === "BUG" ? input.stepsToReproduce : null,
          expectedResult: input.type === "BUG" ? input.expectedResult : null,
          actualResult: input.type === "BUG" ? input.actualResult : null,
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
        stepsToReproduce: true,
        expectedResult: true,
        actualResult: true,
        environment: true,
        browser: true,
        operatingSystem: true,
        versionBuild: true,
        affectedModule: true,
        project: { select: { key: true } },
      },
    });
    if (!existing) throw new NotFoundError("This issue no longer exists.");

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
      "stepsToReproduce",
      "expectedResult",
      "actualResult",
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
      const nextStatus = statusChange.newValue;
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

/* ---------------------------------------------------------- revalidation */

function revalidateIssueSurfaces(projectKey: string, issueKey: string): void {
  revalidatePath("/");
  revalidatePath("/issues");
  revalidatePath("/bugs");
  revalidatePath("/my-work");
  revalidatePath(`/issues/${issueKey.toLowerCase()}`);
  revalidatePath(`/projects/${projectKey.toLowerCase()}`);
  revalidatePath(`/projects/${projectKey.toLowerCase()}/board`);
}
