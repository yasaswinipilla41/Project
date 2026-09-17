import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { elapsedBetween, formatElapsed, hoursAgo } from "@/lib/format";

/**
 * How long a work item took, and how it is written down.
 *
 * Two separate claims, tested separately because they fail differently: the
 * arithmetic is about two stored instants and nothing else, and the wording is
 * about what a person reads off it. The one thing neither may ever do is
 * produce a completion time for work that has not completed — a number on that
 * row is a claim the work is finished.
 */

afterAll(async () => {
  await prisma.$disconnect();
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("the span between two instants", () => {
  it("is the difference, in milliseconds", () => {
    const from = new Date("2026-09-15T10:00:00.000Z");
    const to = new Date("2026-09-17T14:30:00.000Z");

    expect(elapsedBetween(from, to)).toBe(2 * DAY + 4 * HOUR + 30 * MINUTE);
  });

  it("is zero when the two are the same instant", () => {
    const at = new Date("2026-09-15T10:00:00.000Z");
    expect(elapsedBetween(at, at)).toBe(0);
  });

  it("is null when there is no end, rather than a duration to now", () => {
    /*
     * The case the whole feature turns on. Unfinished work has no completion
     * to measure to, and anything other than null here would put a finished
     * duration on an open item.
     */
    expect(elapsedBetween(new Date(), null)).toBeNull();
    expect(elapsedBetween(new Date(), undefined)).toBeNull();
  });

  it("is null when either end is not a date at all", () => {
    expect(elapsedBetween("not a date", new Date())).toBeNull();
    expect(elapsedBetween(new Date(), "not a date")).toBeNull();
  });

  it("reads ISO strings, which is what a serialised row carries", () => {
    expect(
      elapsedBetween("2026-09-15T10:00:00.000Z", "2026-09-15T14:00:00.000Z"),
    ).toBe(4 * HOUR);
  });
});

describe("writing a span down", () => {
  it("gives days and hours once it has run a day", () => {
    expect(formatElapsed(2 * DAY + 4 * HOUR + 30 * MINUTE)).toBe("2d 4h");
    expect(formatElapsed(12 * DAY + 4 * HOUR)).toBe("12d 4h");
  });

  it("drops the hours when there are none", () => {
    expect(formatElapsed(3 * DAY)).toBe("3d");
  });

  it("gives hours and minutes under a day", () => {
    expect(formatElapsed(4 * HOUR + 25 * MINUTE)).toBe("4h 25m");
    expect(formatElapsed(5 * HOUR)).toBe("5h");
  });

  it("falls to minutes under an hour", () => {
    expect(formatElapsed(25 * MINUTE)).toBe("25m");
  });

  it("says 0m for nothing at all, rather than counting seconds", () => {
    expect(formatElapsed(0)).toBe("0m");
    expect(formatElapsed(45_000)).toBe("0m");
  });

  it("never prints a negative duration", () => {
    /* Should not happen — it would mean finishing before starting — but a
       clock skew is not a reason to show somebody "-3h". */
    expect(formatElapsed(-1 * HOUR)).toBe("0m");
  });

  it("stays a duration however long it runs", () => {
    /* Unlike "how long ago", which turns into a date after a week. Work open
       for three months is 92 days, not a calendar entry. */
    expect(formatElapsed(92 * DAY)).toBe("92d");
  });
});

describe("hours since an instant", () => {
  it("counts whole hours, rounded down", () => {
    const at = new Date(Date.now() - (3 * HOUR + 59 * MINUTE));
    expect(hoursAgo(at)).toBe(3);
  });

  it("is zero inside the first hour", () => {
    expect(hoursAgo(new Date(Date.now() - 10 * MINUTE))).toBe(0);
  });

  it("is null for nothing", () => {
    expect(hoursAgo(null)).toBeNull();
    expect(hoursAgo(undefined)).toBeNull();
  });
});

describe("a real work item's worked time", () => {
  it("is the gap between the timestamps the database holds", async () => {
    /*
     * Read rather than written: this asserts the calculation against rows that
     * already exist, so it is exercising the same two fields the page reads
     * rather than a fixture shaped to suit it.
     */
    const done = await prisma.issue.findFirst({
      where: { completedAt: { not: null } },
      select: { createdAt: true, completedAt: true },
      orderBy: { completedAt: "desc" },
    });

    if (!done) return; // Nothing finished on this installation yet.

    const worked = elapsedBetween(done.createdAt, done.completedAt);
    expect(worked).not.toBeNull();
    expect(worked).toBe(
      done.completedAt!.getTime() - done.createdAt.getTime(),
    );
    /* And it reads as something, whatever the span happens to be. */
    expect(formatElapsed(worked!)).toMatch(/^\d+[dhm]/);
  });

  it("is absent for work that has not finished", async () => {
    const open = await prisma.issue.findFirst({
      where: { completedAt: null },
      select: { createdAt: true, completedAt: true },
    });

    if (!open) return;

    expect(elapsedBetween(open.createdAt, open.completedAt)).toBeNull();
  });
});
