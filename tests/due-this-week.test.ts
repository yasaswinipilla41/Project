import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { dueWindow } from "@/lib/format";
import { createIssue } from "@/server/issues";
import { listIssues } from "@/server/queries/issues";
import type { CurrentUser } from "@/lib/session";
import { actAs, deleteIssues, projectByKey } from "./helpers";

/**
 * "Due this week" — the Home bucket and the list it opens.
 *
 * The rule under test is a definition, not a preference: this week means the
 * whole of the current calendar week — `[startOfWeek, startOfNextWeek)` — from
 * its first moment, not the remainder of it. Work due on Monday is still due
 * this week when it is read on Wednesday; it is also overdue, and both are
 * true of it. Work due after the week ends is excluded, and an issue with no
 * due date is in neither bucket.
 *
 * Written against `listIssues` rather than the page, because that filter is
 * what the Home link now navigates to — the count and the rows behind it come
 * from the same boundaries, so testing the boundaries tests both.
 */

const created: string[] = [];

afterAll(async () => {
  await deleteIssues(created);
  await prisma.$disconnect();
});

/** `listIssues` takes a `CurrentUser`; read the authoritative row for one. */
async function userByEmail(email: string): Promise<CurrentUser> {
  return prisma.user.findUniqueOrThrow({
    where: { email },
    select: {
      id: true,
      name: true,
      email: true,
      image: true,
      role: true,
      jobTitle: true,
      isActive: true,
    },
  });
}

/** Midnight, `days` from today. */
function dayOffset(days: number): Date {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return date;
}

describe("the due-date window", () => {
  it("ends when the calendar week does, not seven days out", () => {
    // Monday through Sunday, each read as if it were today.
    for (let offset = 0; offset < 7; offset += 1) {
      const monday = new Date(2026, 8, 7); // 7 Sep 2026 is a Monday.
      monday.setDate(monday.getDate() + offset);
      monday.setHours(9, 30, 0, 0);

      const { startOfWeek, endOfWeek } = dueWindow(monday);

      // The window is exactly one week, Monday to Monday, wherever in it the
      // clock happens to be.
      expect(startOfWeek.getDay()).toBe(1);
      expect(endOfWeek.getDay()).toBe(1);
      expect(startOfWeek.getTime()).toBe(new Date(2026, 8, 7).getTime());
      expect(endOfWeek.getTime()).toBe(new Date(2026, 8, 14).getTime());
    }
  });

  it("holds every day of the week, and neither day outside it", () => {
    const now = new Date(2026, 8, 9, 16, 45); // Wednesday afternoon.
    const { startOfWeek, endOfWeek } = dueWindow(now);
    const inWeek = (date: Date) => date >= startOfWeek && date < endOfWeek;

    // Monday the 7th through Sunday the 13th, inclusive.
    for (let day = 7; day <= 13; day += 1) {
      expect(inWeek(new Date(2026, 8, day)), `Sep ${day}`).toBe(true);
    }

    // The first moment of the week is in; the last moment before it is not.
    expect(inWeek(startOfWeek)).toBe(true);
    expect(inWeek(new Date(startOfWeek.getTime() - 1))).toBe(false);

    // The last moment of the week is in; the first moment of the next is not.
    expect(inWeek(new Date(endOfWeek.getTime() - 1))).toBe(true);
    expect(inWeek(endOfWeek)).toBe(false);

    // Either side of the week entirely.
    expect(inWeek(new Date(2026, 8, 6))).toBe(false);
    expect(inWeek(new Date(2026, 8, 14))).toBe(false);
  });
});

describe("the dueWeek filter", () => {
  /*
   * One issue per boundary, all in the same project and assigned to nobody in
   * particular — the filter under test is about dates alone.
   */
  async function anIssueDue(title: string, dueDate: Date | null) {
    const project = await projectByKey("ENG");
    const result = await createIssue({
      projectId: project.id,
      type: "TASK",
      title,
      status: "TODO",
      dueDate: dueDate ? dueDate.toISOString() : "",
    });
    if (!result.ok) throw new Error(result.error);
    created.push(result.data.id);
    return result.data.id;
  }

  it("shows this week's dated work and nothing else", async () => {
    await actAs("admin@symbiosystech.com");
    const user = await userByEmail("admin@symbiosystech.com");

    const { startOfToday, startOfWeek, endOfWeek } = dueWindow();
    /* Days left in the calendar week, so "later this week" is only created
       when there is a later day in the week to use. Late on a Sunday there is
       not, and the case is skipped rather than faked. */
    const daysLeft = Math.round(
      (endOfWeek.getTime() - startOfToday.getTime()) / 86_400_000,
    );
    // Likewise for a day earlier in the week: on a Monday there is none.
    const daysIn = Math.round(
      (startOfToday.getTime() - startOfWeek.getTime()) / 86_400_000,
    );

    const earlier =
      daysIn > 0 ? await anIssueDue("Due earlier this week", dayOffset(-1)) : null;
    const lastWeek = await anIssueDue("Due last week", dayOffset(-(daysIn + 1)));
    const today = await anIssueDue("Due today", dayOffset(0));
    const later =
      daysLeft > 1 ? await anIssueDue("Due later this week", dayOffset(1)) : null;
    const nextWeek = await anIssueDue("Due next week", dayOffset(daysLeft + 1));
    const undated = await anIssueDue("No due date", null);

    const result = await listIssues(user, {
      dueWeek: true,
      pageSize: 100,
    });
    const ids = new Set(result.rows.map((row) => row.id));

    expect(ids.has(today)).toBe(true);
    if (later) expect(ids.has(later)).toBe(true);
    // Earlier in the same week counts: the week is the week, all of it.
    if (earlier) expect(ids.has(earlier)).toBe(true);

    expect(ids.has(lastWeek)).toBe(false);
    expect(ids.has(nextWeek)).toBe(false);
    expect(ids.has(undated)).toBe(false);
  });

  it("never returns anything outside the week", async () => {
    await actAs("admin@symbiosystech.com");
    const user = await userByEmail("admin@symbiosystech.com");
    const { startOfWeek, endOfWeek } = dueWindow();

    const result = await listIssues(user, { dueWeek: true, pageSize: 100 });

    for (const row of result.rows) {
      expect(row.dueDate).not.toBeNull();
      const due = new Date(row.dueDate!).getTime();
      expect(due).toBeGreaterThanOrEqual(startOfWeek.getTime());
      expect(due).toBeLessThan(endOfWeek.getTime());
    }
  });
});
