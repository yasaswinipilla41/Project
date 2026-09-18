import { describe, expect, it } from "vitest";
import {
  planBacklogAllocation,
  type AllocationCandidate,
  type AllocationIssue,
} from "@/lib/backlogAllocation";

/**
 * Where work goes when it already belongs to somebody.
 *
 * The balancing rules are checked next door in `backlog-allocation.test.ts`.
 * These are about the cases where balance is the wrong question: work handed
 * to testing belongs to the tester it was handed to, and work that has come
 * back belongs to whoever built it. A queue length has nothing to say about
 * either, and an engine that dealt them out by queue length would be
 * undoing a hand-off every time it ran.
 */

const DEVELOPERS: AllocationCandidate[] = [
  { id: "dev-busy", name: "Busy", workload: 40 },
  { id: "dev-free", name: "Free", workload: 0 },
];

function issue(
  id: string,
  stage: AllocationIssue["stage"],
  preferred?: AllocationIssue["preferred"],
): AllocationIssue {
  return {
    id,
    key: `ENG-${id}`,
    title: id,
    priority: "MEDIUM",
    stage,
    preferred,
  };
}

describe("work that already belongs to somebody", () => {
  it("goes back to them, however long their queue is", () => {
    const plan = planBacklogAllocation(
      [
        issue("reopened", "REOPENED", {
          id: "dev-busy",
          name: "Busy",
          because: "Reopened. Busy built it, so it goes back to them.",
        }),
      ],
      DEVELOPERS,
    );

    /* Busy is forty issues deep and Free has none. The lightest queue is not
       the question: somebody else finishing this person's correction is not
       what "reopened" means. */
    expect(plan.allocations[0]!.assigneeId).toBe("dev-busy");
    expect(plan.allocations[0]!.reason).toMatch(/built it/i);
  });

  it("falls back to the lightest queue when nobody is named", () => {
    /* The previous developer left the project, went inactive, or moved to
       testing — the caller resolved nobody, so the ordinary rule applies
       rather than the work stalling. */
    const plan = planBacklogAllocation([issue("reopened", "REOPENED")], DEVELOPERS);

    expect(plan.allocations[0]!.assigneeId).toBe("dev-free");
    expect(plan.unplaced).toHaveLength(0);
  });
});

describe("work waiting for testing", () => {
  it("goes to the tester it belongs to", () => {
    const plan = planBacklogAllocation(
      [
        issue("ready", "READY_FOR_QA", {
          id: "qa-1",
          name: "Tess",
          because: "Waiting for testing. Tess raised it and tests on this project.",
        }),
      ],
      DEVELOPERS,
    );

    expect(plan.allocations[0]!.assigneeId).toBe("qa-1");
  });

  it("is never handed to a developer when no tester can take it", () => {
    /*
     * The claim that matters most here. The generic pool is a pool of people
     * who *build*; giving tested-out work to one of them would quietly undo
     * the hand-off the status records, and it would look like the engine
     * working. It is left where it is, and said out loud.
     */
    const plan = planBacklogAllocation([issue("ready", "READY_FOR_QA")], DEVELOPERS);

    expect(plan.allocations).toHaveLength(0);
    expect(plan.unplaced).toHaveLength(1);
    expect(plan.unplaced[0]!.reason).toMatch(/tester/i);
  });
});

describe("the order the stages are considered in", () => {
  it("places a hand-off, then a reopen, then new work, then the backlog", () => {
    const plan = planBacklogAllocation(
      [
        issue("d", "BACKLOG"),
        issue("c", "NEW"),
        issue("b", "REOPENED"),
        issue("a", "READY_FOR_QA", {
          id: "qa-1",
          name: "Tess",
          because: "Waiting for testing.",
        }),
      ],
      DEVELOPERS,
    );

    expect(plan.allocations.map((row) => row.stage)).toEqual([
      "READY_FOR_QA",
      "REOPENED",
      "NEW",
      "BACKLOG",
    ]);
  });

  it("still puts the most urgent work first within a stage", () => {
    /* Stage decides which pile is dealt first; priority still decides the
       order within it, which is the rule that was already here. */
    const plan = planBacklogAllocation(
      [
        { ...issue("low", "BACKLOG"), priority: "LOW", key: "ENG-1" },
        { ...issue("urgent", "BACKLOG"), priority: "URGENT", key: "ENG-2" },
      ],
      [{ id: "solo", name: "Solo", workload: 0 }],
    );

    expect(plan.allocations.map((row) => row.issueId)).toEqual([
      "urgent",
      "low",
    ]);
  });
});

describe("what it will not decide", () => {
  it("accounts for every issue it was given, placed or not", () => {
    /* Silence is the failure mode: an engine that returns three rows for five
       issues has said nothing about the other two. */
    const issues = [
      issue("a", "READY_FOR_QA"),
      issue("b", "REOPENED"),
      issue("c", "BACKLOG"),
    ];

    const plan = planBacklogAllocation(issues, []);
    expect(plan.allocations.length + plan.unplaced.length).toBe(issues.length);
    for (const row of plan.unplaced) expect(row.reason.length).toBeGreaterThan(0);
  });

  it("gives the same plan twice for the same input", () => {
    const input = () => [
      issue("a", "BACKLOG"),
      issue("b", "REOPENED"),
      issue("c", "NEW"),
    ];

    expect(planBacklogAllocation(input(), DEVELOPERS)).toEqual(
      planBacklogAllocation(input(), DEVELOPERS),
    );
  });
});
