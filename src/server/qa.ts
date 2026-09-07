"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  assertIssueAccess,
  AuthorizationError,
  NotFoundError,
} from "@/lib/authz";
import { requireUser } from "@/lib/session";
import {
  TEST_RESULT_LABEL,
  needsDeveloperAttention,
} from "@/lib/domain";
import { recordFieldChanges } from "@/server/activity";
import { sendIssueMailInBackground } from "@/server/mailer";
import { fieldErrors, type FieldErrors } from "@/server/schemas";

/**
 * The QA verdict on an issue.
 *
 * This is deliberately *only* the verdict. The detail of what was tested and
 * what went wrong belongs in an ordinary comment, with screenshots and logs as
 * ordinary attachments — Prio already has both, and duplicating them into a
 * QA-shaped inbox would give the issue two conversations that could disagree.
 * What this adds is the one thing a comment cannot express: a current,
 * queryable state that "waiting for testing" and "failed" can be filtered on.
 *
 * The change is written through `recordFieldChanges`, the same append-only
 * trail every other field edit uses, so the *history* of verdicts is preserved
 * even though the column holds only the latest.
 *
 * Who may record one:
 *
 *   - an administrator, always;
 *   - anyone else with access to the issue — **except the person the work is
 *     assigned to**. Signing off your own work is the one thing QA exists to
 *     prevent, so it is refused on the server rather than merely hidden.
 */

export type QaResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: FieldErrors };

const recordTestResultSchema = z.object({
  issueId: z.string().min(1),
  result: z.enum(["NOT_TESTED", "PASSED", "FAILED", "BLOCKED"]),
});

export async function recordTestResult(
  raw: unknown,
): Promise<QaResult<{ key: string }>> {
  try {
    const user = await requireUser();

    const parsed = recordTestResultSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        error: "Please choose a valid test result.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }
    const { issueId, result } = parsed.data;

    await assertIssueAccess(user, issueId);

    const issue = await prisma.issue.findUnique({
      where: { id: issueId },
      select: {
        id: true,
        key: true,
        title: true,
        status: true,
        testResult: true,
        assigneeId: true,
        reporterId: true,
        project: { select: { key: true, name: true } },
      },
    });
    if (!issue) throw new NotFoundError("This issue no longer exists.");

    /*
     * Only the person who raised the issue records its verdict.
     *
     * `reporterId` is the creator: `createIssue` writes the caller's id into
     * it, and the schema has no other field for one. So "the creator decides
     * whether the fix is good" is expressible exactly, without inventing a
     * column.
     *
     * Deliberately not an administrator's to override. Recording a verdict is
     * a statement about whether the reported problem is actually fixed, and
     * the only person who can say that is the one who reported it —
     * administering Prio does not confer that knowledge. This replaces the
     * previous rule, which let anybody but the assignee record a result.
     */
    if (issue.reporterId !== user.id) {
      throw new AuthorizationError(
        "Only the person who raised this issue can record its test result.",
      );
    }

    // Nothing changed: don't write a duplicate activity entry for a re-click.
    if (issue.testResult === result) {
      return { ok: true, data: { key: issue.key } };
    }

    const now = new Date();
    const previous = issue.testResult;

    await prisma.$transaction(async (tx) => {
      await tx.issue.update({
        where: { id: issueId },
        data: {
          testResult: result,
          // Clearing the verdict clears who set it, rather than leaving a
          // stale name attached to "Not tested".
          testedById: result === "NOT_TESTED" ? null : user.id,
          testedAt: result === "NOT_TESTED" ? null : now,
        },
      });

      await recordFieldChanges(tx, {
        issueId,
        actorId: user.id,
        changes: [
          { field: "testResult", oldValue: previous, newValue: result },
        ],
      });

      /*
       * Who hears about it, and why:
       *
       *   - a verdict that needs a fix goes to the assignee and the reporter —
       *     the two people who act on it;
       *   - a pass goes to the assignee only, as good news they asked for;
       *   - clearing back to "not tested" is bookkeeping and notifies nobody.
       *
       * Watchers are deliberately not swept in: a QA verdict on somebody
       * else's issue is exactly the notification that trains people to ignore
       * the bell.
       */
      const audience = new Set<string>();
      if (result !== "NOT_TESTED" && issue.assigneeId) {
        audience.add(issue.assigneeId);
      }
      if (needsDeveloperAttention(result)) audience.add(issue.reporterId);
      audience.delete(user.id);

      if (audience.size > 0) {
        await tx.notification.createMany({
          data: [...audience].map((userId) => ({
            userId,
            type: "TEST_RESULT" as const,
            actorId: user.id,
            issueId,
            message: `marked ${issue.key} as ${TEST_RESULT_LABEL[result].toLowerCase()}`,
          })),
        });
      }
    });

    /*
     * Email mirrors the in-app audience, and only for a verdict that asks for
     * action. `sendIssueMailInBackground` already swallows its own failures,
     * so a dead SMTP host cannot fail a QA verdict that is already committed.
     */
    if (needsDeveloperAttention(result)) {
      const ids = [issue.assigneeId, issue.reporterId].filter(
        (id): id is string => Boolean(id) && id !== user.id,
      );
      if (ids.length > 0) {
        const recipients = await prisma.user.findMany({
          where: {
            id: { in: [...new Set(ids)] },
            isActive: true,
            emailNotificationsEnabled: true,
          },
          select: { email: true, name: true },
        });

        if (recipients.length > 0) {
          sendIssueMailInBackground(recipients, {
            issueKey: issue.key,
            issueTitle: issue.title,
            projectName: issue.project.name,
            actorName: user.name,
            event: `marked this ${TEST_RESULT_LABEL[result].toLowerCase()} in testing`,
          });
        }
      }
    }

    // Everything that can show a verdict or filter on one.
    revalidatePath("/");
    revalidatePath("/issues");
    revalidatePath("/bugs");
    revalidatePath("/my-work");
    revalidatePath(`/issues/${issue.key.toLowerCase()}`);
    revalidatePath(`/projects/${issue.project.key.toLowerCase()}`);
    revalidatePath(`/projects/${issue.project.key.toLowerCase()}/summary`);

    return { ok: true, data: { key: issue.key } };
  } catch (error) {
    if (error instanceof AuthorizationError || error instanceof NotFoundError) {
      return { ok: false, error: error.message };
    }
    console.error("[prio] recordTestResult failed:", error);
    return { ok: false, error: "Could not save that test result." };
  }
}
