import { describe, expect, it } from "vitest";
import type { IssueStatus } from "@prisma/client";
import {
  CLOSED_STATUSES,
  ISSUE_STATUSES,
  STATUS_LABEL,
  isClosedStatus,
} from "@/lib/domain";
import { countsAsCompleted, projectProgress } from "@/lib/projectProgress";
import {
  DISTRIBUTION_CATEGORIES,
  addDistribution,
  distributionCategoryFor,
  distributionOf,
  distributionSegments,
  distributionTotal,
  emptyDistribution,
} from "@/lib/statusDistribution";

/**
 * The four-way breakdown of a project's work.
 *
 * These are unit tests over pure functions — no database, no fixtures. What
 * they protect is the arithmetic a reader cannot check for themselves: that
 * every work item lands in exactly one group, that the legend adds to 100%
 * even when the exact shares do not divide, and that the bar's widths stay
 * exact while the legend's figures are rounded.
 */

describe("classifying a status", () => {
  /*
   * Every status Prio defines, named as the interface names it, with the
   * group it must land in. Spelled out one per case rather than looped over
   * in a single assertion so that a change to any one of them fails on its
   * own line and says which status moved.
   *
   * `REJECTED` appears twice on purpose: its label is "Reject / Not an Issue",
   * so the two things a reader would look for — "Reject" and "Not an issue" —
   * are one canonical status, and both must read as Other.
   */
  const MAPPING: ReadonlyArray<[string, IssueStatus, string]> = [
    ["Done", "DONE", "completed"],
    ["In Progress", "IN_PROGRESS", "inProgress"],
    ["In QA", "IN_QA", "inProgress"],
    ["New", "TODO", "notStarted"],
    ["Backlog", "BACKLOG", "notStarted"],
    ["Ready for QA", "IN_REVIEW", "other"],
    ["Reopen", "REOPENED", "other"],
    ["Reject", "REJECTED", "other"],
    ["Not an issue", "REJECTED", "other"],
    ["Cancelled", "CANCELLED", "other"],
  ];

  for (const [label, status, expected] of MAPPING) {
    it(`puts ${label} (${status}) in ${expected}`, () => {
      expect(distributionCategoryFor(status)).toBe(expected);
    });
  }

  /*
   * The classification is made from the canonical status identity, never from
   * the words shown on screen — so renaming a status in `STATUS_LABEL` must
   * not move any work between groups.
   */
  it("reads the status identity rather than its display label", () => {
    const before = ISSUE_STATUSES.map((status) => distributionCategoryFor(status));

    const renamed = { ...STATUS_LABEL, DONE: "Shipped", REJECTED: "Binned" };
    expect(renamed.DONE).not.toBe(STATUS_LABEL.DONE);

    const after = ISSUE_STATUSES.map((status) => distributionCategoryFor(status));
    expect(after).toEqual(before);
    expect(distributionCategoryFor("DONE")).toBe("completed");
  });

  /*
   * Precedence is Completed > In Progress > Not Started > Other, and the
   * reason it never has to arbitrate is that the groups do not overlap: each
   * status belongs to exactly one, so no work item can be claimed twice.
   *
   * That disjointness is the property worth pinning. A later edit that puts a
   * status in two groups would make the order of the checks load-bearing —
   * silently, and only for that status — and this is what fails first.
   */
  it("gives no status more than one group to belong to", () => {
    const grouped = new Map<string, string[]>();
    for (const status of ISSUE_STATUSES) {
      const category = distributionCategoryFor(status);
      grouped.set(category, [...(grouped.get(category) ?? []), status]);
    }

    const placed = [...grouped.values()].flat();
    expect(placed).toHaveLength(ISSUE_STATUSES.length);
    expect(new Set(placed).size).toBe(ISSUE_STATUSES.length);
  });

  /* Every recognised group beats Other, which is the only ranking the data
     actually exercises: Other is the absence of a classification, never a
     competing one. */
  it("prefers any recognised group to Other", () => {
    const recognised: IssueStatus[] = [
      "DONE",
      "IN_PROGRESS",
      "IN_QA",
      "TODO",
      "BACKLOG",
    ];
    for (const status of recognised) {
      expect(distributionCategoryFor(status)).not.toBe("other");
    }
  });

  it("puts a status it has never seen in other rather than dropping it", () => {
    expect(distributionCategoryFor("SOMETHING_NEW" as IssueStatus)).toBe("other");
  });

  it("puts missing and invalid metadata in other", () => {
    expect(distributionCategoryFor(null)).toBe("other");
    expect(distributionCategoryFor(undefined)).toBe("other");
    expect(distributionCategoryFor("" as IssueStatus)).toBe("other");
  });

  /* The guarantee the bar rests on: one group per work item, for every status
     the schema defines, with nothing unclassified. */
  it("gives every canonical status exactly one group", () => {
    for (const status of ISSUE_STATUSES) {
      const category = distributionCategoryFor(status);
      expect(DISTRIBUTION_CATEGORIES).toContain(category);
    }
  });
});

/**
 * The two readings of "finished", kept apart.
 *
 * Prio measures a project's progress by closed work — Done, Reject / Not an
 * Issue and Cancelled — because for "how much is left to do", abandoned work
 * is nothing left to do. This breakdown measures what the work actually did,
 * so only Done is Completed.
 *
 * Both are right, and they disagree by design. These cases exist so that a
 * later attempt to "fix" the disagreement fails here first, saying which of
 * the two it changed: the progress figure is long-standing behaviour that the
 * project directory, the summary page and Home all read, and the distribution
 * classifier must never be the reason it moves.
 */
describe("the distribution classifier and the progress calculation stay independent", () => {
  it("leaves every closed status closed, whatever the breakdown calls it", () => {
    expect([...CLOSED_STATUSES]).toEqual(["DONE", "REJECTED", "CANCELLED"]);

    for (const status of CLOSED_STATUSES) {
      expect(isClosedStatus(status), `${status} is closed`).toBe(true);
      expect(countsAsCompleted(status), `${status} counts as completed`).toBe(true);
    }
  });

  /* The exact point of divergence, stated as a fact rather than implied. */
  it("counts rejected and cancelled work as progress but not as Completed", () => {
    for (const status of ["REJECTED", "CANCELLED"] as const) {
      expect(countsAsCompleted(status)).toBe(true);
      expect(distributionCategoryFor(status)).toBe("other");
    }

    /* Done is the one status both agree on. */
    expect(countsAsCompleted("DONE")).toBe(true);
    expect(distributionCategoryFor("DONE")).toBe("completed");
  });

  it("agrees with the progress bar that open work is unfinished", () => {
    for (const status of ISSUE_STATUSES) {
      if (isClosedStatus(status)) continue;
      expect(countsAsCompleted(status), `${status}`).toBe(false);
      expect(
        distributionCategoryFor(status),
        `${status} must not be Completed`,
      ).not.toBe("completed");
    }
  });

  /*
   * The figure itself, for a project holding one of each kind of closed work.
   *
   * Four closed of ten is 40% progress, while only the single Done item is
   * Completed — 10% of the same project. Both numbers are asserted here, so
   * neither can be quietly moved to match the other.
   */
  it("reports the two figures the project actually has", () => {
    const rows = [
      { status: "DONE", count: 1 },
      { status: "REJECTED", count: 2 },
      { status: "CANCELLED", count: 1 },
      { status: "IN_PROGRESS", count: 2 },
      { status: "IN_QA", count: 1 },
      { status: "TODO", count: 2 },
      { status: "IN_REVIEW", count: 1 },
    ] as const;

    const total = rows.reduce((sum, row) => sum + row.count, 0);
    const closed = rows
      .filter((row) => countsAsCompleted(row.status))
      .reduce((sum, row) => sum + row.count, 0);

    const progress = projectProgress("p1", closed, total);
    const counts = distributionOf(rows);

    expect(total).toBe(10);
    expect(progress.percentage).toBe(40);
    expect(progress.completed).toBe(4);

    expect(counts.completed).toBe(1);
    expect(distributionSegments(counts)[0]!.percentage).toBe(10);

    /* Different questions, different answers, same project. */
    expect(progress.percentage).not.toBe(
      distributionSegments(counts)[0]!.percentage,
    );
    /* And the breakdown still accounts for every item. */
    expect(distributionTotal(counts)).toBe(total);
  });
});

describe("rolling counts up", () => {
  it("adds every status into its own group", () => {
    const counts = distributionOf([
      { status: "DONE", count: 12 },
      { status: "IN_PROGRESS", count: 5 },
      { status: "IN_QA", count: 3 },
      { status: "TODO", count: 4 },
      { status: "BACKLOG", count: 3 },
      { status: "REJECTED", count: 2 },
      { status: "CANCELLED", count: 1 },
    ]);

    expect(counts).toEqual({
      completed: 12,
      inProgress: 8,
      notStarted: 7,
      other: 3,
    });
    expect(distributionTotal(counts)).toBe(30);
  });

  /*
   * The dashboard groups by project, status *and* type, so one status arrives
   * as several rows. They have to add rather than replace one another, or a
   * project's bugs would erase its tasks.
   */
  it("adds repeated rows for the same status instead of replacing them", () => {
    const counts = distributionOf([
      { status: "IN_PROGRESS", count: 2 },
      { status: "IN_PROGRESS", count: 3 },
    ]);

    expect(counts.inProgress).toBe(5);
    expect(distributionTotal(counts)).toBe(5);
  });

  it("ignores empty and nonsense counts", () => {
    const counts = distributionOf([
      { status: "DONE", count: 0 },
      { status: "TODO", count: -4 },
      { status: "BACKLOG", count: Number.NaN },
      { status: "DONE", count: 2 },
    ]);

    expect(distributionTotal(counts)).toBe(2);
    expect(counts.completed).toBe(2);
  });

  /* A parent project and its children roll into one reading, each work item
     added once. */
  it("adds one hierarchy level into another", () => {
    const parent = distributionOf([
      { status: "DONE", count: 3 },
      { status: "TODO", count: 1 },
    ]);
    const child = distributionOf([
      { status: "DONE", count: 2 },
      { status: "IN_QA", count: 4 },
    ]);
    const nested = distributionOf([{ status: "CANCELLED", count: 1 }]);

    const rolled = addDistribution(addDistribution(parent, child), nested);

    expect(rolled).toEqual({
      completed: 5,
      inProgress: 4,
      notStarted: 1,
      other: 1,
    });
    expect(distributionTotal(rolled)).toBe(11);
    expect(distributionTotal(rolled)).toBe(
      distributionTotal(parent) + distributionTotal(child) + distributionTotal(nested),
    );
  });
});

describe("the segments a bar is drawn from", () => {
  it("always returns the four groups in their fixed order", () => {
    const segments = distributionSegments(emptyDistribution());
    expect(segments.map((s) => s.category)).toEqual([
      "completed",
      "inProgress",
      "notStarted",
      "other",
    ]);
  });

  it("never reorders by size", () => {
    const segments = distributionSegments({
      completed: 1,
      inProgress: 99,
      notStarted: 0,
      other: 0,
    });
    expect(segments.map((s) => s.category)).toEqual([
      "completed",
      "inProgress",
      "notStarted",
      "other",
    ]);
  });

  it("splits an even distribution into exact quarters", () => {
    const segments = distributionSegments({
      completed: 5,
      inProgress: 5,
      notStarted: 5,
      other: 5,
    });

    expect(segments.map((s) => s.percentage)).toEqual([25, 25, 25, 25]);
    expect(segments.map((s) => s.width)).toEqual([25, 25, 25, 25]);
  });

  /* The example from the specification: three equal thirds. The legend reads
     34/33/33 so it totals 100, while the bar stays exactly in thirds. */
  it("gives the spare point to the first group when thirds tie", () => {
    const segments = distributionSegments({
      completed: 1,
      inProgress: 1,
      notStarted: 1,
      other: 0,
    });

    expect(segments.map((s) => s.percentage)).toEqual([34, 33, 33, 0]);
    expect(segments.map((s) => s.percentage).reduce((a, b) => a + b)).toBe(100);

    expect(segments[0]!.width).toBeCloseTo(100 / 3, 10);
    expect(segments[1]!.width).toBeCloseTo(100 / 3, 10);
    expect(segments[2]!.width).toBeCloseTo(100 / 3, 10);
    expect(segments[3]!.width).toBe(0);
  });

  it("draws one third and two thirds at their exact widths", () => {
    const segments = distributionSegments({
      completed: 1,
      inProgress: 2,
      notStarted: 0,
      other: 0,
    });

    expect(segments[0]!.width).toBeCloseTo(100 / 3, 10);
    expect(segments[1]!.width).toBeCloseTo(200 / 3, 10);
    expect(segments[0]!.percentage + segments[1]!.percentage).toBe(100);
  });

  /* Flooring alone would total 99 here; the remainder has to be handed back. */
  it("corrects a legend that would otherwise read 99%", () => {
    const segments = distributionSegments({
      completed: 1,
      inProgress: 1,
      notStarted: 1,
      other: 3,
    });

    const total = segments.reduce((sum, s) => sum + s.percentage, 0);
    expect(total).toBe(100);
  });

  /* Rounding each share up on its own would total 101 here. */
  it("corrects a legend that would otherwise read 101%", () => {
    const segments = distributionSegments({
      completed: 5,
      inProgress: 5,
      notStarted: 5,
      other: 1,
    });

    const total = segments.reduce((sum, s) => sum + s.percentage, 0);
    expect(total).toBe(100);
  });

  /* Whatever the split, the legend adds to exactly 100. */
  it("totals 100% for every shape of uneven distribution", () => {
    const shapes = [
      { completed: 7, inProgress: 0, notStarted: 0, other: 0 },
      { completed: 1, inProgress: 1, notStarted: 1, other: 1 },
      { completed: 2, inProgress: 3, notStarted: 5, other: 7 },
      { completed: 1, inProgress: 0, notStarted: 0, other: 98 },
      { completed: 1, inProgress: 1, notStarted: 1, other: 594 },
      { completed: 11, inProgress: 13, notStarted: 17, other: 19 },
      { completed: 1, inProgress: 2, notStarted: 0, other: 0 },
    ];

    for (const shape of shapes) {
      const segments = distributionSegments(shape);
      const total = segments.reduce((sum, s) => sum + s.percentage, 0);
      expect(total, JSON.stringify(shape)).toBe(100);
    }
  });

  it("keeps exact widths totalling 100% whenever there is work", () => {
    const segments = distributionSegments({
      completed: 3,
      inProgress: 1,
      notStarted: 2,
      other: 1,
    });

    const width = segments.reduce((sum, s) => sum + s.width, 0);
    expect(width).toBeCloseTo(100, 10);
  });

  /* An empty group takes no width, no count and no rounding remainder. */
  it("leaves an empty group at zero", () => {
    const segments = distributionSegments({
      completed: 4,
      inProgress: 0,
      notStarted: 4,
      other: 0,
    });

    const inProgress = segments[1]!;
    const other = segments[3]!;

    expect(inProgress.count).toBe(0);
    expect(inProgress.percentage).toBe(0);
    expect(inProgress.width).toBe(0);
    expect(other.percentage).toBe(0);
    expect(other.width).toBe(0);
  });

  /* Nothing at all is not 100% of anything. */
  it("reads a project with no work as all zeroes", () => {
    const segments = distributionSegments(emptyDistribution());

    expect(distributionTotal(emptyDistribution())).toBe(0);
    for (const segment of segments) {
      expect(segment.count).toBe(0);
      expect(segment.percentage).toBe(0);
      expect(segment.width).toBe(0);
    }
  });

  it("carries the counts through untouched", () => {
    const segments = distributionSegments({
      completed: 12,
      inProgress: 8,
      notStarted: 7,
      other: 3,
    });

    expect(segments.map((s) => s.count)).toEqual([12, 8, 7, 3]);
    expect(segments.map((s) => s.percentage)).toEqual([40, 27, 23, 10]);
    expect(segments.map((s) => s.label)).toEqual([
      "Completed",
      "In Progress",
      "Not Started",
      "Other",
    ]);
  });
});
