import { describe, expect, it } from "vitest";
import type { Priority } from "@prisma/client";
import {
  allocationTotals,
  planBacklogAllocation,
  type Allocation,
  type AllocationCandidate,
  type AllocationIssue,
} from "@/lib/backlogAllocation";

/**
 * The backlog allocator, checked as arithmetic.
 *
 * No database and no session: the planner is a pure function, which is the
 * whole reason it can be pinned this exactly. "Assisted" assignment that cannot
 * be stated in a test is an opaque write, and these state it — including the
 * four workloads the brief asks about, where the answer is asserted rather than
 * described.
 */

function issues(count: number, priority: Priority = "MEDIUM"): AllocationIssue[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `issue-${index + 1}`,
    key: `ENG-${String(index + 1).padStart(3, "0")}`,
    title: `Issue ${index + 1}`,
    priority,
  }));
}

/** The four queues the brief names. */
const FOUR: AllocationCandidate[] = [
  { id: "a", name: "A", workload: 100 },
  { id: "b", name: "B", workload: 10 },
  { id: "c", name: "C", workload: 30 },
  { id: "d", name: "D", workload: 5 },
];

function distribution(plan: Allocation[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of plan) {
    counts[row.assigneeName] = (counts[row.assigneeName] ?? 0) + 1;
  }
  return counts;
}

describe("A = 100, B = 10, C = 30, D = 5", () => {
  it("gives the first five issues to D, and nobody else", () => {
    /* D starts five behind B, so the first five issues close that gap and none
       of them has any reason to go anywhere else. */
    const plan = planBacklogAllocation(issues(5), FOUR);

    expect(plan.map((row) => row.assigneeName)).toEqual([
      "D",
      "D",
      "D",
      "D",
      "D",
    ]);
    expect(plan.map((row) => row.workloadBefore)).toEqual([5, 6, 7, 8, 9]);
  });

  it("then alternates between D and B as they draw level", () => {
    /* The sixth issue is the first where somebody else is tied for lightest:
       D has reached 10 and B was already there. The tie goes to B by name, and
       from then on the two swap. This is the recalculation doing its job — a
       planner that sorted once would have put all eight on D. */
    const plan = planBacklogAllocation(issues(8), FOUR);

    expect(plan.map((row) => row.assigneeName)).toEqual([
      "D",
      "D",
      "D",
      "D",
      "D",
      "B",
      "D",
      "B",
    ]);
  });

  it("over twelve issues, splits them 8 to D and 4 to B — A and C get none", () => {
    const plan = planBacklogAllocation(issues(12), FOUR);

    expect(distribution(plan)).toEqual({ D: 8, B: 4 });

    /* A at 100 and C at 30 are so far ahead of the other two that twelve
       issues never reach them. That is the balancing working rather than
       failing: handing work to the busiest person to be seen to spread it
       around would make the queues less even, not more. */
    expect(plan.some((row) => row.assigneeName === "A")).toBe(false);
    expect(plan.some((row) => row.assigneeName === "C")).toBe(false);

    // D ends on 13, B on 14 — from 5 and 10.
    expect(allocationTotals(plan)).toEqual([
      { id: "d", name: "D", added: 8, workloadAfter: 13 },
      { id: "b", name: "B", added: 4, workloadAfter: 14 },
    ]);
  });

  it("reaches C only once D and B have caught up with it", () => {
    /* Fifty issues is enough to level D and B with C at 30 and then start
       feeding all three. A, a hundred deep, still gets nothing. */
    const plan = planBacklogAllocation(issues(50), FOUR);
    const counts = distribution(plan);

    expect(counts.C, "C is reached").toBeGreaterThan(0);
    expect(counts.A, "A is still far too busy").toBeUndefined();

    /* And the three that were used end up within one issue of each other,
       which is what "balanced" has to mean if it means anything. */
    const finals = allocationTotals(plan).map((row) => row.workloadAfter);
    expect(Math.max(...finals) - Math.min(...finals)).toBeLessThanOrEqual(1);
  });
});

describe("the two rules", () => {
  it("places the most urgent work first", () => {
    /* Keys deliberately out of order, so what decides the sequence is the
       priority and not the name. */
    const mixed: AllocationIssue[] = [
      { id: "low", key: "ENG-002", title: "Low", priority: "LOW" },
      { id: "urgent", key: "ENG-003", title: "Urgent", priority: "URGENT" },
      { id: "medium", key: "ENG-001", title: "Medium", priority: "MEDIUM" },
    ];

    const plan = planBacklogAllocation(mixed, [
      { id: "solo", name: "Solo", workload: 0 },
    ]);

    expect(plan.map((row) => row.issueKey)).toEqual([
      "ENG-003",
      "ENG-001",
      "ENG-002",
    ]);
  });

  it("recalculates after every allocation rather than sorting once", () => {
    /* Two empty queues and four issues. Sorting once and dealing would put all
       four on whoever sorted first; recalculating splits them evenly. */
    const plan = planBacklogAllocation(issues(4), [
      { id: "x", name: "X", workload: 0 },
      { id: "y", name: "Y", workload: 0 },
    ]);

    expect(distribution(plan)).toEqual({ X: 2, Y: 2 });
    expect(plan.map((row) => row.assigneeName)).toEqual(["X", "Y", "X", "Y"]);
  });

  it("gives the same plan for the same input, every time", () => {
    /* A preview is only a promise if applying it does the same thing. */
    const first = planBacklogAllocation(issues(20), FOUR);
    const second = planBacklogAllocation(issues(20), FOUR);
    expect(second).toEqual(first);
  });

  it("explains each choice in the row itself", () => {
    const [first] = planBacklogAllocation(issues(1, "URGENT"), FOUR);
    expect(first!.reason).toContain("Urgent");
    expect(first!.reason).toContain("D");
    expect(first!.reason).toContain("5");
  });
});

describe("nothing to do", () => {
  it("plans nothing when there is nobody to give work to", () => {
    expect(planBacklogAllocation(issues(5), [])).toEqual([]);
  });

  it("plans nothing when the backlog is empty", () => {
    expect(planBacklogAllocation([], FOUR)).toEqual([]);
  });
});
