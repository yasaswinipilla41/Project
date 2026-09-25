import { describe, expect, it } from "vitest";
import { burndown } from "@/lib/burndown";

/**
 * The two lines a burndown draws.
 *
 * Pure arithmetic over recorded readings, which is the whole reason it can be
 * pinned this exactly. A burndown is an argument about whether a team will
 * finish; an argument that cannot be checked is decoration, and the failure
 * mode these tests exist to prevent is a chart that looks convincing and is
 * describing nothing.
 */

/* A fortnight in October 2026, the 12th being a Monday. */
const START = new Date(2026, 9, 12);
const END = new Date(2026, 9, 16);

function at(day: number, hour = 12): Date {
  return new Date(2026, 9, day, hour);
}

const ITEMS = [
  { issueId: "a", effortHours: 8, remainingHours: 8 },
  { issueId: "b", effortHours: 16, remainingHours: 16 },
  { issueId: "c", effortHours: 8, remainingHours: 8 },
];

describe("what the sprint committed to", () => {
  it("adds every estimate up", () => {
    const chart = burndown({
      startDate: START,
      endDate: END,
      items: ITEMS,
      history: [],
      now: at(12),
    });

    expect(chart.totalEffort).toBe(32);
    expect(chart.remaining).toBe(32);
  });

  it("counts work nobody estimated, rather than quietly dropping it", () => {
    /* An unestimated item is not zero effort — it is an unknown, and a total
       that pretends otherwise is how a sprint looks achievable. */
    const chart = burndown({
      startDate: START,
      endDate: END,
      items: [
        ...ITEMS,
        { issueId: "d", effortHours: null, remainingHours: null },
      ],
      history: [],
      now: at(12),
    });

    expect(chart.totalEffort).toBe(32);
    expect(chart.unestimated).toBe(1);
  });
});

describe("the ideal line", () => {
  it("runs from the whole estimate to nothing across the sprint's own days", () => {
    const chart = burndown({
      startDate: START,
      endDate: END,
      items: ITEMS,
      history: [],
      now: at(12),
    });

    /* Five days, 12th to 16th inclusive: 32 down to 0 in four equal steps. */
    expect(chart.points.map((p) => p.ideal)).toEqual([32, 24, 16, 8, 0]);
  });

  it("is drawn from the sprint's dates, not from a fixed length", () => {
    const chart = burndown({
      startDate: START,
      endDate: new Date(2026, 9, 14),
      items: ITEMS,
      history: [],
      now: at(12),
    });

    expect(chart.points.map((p) => p.ideal)).toEqual([32, 16, 0]);
  });
});

describe("the actual line", () => {
  it("follows the readings people actually recorded", () => {
    const chart = burndown({
      startDate: START,
      endDate: END,
      items: ITEMS,
      history: [
        { at: at(13), issueId: "a", remainingHours: 4 },
        { at: at(14), issueId: "a", remainingHours: 0 },
        { at: at(14), issueId: "b", remainingHours: 10 },
      ],
      now: at(16),
    });

    expect(chart.points.map((p) => p.actual)).toEqual([
      32, // nothing recorded yet
      28, // a: 8 → 4
      18, // a: → 0, b: 16 → 10
      18,
      18,
    ]);
  });

  it("takes the last reading of a day, not the first", () => {
    const chart = burndown({
      startDate: START,
      endDate: END,
      items: ITEMS,
      history: [
        { at: at(13, 9), issueId: "a", remainingHours: 6 },
        { at: at(13, 17), issueId: "a", remainingHours: 2 },
      ],
      now: at(16),
    });

    expect(chart.points[1]!.actual).toBe(26);
  });

  it("leaves the future blank rather than drawing it flat", () => {
    /*
     * The failure this prevents: carrying today's figure forward to the end of
     * the sprint draws a line that looks like a team that has stopped working,
     * and drawing zero looks like one that has finished. Neither has happened
     * yet, so neither is drawn.
     */
    const chart = burndown({
      startDate: START,
      endDate: END,
      items: ITEMS,
      history: [{ at: at(13), issueId: "a", remainingHours: 0 }],
      now: at(13),
    });

    expect(chart.points.map((p) => p.actual)).toEqual([
      32,
      24,
      null,
      null,
      null,
    ]);
  });

  it("counts an item with no reading as all of its estimate still to do", () => {
    const chart = burndown({
      startDate: START,
      endDate: END,
      items: ITEMS,
      history: [],
      now: at(16),
    });

    expect(chart.points.every((p) => p.actual === 32)).toBe(true);
  });

  it("does not invent a line for a sprint with no estimates at all", () => {
    const chart = burndown({
      startDate: START,
      endDate: END,
      items: [{ issueId: "a", effortHours: null, remainingHours: null }],
      history: [],
      now: at(16),
    });

    expect(chart.totalEffort).toBe(0);
    expect(chart.points.every((p) => p.actual === 0)).toBe(true);
    expect(chart.points.every((p) => p.ideal === 0)).toBe(true);
  });
});

describe("the same input twice", () => {
  it("gives the same chart", () => {
    const input = {
      startDate: START,
      endDate: END,
      items: ITEMS,
      history: [{ at: at(13), issueId: "b", remainingHours: 12 }],
      now: at(15),
    };

    expect(burndown(input)).toEqual(burndown(input));
  });

  it("does not depend on the order history arrives in", () => {
    const history = [
      { at: at(14), issueId: "a", remainingHours: 0 },
      { at: at(13), issueId: "a", remainingHours: 4 },
    ];

    const forwards = burndown({
      startDate: START,
      endDate: END,
      items: ITEMS,
      history,
      now: at(16),
    });
    const backwards = burndown({
      startDate: START,
      endDate: END,
      items: ITEMS,
      history: [...history].reverse(),
      now: at(16),
    });

    expect(backwards).toEqual(forwards);
  });
});

/**
 * What a status means for the line.
 *
 * Finishing an issue in Prio does not touch its remaining hours — nothing
 * asks anybody to write "0h left" on work they have just marked Done — so a
 * burndown read from remainders alone ran flat across a sprint that was being
 * finished, which is the one thing a burndown exists to show. Closed work has
 * nothing left to burn, and reopened work has its estimate to burn again.
 */
describe("what a status means for what is left", () => {
  /** The same item, referred to by every test below. */
  const ONE = [{ issueId: "a", effortHours: 10, remainingHours: 10 }];

  it("drops a finished item's effort out of what is left", () => {
    const chart = burndown({
      startDate: START,
      endDate: END,
      items: [{ ...ONE[0]!, status: "DONE" }],
      history: [],
      now: at(16),
    });

    /* The commitment does not change — it was still ten hours of work — but
       none of it is outstanding. */
    expect(chart.totalEffort).toBe(10);
    expect(chart.remaining).toBe(0);
  });

  it("counts Reject / Not an Issue and Cancelled as nothing left, the same as Done", () => {
    for (const status of ["REJECTED", "CANCELLED"] as const) {
      const chart = burndown({
        startDate: START,
        endDate: END,
        items: [{ ...ONE[0]!, status }],
        history: [],
        now: at(16),
      });

      expect(chart.remaining, status).toBe(0);
    }
  });

  it("falls on the day the work was finished, not across the whole sprint", () => {
    /* Marked Done on the 14th, and the trail says so. Before that the ten
       hours were outstanding; after it they are not. */
    const chart = burndown({
      startDate: START,
      endDate: END,
      items: [{ ...ONE[0]!, status: "DONE" }],
      history: [],
      statusHistory: [
        { at: at(14, 9), issueId: "a", from: "IN_PROGRESS", to: "DONE" },
      ],
      now: at(16),
    });

    expect(chart.points.map((point) => point.actual)).toEqual([
      10, 10, 0, 0, 0,
    ]);
  });

  it("gives a reopened item its work back", () => {
    /*
     * Finished on the 13th and reopened on the 15th. The nought it was
     * closed on says nothing about it once it is open again, so its estimate
     * is outstanding once more — that is what "Reopen counts as remaining
     * work again" has to mean, or a reopened sprint reads as finished.
     */
    const chart = burndown({
      startDate: START,
      endDate: END,
      items: [
        {
          issueId: "a",
          effortHours: 10,
          remainingHours: 0,
          status: "REOPENED",
        },
      ],
      history: [{ at: at(13, 10), issueId: "a", remainingHours: 0 }],
      statusHistory: [
        { at: at(13, 9), issueId: "a", from: "IN_PROGRESS", to: "DONE" },
        { at: at(15, 9), issueId: "a", from: "DONE", to: "REOPENED" },
      ],
      now: at(16),
    });

    expect(chart.points.map((point) => point.actual)).toEqual([
      10, 0, 0, 10, 10,
    ]);
    expect(chart.remaining).toBe(10);
  });

  it("keeps a remainder recorded after the work was reopened", () => {
    /* Somebody said four hours were left *after* reopening it, which is
       better information than the estimate. */
    const chart = burndown({
      startDate: START,
      endDate: END,
      items: [
        {
          issueId: "a",
          effortHours: 10,
          remainingHours: 4,
          status: "REOPENED",
        },
      ],
      history: [
        { at: at(13, 10), issueId: "a", remainingHours: 0 },
        { at: at(15, 10), issueId: "a", remainingHours: 4 },
      ],
      statusHistory: [
        { at: at(13, 9), issueId: "a", from: "IN_PROGRESS", to: "DONE" },
        { at: at(15, 9), issueId: "a", from: "DONE", to: "REOPENED" },
      ],
      now: at(16),
    });

    expect(chart.remaining).toBe(4);
    expect(chart.points.at(-1)!.actual).toBe(4);
  });

  it("burns a sprint down as its items are finished one by one", () => {
    /* The shape the chart is for: 40 hours committed, finished in three
       bites, ending at nothing. */
    const chart = burndown({
      startDate: START,
      endDate: END,
      items: [
        { issueId: "a", effortHours: 16, remainingHours: 16, status: "DONE" },
        { issueId: "b", effortHours: 16, remainingHours: 16, status: "DONE" },
        { issueId: "c", effortHours: 8, remainingHours: 8, status: "DONE" },
      ],
      history: [],
      statusHistory: [
        { at: at(13, 9), issueId: "a", from: "IN_PROGRESS", to: "DONE" },
        { at: at(15, 9), issueId: "b", from: "IN_PROGRESS", to: "DONE" },
        { at: at(16, 9), issueId: "c", from: "IN_PROGRESS", to: "DONE" },
      ],
      now: at(16, 18),
    });

    expect(chart.totalEffort).toBe(40);
    expect(chart.points.map((point) => point.actual)).toEqual([
      40, 24, 24, 8, 0,
    ]);
    /* And the ideal line is the straight run from the commitment to nothing
       across the sprint's own days, which is what the actual is read
       against. */
    expect(chart.points.map((point) => point.ideal)).toEqual([
      40, 30, 20, 10, 0,
    ]);
    expect(chart.remaining).toBe(0);
  });

  it("still reads remainders for work that was never closed", () => {
    /* The behaviour that was already there, unchanged: an open item follows
       what people recorded about it. */
    const chart = burndown({
      startDate: START,
      endDate: END,
      items: [
        {
          issueId: "a",
          effortHours: 10,
          remainingHours: 6,
          status: "IN_PROGRESS",
        },
      ],
      history: [{ at: at(13, 10), issueId: "a", remainingHours: 6 }],
      statusHistory: [
        { at: at(13, 9), issueId: "a", from: "TODO", to: "IN_PROGRESS" },
      ],
      now: at(16),
    });

    expect(chart.remaining).toBe(6);
    expect(chart.points.map((point) => point.actual)).toEqual([10, 6, 6, 6, 6]);
  });
});

/**
 * What a day is made of, and why it moved.
 *
 * The line answers "how much is left" and nothing else. These are the
 * answers a reader actually wants next — which issues that remainder is, how
 * many there are, and what changed to move it — and they are read from the
 * same per-item rule as the line, so a day's detail and its point cannot
 * disagree. That last property is the one worth protecting: the reasons
 * listed for a day are each measured as what an item owed a moment before
 * against a moment after, so they add up to the step the line took.
 */
describe("what a day is made of", () => {
  const ITEM = {
    issueId: "a",
    key: "ENG-1",
    title: "Sixteen hours of it",
    effortHours: 16,
    remainingHours: 16,
  };

  it("counts the sprint's effort and issues, finished and left", () => {
    const chart = burndown({
      startDate: START,
      endDate: END,
      items: [
        { ...ITEM, status: "DONE" },
        {
          issueId: "b",
          key: "ENG-2",
          title: "Open",
          effortHours: 8,
          remainingHours: 8,
          status: "IN_PROGRESS",
        },
        {
          issueId: "c",
          key: "ENG-3",
          title: "Rejected",
          effortHours: 4,
          remainingHours: 4,
          status: "REJECTED",
        },
      ],
      history: [],
      now: at(16),
    });

    /* 28 committed, 12 of it finished with (16 done + 4 rejected), 8 left —
       and the issue counts by the same division. */
    expect(chart).toMatchObject({
      totalEffort: 28,
      completedEffort: 20,
      remaining: 8,
      totalIssues: 3,
      completedIssues: 2,
      remainingIssues: 1,
    });
  });

  it("says which issues make up a day's remainder, heaviest first", () => {
    /* And who holds each of them: what is left is a question about people as
       much as hours, so the row a reader sees names both. An issue nobody
       holds says so rather than being left out. */
    const chart = burndown({
      startDate: START,
      endDate: END,
      items: [
        {
          issueId: "a",
          key: "ENG-1",
          title: "Small",
          effortHours: 4,
          remainingHours: 4,
          status: "TODO",
          assignee: "Kiran Das",
        },
        {
          issueId: "b",
          key: "ENG-2",
          title: "Large",
          effortHours: 12,
          remainingHours: 12,
          status: "REOPENED",
        },
      ],
      history: [],
      now: at(16),
    });

    const day = chart.points[0]!;
    expect(day.remainingIssues).toEqual([
      {
        issueId: "b",
        key: "ENG-2",
        title: "Large",
        status: "REOPENED",
        assignee: null,
        effortHours: 12,
      },
      {
        issueId: "a",
        key: "ENG-1",
        title: "Small",
        status: "TODO",
        assignee: "Kiran Das",
        effortHours: 4,
      },
    ]);
    expect(day.remainingCount).toBe(2);
    expect(day.completedCount).toBe(0);
  });

  it("explains the day work was finished", () => {
    const chart = burndown({
      startDate: START,
      endDate: END,
      items: [{ ...ITEM, status: "DONE" }],
      history: [],
      statusHistory: [
        { at: at(14, 9), issueId: "a", from: "IN_PROGRESS", to: "DONE" },
      ],
      now: at(16),
    });

    expect(chart.points[1]!.changes).toEqual([]);
    expect(chart.points[2]!.changes).toMatchObject([
      { key: "ENG-1", reason: "completed", delta: -16 },
    ]);
    /* And the figure it explains: the same step the line took that day. */
    expect(chart.points[1]!.actual).toBe(16);
    expect(chart.points[2]!.actual).toBe(0);
  });

  it("explains a reopening as work coming back", () => {
    const chart = burndown({
      startDate: START,
      endDate: END,
      items: [{ ...ITEM, status: "REOPENED" }],
      history: [],
      statusHistory: [
        { at: at(13, 9), issueId: "a", from: "IN_PROGRESS", to: "DONE" },
        { at: at(15, 9), issueId: "a", from: "DONE", to: "REOPENED" },
      ],
      now: at(16),
    });

    expect(chart.points[1]!.changes).toMatchObject([
      { reason: "completed", delta: -16 },
    ]);
    expect(chart.points[3]!.changes).toMatchObject([
      { reason: "reopened", delta: 16 },
    ]);
  });

  it("explains work added to the sprint, and does not count it before", () => {
    const chart = burndown({
      startDate: START,
      endDate: END,
      items: [{ ...ITEM, status: "TODO", member: true }],
      history: [],
      membershipHistory: [{ at: at(14, 9), issueId: "a", joined: true }],
      now: at(16),
    });

    /* Before it was put in, the sprint was not carrying it. */
    expect(chart.points[0]!.actual).toBe(0);
    expect(chart.points[0]!.remainingIssues).toEqual([]);
    expect(chart.points[2]!.actual).toBe(16);
    expect(chart.points[2]!.changes).toMatchObject([
      { reason: "added", delta: 16 },
    ]);
  });

  it("explains work moved out, and stops counting it after", () => {
    const chart = burndown({
      startDate: START,
      endDate: END,
      /* No longer a member: it left mid-sprint, and the history is what says
         when. */
      items: [{ ...ITEM, status: "TODO", member: false }],
      history: [],
      membershipHistory: [{ at: at(15, 9), issueId: "a", joined: false }],
      now: at(16),
    });

    expect(chart.points[0]!.actual).toBe(16);
    expect(chart.points[3]!.changes).toMatchObject([
      { reason: "removed", delta: -16 },
    ]);
    expect(chart.points[4]!.actual).toBe(0);
    /* And it is not one of the sprint's issues now. */
    expect(chart.totalIssues).toBe(0);
  });

  it("explains a re-estimate with what it moved from", () => {
    const chart = burndown({
      startDate: START,
      endDate: END,
      items: [
        { ...ITEM, effortHours: 20, remainingHours: null, status: "TODO" },
      ],
      history: [],
      estimateHistory: [{ at: at(15, 9), issueId: "a", from: 16, to: 20 }],
      now: at(16),
    });

    /* The sprint was told 16 hours, then 20: each day carries the figure it
       was actually holding, and the change says both. */
    expect(chart.points[0]!.actual).toBe(16);
    expect(chart.points[4]!.actual).toBe(20);
    expect(chart.points[3]!.changes).toMatchObject([
      { reason: "estimate", delta: 4, from: 16, to: 20 },
    ]);
  });

  it("lists reasons that add up to the step the line took", () => {
    /* Two things happened on one day, in opposite directions. */
    const chart = burndown({
      startDate: START,
      endDate: END,
      items: [
        {
          issueId: "a",
          key: "ENG-1",
          title: "Finished",
          effortHours: 10,
          remainingHours: 10,
          status: "DONE",
        },
        {
          issueId: "b",
          key: "ENG-2",
          title: "Reopened",
          effortHours: 6,
          remainingHours: 6,
          status: "REOPENED",
        },
      ],
      history: [],
      statusHistory: [
        { at: at(13, 9), issueId: "b", from: "IN_PROGRESS", to: "DONE" },
        { at: at(15, 9), issueId: "a", from: "IN_PROGRESS", to: "DONE" },
        { at: at(15, 11), issueId: "b", from: "DONE", to: "REOPENED" },
      ],
      now: at(16),
    });

    const before = chart.points[2]!.actual!;
    const day = chart.points[3]!;
    const moved = day.changes.reduce((sum, change) => sum + change.delta, 0);
    expect(day.changes).toHaveLength(2);
    expect(day.actual).toBe(before + moved);
  });

  it("marks today only when the sprint covers it", () => {
    const inside = burndown({
      startDate: START,
      endDate: END,
      items: [ITEM],
      history: [],
      active: true,
      now: at(14, 18),
    });
    expect(inside).toMatchObject({ todayIndex: 2, active: true });

    const outside = burndown({
      startDate: START,
      endDate: END,
      items: [ITEM],
      history: [],
      now: new Date(2026, 10, 3),
    });
    expect(outside).toMatchObject({ todayIndex: null, active: false });
  });

  it("says nothing about a day the sprint has not reached", () => {
    const chart = burndown({
      startDate: START,
      endDate: END,
      items: [ITEM],
      history: [],
      now: at(13),
    });

    const future = chart.points[4]!;
    expect(future.actual).toBeNull();
    expect(future.remainingIssues).toEqual([]);
    expect(future.changes).toEqual([]);
  });
});

/**
 * What today did, and what the sprint has become.
 *
 * The line answers "how much is left". These are the answers to the other
 * half of the question a burndown is read for — "what changed, and why" — and
 * every one of them is a difference between figures the chart already draws,
 * so a day's account of itself cannot disagree with the step its line took.
 *
 * The identity worth protecting is that decomposition: what the line did is
 * exactly what the scope did, less what was finished.
 *
 *     change = scopeToday − completedToday
 */
describe("what each day did", () => {
  const HELD = [
    {
      issueId: "a",
      key: "ENG-1",
      title: "Eight hours",
      effortHours: 8,
      remainingHours: 8,
    },
    {
      issueId: "b",
      key: "ENG-2",
      title: "Four hours",
      effortHours: 4,
      remainingHours: 4,
    },
  ];

  it("says nothing about the first day, which has no day before it", () => {
    const chart = burndown({
      startDate: START,
      endDate: END,
      items: HELD,
      history: [],
      now: at(16),
    });

    expect(chart.points[0]!.change).toBeNull();
    expect(chart.points[0]!.completedToday).toBe(0);
    expect(chart.points[0]!.scopeToday).toBe(0);
  });

  it("reports the effort burned since the day before", () => {
    const chart = burndown({
      startDate: START,
      endDate: END,
      items: [{ ...HELD[0]!, status: "DONE" }, HELD[1]!],
      history: [],
      statusHistory: [
        { at: at(14, 9), issueId: "a", from: "IN_PROGRESS", to: "DONE" },
      ],
      now: at(16),
    });

    const day = chart.points[2]!;
    expect(day.change, "the line fell by the eight hours finished").toBe(-8);
    expect(day.completedToday).toBe(8);
    expect(day.scopeToday).toBe(0);
    expect(day.tally.completed).toBe(1);
  });

  it("says a flat day is flat", () => {
    /* Nothing happened on the day after the finish: no change, nothing
       completed, and the reader is owed that answer as plainly as any
       other. */
    const chart = burndown({
      startDate: START,
      endDate: END,
      items: [{ ...HELD[0]!, status: "DONE" }, HELD[1]!],
      history: [],
      statusHistory: [
        { at: at(14, 9), issueId: "a", from: "IN_PROGRESS", to: "DONE" },
      ],
      now: at(16),
    });

    const quiet = chart.points[3]!;
    expect(quiet.change).toBe(0);
    expect(quiet.completedToday).toBe(0);
    expect(quiet.scopeToday).toBe(0);
    expect(quiet.changes).toEqual([]);
    expect(quiet.tally).toEqual({
      completed: 0,
      reopened: 0,
      added: 0,
      removed: 0,
      toQa: 0,
    });
  });

  it("separates work arriving from work being finished", () => {
    /*
     * One day, both things: four hours finished and twelve hours added. The
     * line rises by eight, which on its own reads as a sprint going backwards
     * — so the day says which part was which.
     */
    const chart = burndown({
      startDate: START,
      endDate: END,
      items: [
        { ...HELD[0]!, status: "DONE" },
        {
          issueId: "c",
          key: "ENG-3",
          title: "Twelve hours, new",
          effortHours: 12,
          remainingHours: 12,
          member: true,
        },
      ],
      history: [],
      statusHistory: [
        { at: at(14, 9), issueId: "a", from: "IN_PROGRESS", to: "DONE" },
      ],
      membershipHistory: [{ at: at(14, 11), issueId: "c", joined: true }],
      now: at(16),
    });

    const day = chart.points[2]!;
    expect(day.completedToday).toBe(8);
    expect(day.scopeToday).toBe(12);
    expect(day.change, "scope less what was finished").toBe(4);
    expect(day.tally).toMatchObject({ completed: 1, added: 1 });
  });

  it("holds the decomposition on every day of the sprint", () => {
    /* The property, not a case of it: whatever happened, the step the line
       took is the scope's movement less the effort finished. */
    const chart = burndown({
      startDate: START,
      endDate: END,
      items: [
        { ...HELD[0]!, status: "REOPENED" },
        {
          issueId: "b",
          key: "ENG-2",
          title: "Re-estimated",
          effortHours: 10,
          remainingHours: null,
        },
        {
          issueId: "c",
          key: "ENG-3",
          title: "Moved out",
          effortHours: 6,
          remainingHours: 6,
          member: false,
        },
      ],
      history: [],
      statusHistory: [
        { at: at(13, 9), issueId: "a", from: "IN_PROGRESS", to: "DONE" },
        { at: at(15, 9), issueId: "a", from: "DONE", to: "REOPENED" },
      ],
      estimateHistory: [{ at: at(14, 10), issueId: "b", from: 4, to: 10 }],
      membershipHistory: [{ at: at(15, 14), issueId: "c", joined: false }],
      now: at(16),
    });

    for (const [index, day] of chart.points.entries()) {
      if (day.change === null) continue;
      expect(
        day.change,
        `day ${index}: the step is the scope's move less the work finished`,
      ).toBe(Math.round((day.scopeToday - day.completedToday) * 100) / 100);
    }
  });

  it("names the work handed to testing, which moves no effort at all", () => {
    /*
     * Ready for QA is open work: the sprint still owes those hours, so the
     * line does not move and the day would otherwise have nothing to say
     * about the one thing that actually happened.
     */
    const chart = burndown({
      startDate: START,
      endDate: END,
      items: HELD,
      history: [],
      statusHistory: [
        { at: at(14, 9), issueId: "a", from: "IN_PROGRESS", to: "IN_QA" },
      ],
      now: at(16),
    });

    const day = chart.points[2]!;
    expect(day.change, "testing owes the same hours").toBe(0);
    expect(day.movedToQa).toEqual([
      { issueId: "a", key: "ENG-1", title: "Eight hours" },
    ]);
    expect(day.tally.toQa).toBe(1);
    /* And it is still open work, so it is still on the list of what is
       left. */
    expect(day.remainingIssues.map((issue) => issue.key)).toContain("ENG-1");
  });

  it("counts a reopening and a removal as what they are", () => {
    const chart = burndown({
      startDate: START,
      endDate: END,
      items: [
        { ...HELD[0]!, status: "REOPENED" },
        {
          issueId: "c",
          key: "ENG-3",
          title: "Taken out",
          effortHours: 6,
          remainingHours: 6,
          member: false,
        },
      ],
      history: [],
      statusHistory: [
        { at: at(13, 9), issueId: "a", from: "IN_PROGRESS", to: "DONE" },
        { at: at(14, 9), issueId: "a", from: "DONE", to: "REOPENED" },
      ],
      membershipHistory: [{ at: at(14, 15), issueId: "c", joined: false }],
      now: at(16),
    });

    const day = chart.points[2]!;
    expect(day.tally).toMatchObject({ reopened: 1, removed: 1, completed: 0 });
  });
});

describe("what the sprint has become", () => {
  it("keeps the commitment it opened with beside the one it holds now", () => {
    /* Twelve hours on the first day, and eight more added on the third: the
       two figures together are what "the scope changed" means. */
    const chart = burndown({
      startDate: START,
      endDate: END,
      items: [
        {
          issueId: "a",
          key: "ENG-1",
          title: "Original",
          effortHours: 12,
          remainingHours: 12,
        },
        {
          issueId: "b",
          key: "ENG-2",
          title: "Added later",
          effortHours: 8,
          remainingHours: 8,
          member: true,
        },
      ],
      history: [],
      membershipHistory: [{ at: at(14, 9), issueId: "b", joined: true }],
      now: at(16),
    });

    expect(chart.initialEffort).toBe(12);
    expect(chart.totalEffort).toBe(20);
    expect(chart.scopeAdded).toBe(8);
    expect(chart.scopeRemoved).toBe(0);
    expect(chart.scopeEvents).toBe(1);
  });

  it("counts hours taken out, and reopenings, separately", () => {
    const chart = burndown({
      startDate: START,
      endDate: END,
      items: [
        {
          issueId: "a",
          key: "ENG-1",
          title: "Stayed",
          effortHours: 10,
          remainingHours: 10,
          status: "REOPENED",
        },
        {
          issueId: "b",
          key: "ENG-2",
          title: "Left",
          effortHours: 6,
          remainingHours: 6,
          member: false,
        },
      ],
      history: [],
      statusHistory: [
        { at: at(13, 9), issueId: "a", from: "IN_PROGRESS", to: "DONE" },
        { at: at(15, 9), issueId: "a", from: "DONE", to: "REOPENED" },
      ],
      membershipHistory: [{ at: at(14, 9), issueId: "b", joined: false }],
      now: at(16),
    });

    expect(chart.scopeRemoved).toBe(-6);
    expect(chart.scopeAdded).toBe(0);
    expect(chart.reopenedEvents).toBe(1);
  });

  it("says how far through the commitment the sprint is", () => {
    const chart = burndown({
      startDate: START,
      endDate: END,
      items: [
        { issueId: "a", effortHours: 30, remainingHours: 30, status: "DONE" },
        { issueId: "b", effortHours: 10, remainingHours: 10 },
      ],
      history: [],
      now: at(16),
    });

    /* Thirty of forty hours finished. One definition, which the marker for
       today reads as well as the summary. */
    expect(chart.progress).toBe(75);
  });

  it("has nothing to say about progress on a sprint with no estimates", () => {
    const chart = burndown({
      startDate: START,
      endDate: END,
      items: [{ issueId: "a", effortHours: null, remainingHours: null }],
      history: [],
      now: at(16),
    });

    expect(chart.progress).toBe(0);
    expect(chart.initialEffort).toBe(0);
  });

  it("counts the days the sprint has left, on the sprint being worked", () => {
    /* The 14th of a sprint ending on the 16th: today, tomorrow and the day
       after — three days, because a sprint ending today can still be worked
       in today. */
    const chart = burndown({
      startDate: START,
      endDate: END,
      items: ITEMS,
      history: [],
      active: true,
      now: at(14, 18),
    });
    expect(chart.daysLeft).toBe(3);

    /* A sprint nobody is working says nothing about its remaining time, and
       neither does one whose last day has passed. */
    expect(
      burndown({
        startDate: START,
        endDate: END,
        items: ITEMS,
        history: [],
        now: at(14),
      }).daysLeft,
    ).toBeNull();
    expect(
      burndown({
        startDate: START,
        endDate: END,
        items: ITEMS,
        history: [],
        active: true,
        now: new Date(2026, 9, 20),
      }).daysLeft,
    ).toBeNull();
  });
});
