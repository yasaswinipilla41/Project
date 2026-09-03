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
 * current calendar week, it includes today, and it excludes anything already
 * past its date. Overdue work has its own bucket and must never appear here;
 * work due after the week ends must not either; and an issue with no due date
 * is in neither.
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

      const { startOfToday, endOfWeek } = dueWindow(monday);

      // The window never runs past the following Monday.
      expect(endOfWeek.getDay()).toBe(1);
      expect(endOfWeek.getTime()).toBe(new Date(2026, 8, 14).getTime());
      expect(startOfToday.getTime()).toBeLessThan(endOfWeek.getTime());
    }
  });

  it("starts at the beginning of today, so today is in the week", () => {
    const now = new Date(2026, 8, 9, 16, 45); // Wednesday afternoon.
    const { startOfToday, endOfWeek } = dueWindow(now);

    const dueToday = new Date(2026, 8, 9);
    expect(dueToday >= startOfToday && dueToday < endOfWeek).toBe(true);
  });

  it("puts yesterday outside the window", () => {
    const now = new Date(2026, 8, 9, 16, 45);
    const { startOfToday } = dueWindow(now);
    expect(new Date(2026, 8, 8) < startOfToday).toBe(true);
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

    const { startOfToday, endOfWeek } = dueWindow();
    /* Days left in the calendar week, so "later this week" is only created
       when there is a later day in the week to use. Late on a Sunday there is
       not, and the case is skipped rather than faked. */
    const daysLeft = Math.round(
      (endOfWeek.getTime() - startOfToday.getTime()) / 86_400_000,
    );

    const yesterday = await anIssueDue("Due yesterday", dayOffset(-1));
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

    expect(ids.has(yesterday)).toBe(false);
    expect(ids.has(nextWeek)).toBe(false);
    expect(ids.has(undated)).toBe(false);
  });

  it("never returns an issue whose due date has passed", async () => {
    await actAs("admin@symbiosystech.com");
    const user = await userByEmail("admin@symbiosystech.com");
    const { startOfToday } = dueWindow();

    const result = await listIssues(user, { dueWeek: true, pageSize: 100 });

    for (const row of result.rows) {
      expect(row.dueDate).not.toBeNull();
      expect(new Date(row.dueDate!).getTime()).toBeGreaterThanOrEqual(
        startOfToday.getTime(),
      );
    }
  });
});
