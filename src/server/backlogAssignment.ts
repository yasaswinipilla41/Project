"use server";

import { z } from "zod";
import { assertAdmin, assertProjectAccess } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { updateIssue, type ActionResult } from "@/server/issues";
import {
  allocationTotals,
  MAX_PER_RUN,
  planBacklogAllocation,
  type Allocation,
  type AllocationPlan,
  type BacklogPlan,
} from "@/lib/backlogAllocation";
import {
  assignableWorkFilter,
  loadAllocationInputs,
} from "@/server/queries/backlogAllocation";

/**
 * Dealing a project's backlog out across its developers.
 *
 * Two calls: one that says what it would do, and one that does it. Both are an
 * administrator's act, guarded before anything is read, so hiding the control
 * is presentation and `assertAdmin` is the rule.
 *
 * The important property is that **applying does not trust the preview**. A
 * plan is a list of issue ids paired with assignee ids, and accepting one back
 * from a browser would turn this into an assignment endpoint wearing a
 * preview's clothes — anybody could post their own pairs. So `apply` recomputes
 * the plan from the database and applies what it computes. Because the planner
 * is deterministic, the recomputed plan is the previewed one whenever nothing
 * has changed underneath, and where something has, the answer that gets written
 * is the one that was true at the moment of writing.
 *
 * Nothing new writes an assignment. Each allocation goes through `updateIssue`,
 * the single path an assignee changes by, which records the activity entry,
 * notifies the person, adds them as a watcher and revalidates every surface the
 * issue appears on. A second assignment path would have had to reproduce all of
 * that and would eventually have stopped agreeing.
 *
 * The manual Assign Work to Developer dialog is untouched. This is another way
 * to hand out work, not a replacement for choosing.
 */

const schema = z.object({ projectId: z.string().min(1) });

function failure(error: unknown): { ok: false; error: string } {
  const message =
    error instanceof Error ? error.message : "Something went wrong.";
  return { ok: false, error: message };
}

/** The plan, computed from the database and from nothing the caller sent. */
async function computePlan(projectId: string): Promise<AllocationPlan> {
  const { issues, candidates } = await loadAllocationInputs(
    projectId,
    MAX_PER_RUN,
  );
  return planBacklogAllocation(issues, candidates);
}

async function waitingCount(projectId: string): Promise<number> {
  return prisma.issue.count({
    where: { projectId, ...assignableWorkFilter() },
  });
}

/** What auto-assignment would do, written down before anybody agrees to it. */
export async function previewBacklogAllocation(
  raw: unknown,
): Promise<ActionResult<BacklogPlan>> {
  try {
    const user = await requireUser();
    assertAdmin(user);

    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: "Choose a project." };
    }
    await assertProjectAccess(user, parsed.data.projectId);

    const plan = await computePlan(parsed.data.projectId);

    return {
      ok: true,
      data: {
        allocations: plan.allocations,
        unplaced: plan.unplaced,
        totals: allocationTotals(plan.allocations),
        waiting: await waitingCount(parsed.data.projectId),
        perRun: MAX_PER_RUN,
        assigned: 0,
      },
    };
  } catch (error) {
    return failure(error);
  }
}

/** And doing it — recomputed here, never taken from the request. */
export async function applyBacklogAllocation(
  raw: unknown,
): Promise<ActionResult<BacklogPlan>> {
  try {
    const user = await requireUser();
    assertAdmin(user);

    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: "Choose a project." };
    }
    await assertProjectAccess(user, parsed.data.projectId);

    const plan = await computePlan(parsed.data.projectId);

    /*
     * One at a time, through the one assignment write in Prio. An issue that
     * is refused — somebody assigned it a moment ago, or it left the backlog —
     * does not take the rest of the run with it; it simply is not reported as
     * assigned.
     *
     * Each one is re-read immediately before it is written, and skipped when
     * it already holds the assignment this run would make. Two administrators
     * pressing Apply at the same moment plan against the same queues and
     * arrive at the same answer, so without this the second run would write
     * every assignment again and send every notice again. It reports them as
     * not assigned instead, which is what they were: it did not assign them.
     */
    const applied: Allocation[] = [];
    for (const allocation of plan.allocations) {
      const current = await prisma.issue.findUnique({
        where: { id: allocation.issueId },
        select: { assigneeId: true },
      });
      if (!current || current.assigneeId === allocation.assigneeId) continue;

      const result = await updateIssue({
        issueId: allocation.issueId,
        assigneeId: allocation.assigneeId,
      });
      if (result.ok) applied.push(allocation);
    }

    return {
      ok: true,
      data: {
        allocations: applied,
        unplaced: plan.unplaced,
        totals: allocationTotals(applied),
        waiting: await waitingCount(parsed.data.projectId),
        perRun: MAX_PER_RUN,
        assigned: applied.length,
      },
    };
  } catch (error) {
    return failure(error);
  }
}
