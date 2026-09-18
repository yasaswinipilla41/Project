import { describe, expect, it } from "vitest";
import { isWeekend, workingDaysBetween } from "@/lib/format";

/**
 * How long a sprint is, in days somebody actually works.
 *
 * A fortnight's sprint is ten working days, not fourteen: the two weekends
 * inside it are calendar days nobody is working, so counting them would
 * overstate every sprint's capacity. The rule is a definition rather than a
 * preference, so it is pinned here with fixed dates rather than dates derived
 * from today — a test that computes its own expectation from the same
 * arithmetic proves nothing about the arithmetic.
 *
 * September 2026 is the calendar used throughout: the 7th is a Monday, so the
 * 12th/13th and 19th/20th are the two weekends.
 */

const MONDAY = new Date(2026, 8, 7);
const FRIDAY = new Date(2026, 8, 11);
const SATURDAY = new Date(2026, 8, 12);
const SUNDAY = new Date(2026, 8, 13);
const NEXT_FRIDAY = new Date(2026, 8, 18);

describe("isWeekend", () => {
  it("is true for Saturday and Sunday, and false for the week", () => {
    expect(isWeekend(SATURDAY)).toBe(true);
    expect(isWeekend(SUNDAY)).toBe(true);

    // Monday through Friday.
    for (let offset = 0; offset < 5; offset += 1) {
      const weekday = new Date(2026, 8, 7 + offset);
      expect(isWeekend(weekday), weekday.toDateString()).toBe(false);
    }
  });
});

describe("workingDaysBetween", () => {
  it("counts a standard two-week sprint as ten working days", () => {
    /* Monday the 7th to Friday the 18th: fourteen calendar days, two
       weekends, ten days of work. This is the figure the requirement names. */
    expect(workingDaysBetween(MONDAY, NEXT_FRIDAY)).toBe(10);
  });

  it("counts one week as five", () => {
    expect(workingDaysBetween(MONDAY, FRIDAY)).toBe(5);
  });

  it("includes both ends, so a single weekday is one day of work", () => {
    expect(workingDaysBetween(MONDAY, MONDAY)).toBe(1);
  });

  it("counts nothing for a weekend-only span", () => {
    expect(workingDaysBetween(SATURDAY, SUNDAY)).toBe(0);
  });

  it("skips the weekend between a Friday and the following Monday", () => {
    const monday = new Date(2026, 8, 14);
    expect(workingDaysBetween(FRIDAY, monday)).toBe(2);
  });

  it("ignores the time of day", () => {
    /* Both ends are normalised to local midnight, as `daysUntil` does, so a
       sprint does not gain or lose a day depending on when it was created. */
    const lateMonday = new Date(2026, 8, 7, 23, 59, 59);
    const earlyFriday = new Date(2026, 8, 18, 0, 0, 1);
    expect(workingDaysBetween(lateMonday, earlyFriday)).toBe(10);
  });

  it("reads ISO date strings, which is how sprint dates arrive", () => {
    expect(workingDaysBetween("2026-09-07", "2026-09-18")).toBe(10);
  });

  it("returns nothing rather than a negative for an inverted or absent range", () => {
    expect(workingDaysBetween(NEXT_FRIDAY, MONDAY)).toBe(0);
    expect(workingDaysBetween(null, MONDAY)).toBe(0);
    expect(workingDaysBetween(MONDAY, undefined)).toBe(0);
    expect(workingDaysBetween("not a date", MONDAY)).toBe(0);
  });
});
