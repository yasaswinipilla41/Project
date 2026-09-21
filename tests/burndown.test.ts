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
      items: [...ITEMS, { issueId: "d", effortHours: null, remainingHours: null }],
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

    expect(chart.points.map((p) => p.actual)).toEqual([32, 24, null, null, null]);
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
