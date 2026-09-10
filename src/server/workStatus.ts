"use server";

import { z } from "zod";
import {
  assertAdmin,
  assertProjectAccess,
  workRoleOf,
} from "@/lib/authz";
import { STATUS_LABEL } from "@/lib/domain";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { updateIssue, type ActionResult } from "@/server/issues";
import {
  isWorkLane,
  laneAcceptsWorkRole,
  type WorkStatusIssue,
  type WorkStatusMember,
} from "@/lib/workLanes";
import {
  laneIssueFilter,
  listLaneIssues,
  listLaneMembers,
} from "@/server/queries/workStatus";

/**
 * Handing work out from Admin Home's Work Status card.
 *
 * Three calls, and the same sentence guards all of them: **this is an
 * administrator's act**. `assertAdmin` runs before anything is read or written,
 * so hiding the card is presentation and this is the rule. A developer or a
 * tester calling any of these directly — a copied request, a forged payload, a
 * console call — is refused here, where it counts.
 *
 * The assignment itself is not a new write. It re-checks what it was given and
 * then goes through `updateIssue`, which is the one place an assignee changes:
 * that is what records the activity entry, notifies the person who has just
 * been given the work, adds them as a watcher and revalidates Home along with
 * every other surface the issue appears on. A second assignment path would have
 * had to reproduce all of it and would eventually have stopped agreeing.
 */

const laneSchema = z.object({
  lane: z.string().min(1),
  projectId: z.string().min(1),
});

const assignSchema = z.object({
  lane: z.string().min(1),
  issueId: z.string().min(1),
  assigneeId: z.string().min(1),
});

function failure(error: unknown): { ok: false; error: string } {
  const message =
    error instanceof Error ? error.message : "Something went wrong.";
  return { ok: false, error: message };
}

/**
 * The eligible issues in one project, for one lane.
 *
 * Loaded when a project is chosen rather than with the page: Home would
 * otherwise carry every waiting issue in every project into the browser to
 * populate a dialog nobody has opened.
 */
export async function laneIssues(
  raw: unknown,
): Promise<ActionResult<WorkStatusIssue[]>> {
  try {
    const user = await requireUser();
    assertAdmin(user);

    const parsed = laneSchema.safeParse(raw);
    if (!parsed.success || !isWorkLane(parsed.data.lane)) {
      return { ok: false, error: "That work list could not be identified." };
    }

    await assertProjectAccess(user, parsed.data.projectId);

    return {
      ok: true,
      data: await listLaneIssues(parsed.data.lane, parsed.data.projectId),
    };
  } catch (error) {
    return failure(error);
  }
}

/** The people on that project who do the lane's half of the job. */
export async function laneMembers(
  raw: unknown,
): Promise<ActionResult<WorkStatusMember[]>> {
  try {
    const user = await requireUser();
    assertAdmin(user);

    const parsed = laneSchema.safeParse(raw);
    if (!parsed.success || !isWorkLane(parsed.data.lane)) {
      return { ok: false, error: "That work list could not be identified." };
    }

    await assertProjectAccess(user, parsed.data.projectId);

    return {
      ok: true,
      data: await listLaneMembers(parsed.data.lane, parsed.data.projectId),
    };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Give one waiting issue to one person.
 *
 * Everything the dialog narrowed is checked again against the database, because
 * a narrowed list is not what makes a write safe:
 *
 *  - the issue is still waiting for this lane — the same fragment the dialog's
 *    list was built from, so an issue somebody else has moved or handed out in
 *    the meantime is refused rather than quietly reassigned. That is the
 *    stale-selection case, and a dialog left open is exactly how it happens.
 *  - the person is on that project, is active, and does the lane's half of the
 *    job. A QA-only member is refused development work and a developer who does
 *    no testing is refused a Ready for QA issue, whatever the payload says.
 *
 * The status is deliberately left alone. Assignment and transition are separate
 * decisions in Prio and coupling them here would move work on somebody's behalf
 * — a Ready for QA issue stays Ready for QA until the tester picks it up. What
 * changes is who is holding it, and that is what takes it out of the lane.
 */
export async function assignWork(
  raw: unknown,
): Promise<ActionResult<{ key: string }>> {
  try {
    const user = await requireUser();
    assertAdmin(user);

    const parsed = assignSchema.safeParse(raw);
    if (!parsed.success || !isWorkLane(parsed.data.lane)) {
      return { ok: false, error: "Choose an issue and somebody to give it to." };
    }
    const { lane, issueId, assigneeId } = parsed.data;

    const issue = await prisma.issue.findUnique({
      where: { id: issueId },
      select: { id: true, key: true, status: true, projectId: true },
    });
    if (!issue) return { ok: false, error: "That issue no longer exists." };

    /* Still waiting? Asked with the fragment the dialog's own list was built
       from, so what may be handed out and what was offered are one rule. */
    const waiting = await prisma.issue.count({
      where: { id: issueId, ...laneIssueFilter(lane) },
    });
    if (waiting === 0) {
      return {
        ok: false,
        error: `${issue.key} is ${STATUS_LABEL[issue.status]} and is no longer waiting to be handed out.`,
      };
    }

    const person = await prisma.user.findFirst({
      where: {
        id: assigneeId,
        isActive: true,
        projectMemberships: { some: { projectId: issue.projectId } },
      },
      select: { id: true, name: true, role: true, email: true, image: true, jobTitle: true, isActive: true },
    });
    if (!person) {
      return { ok: false, error: "That person is not a member of this project." };
    }

    const workRole = await workRoleOf(person);
    if (!laneAcceptsWorkRole(lane, workRole)) {
      return {
        ok: false,
        error:
          lane === "QA"
            ? `${person.name} does not do QA work.`
            : `${person.name} does not do development work.`,
      };
    }

    /* The one assignment write in Prio. Notifications, watchers, the activity
       entry and the revalidation that refreshes this very card all come from
       here rather than being repeated. */
    return await updateIssue({ issueId, assigneeId });
  } catch (error) {
    return failure(error);
  }
}
