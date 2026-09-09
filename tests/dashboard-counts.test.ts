import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { dueWindow } from "@/lib/format";
import { loadDashboard } from "@/server/queries/dashboard";
import { listIssues } from "@/server/queries/issues";
import {
  dueThisWeekFilter,
  dueTodayFilter,
  overdueFilter,
} from "@/server/queries/due";
import type { CurrentUser } from "@/lib/session";
import { actAs, joinTestingTeam, projectByKey } from "./helpers";
import { createIssue, updateIssue } from "@/server/issues";

/**
 * The numbers on Home, and the lists they open.
 *
 * A card that says 2 and opens 3 is the bug this file exists to prevent, and
 * the way it is prevented is that both come from the same fragment in
 * `queries/due`. So every case here recomputes the number a second way — with
 * the fragment, or by listing and counting the rows — and asserts the two
 * agree. If a counter ever grows its own boundaries again, they diverge.
 *
 * Asserted as a tester, because that is the account the QA dashboard is about,
 * but nothing here is role-specific: the same fragments serve every role.
 */

const TESTER = "priya.nair@symbiosystech.com";
const created: string[] = [];
let leave: () => Promise<void> = async () => {};

beforeAll(async () => {
  ({ leave } = await joinTestingTeam(TESTER));
});

afterAll(async () => {
  if (created.length > 0) {
    await prisma.notification.deleteMany({ where: { issueId: { in: created } } });
    await prisma.activityLogEntry.deleteMany({
      where: { issueId: { in: created } },
    });
    await prisma.issue.deleteMany({ where: { id: { in: created } } });
  }
  await leave();
  await prisma.$disconnect();
});

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

/** An ENG issue assigned to the tester, due on a given day. */
async function anIssueDue(title: string, dueDate: Date | null): Promise<string> {
  await actAs("admin@symbiosystech.com");
  const project = await projectByKey("ENG");
  const tester = await userByEmail(TESTER);

  const result = await createIssue({
    projectId: project.id,
    type: "TASK",
    title: `${title} ${Date.now()}`,
    description: "fixture",
    status: "TODO",
    priority: "MEDIUM",
    assigneeId: tester.id,
    ...(dueDate ? { dueDate: dueDate.toISOString() } : {}),
  });
  if (!result.ok) throw new Error(result.error);
  created.push(result.data.id);
  return result.data.id;
}

function dayOffset(days: number): Date {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return date;
}

describe("Assigned to me", () => {
  it("counts exactly the issues the list holds", async () => {
    const user = await userByEmail(TESTER);
    const data = await loadDashboard(user);

    /* The same question, asked of the issue list the card links to. The card's
       number is the total, and the section under it previews the first few of
       that same set — so the total is what must agree. */
    const list = await listIssues(user, {
      assigneeIds: [user.id],
      resolution: "open",
      pageSize: 200,
    });

    expect(data.myWork.assigned).toBe(list.total);
    expect(list.rows.length).toBe(Math.min(list.total, 200));
  });

  it("is the same set My assigned tasks previews", async () => {
    /* Home shows one number twice — beside "Assigned to me" and on the "My
       assigned tasks" heading — and previews that set below it. The preview is
       the head of the list, never a different list. */
    const user = await userByEmail(TESTER);
    const data = await loadDashboard(user);

    const list = await listIssues(user, {
      assigneeIds: [user.id],
      resolution: "open",
      pageSize: 200,
    });
    const listed = new Set(list.rows.map((row) => row.id));

    expect(data.assigned.length).toBeLessThanOrEqual(data.myWork.assigned);
    for (const issue of data.assigned) {
      expect(listed.has(issue.id), `${issue.key} is in the full list`).toBe(true);
    }
  });
});

describe("Overdue", () => {
  it("counts what the fragment counts, and nothing due today", async () => {
    const user = await userByEmail(TESTER);
    await anIssueDue("Overdue fixture", dayOffset(-3));
    await anIssueDue("Due today fixture", dayOffset(0));

    const data = await loadDashboard(user);
    /* Scoped to the projects this person can open, exactly as the dashboard
       scopes it — being assigned something in a project you are not a member
       of is possible, and Home does not count what it cannot show. */
    const mine = {
      assigneeId: user.id,
      projectId: { in: data.scope.projectIds },
    };
    const counted = await prisma.issue.count({
      where: { ...mine, ...overdueFilter() },
    });

    expect(data.due.overdue).toBe(counted);

    // Nothing due today is overdue, whatever the time of day.
    const { startOfToday } = dueWindow();
    const rows = await prisma.issue.findMany({
      where: { ...mine, ...overdueFilter() },
      select: { dueDate: true },
    });
    for (const row of rows) {
      expect(row.dueDate!.getTime()).toBeLessThan(startOfToday.getTime());
    }
  });
});

describe("Due today", () => {
  it("counts today's date, and only today's", async () => {
    const user = await userByEmail(TESTER);
    await anIssueDue("Due today too", dayOffset(0));
    await anIssueDue("Due tomorrow", dayOffset(1));

    const data = await loadDashboard(user);
    const mine = {
      assigneeId: user.id,
      projectId: { in: data.scope.projectIds },
    };
    const counted = await prisma.issue.count({
      where: { ...mine, ...dueTodayFilter() },
    });
    expect(data.due.today).toBe(counted);

    const { startOfToday, endOfToday } = dueWindow();
    const rows = await prisma.issue.findMany({
      where: { ...mine, ...dueTodayFilter() },
      select: { dueDate: true },
    });
    for (const row of rows) {
      expect(row.dueDate!.getTime()).toBeGreaterThanOrEqual(startOfToday.getTime());
      expect(row.dueDate!.getTime()).toBeLessThan(endOfToday.getTime());
    }
  });
});

describe("Due this week", () => {
  it("counts the whole calendar week, and matches the list it opens", async () => {
    const user = await userByEmail(TESTER);
    const { startOfWeek, endOfWeek, startOfToday } = dueWindow();

    // A day earlier in this week, if today is not its first day.
    const daysIn = Math.round(
      (startOfToday.getTime() - startOfWeek.getTime()) / 86_400_000,
    );
    if (daysIn > 0) await anIssueDue("Earlier this week", dayOffset(-1));
    await anIssueDue("Later today", dayOffset(0));

    const data = await loadDashboard(user);

    // The count, the fragment and the list all answer the same.
    const counted = await prisma.issue.count({
      where: {
        assigneeId: user.id,
        projectId: { in: data.scope.projectIds },
        ...dueThisWeekFilter(),
      },
    });
    const list = await listIssues(user, {
      assigneeIds: [user.id],
      resolution: "open",
      dueWeek: true,
      pageSize: 200,
    });

    expect(data.due.thisWeek).toBe(counted);
    expect(list.total).toBe(counted);
    expect(list.rows.length).toBe(counted);

    // Every row really is inside the week.
    for (const row of list.rows) {
      const due = new Date(row.dueDate!).getTime();
      expect(due).toBeGreaterThanOrEqual(startOfWeek.getTime());
      expect(due).toBeLessThan(endOfWeek.getTime());
    }
  });

  it("holds work due earlier in the week, which is also overdue", async () => {
    /* The two buckets overlap on purpose: work due on Monday, read on
       Wednesday, is late *and* due this week. What must never happen is it
       being counted in one and missing from the other's list. */
    const { startOfToday, startOfWeek } = dueWindow();
    const daysIn = Math.round(
      (startOfToday.getTime() - startOfWeek.getTime()) / 86_400_000,
    );
    if (daysIn === 0) return; // Monday: nothing earlier in the week exists.

    const user = await userByEmail(TESTER);
    const issueId = await anIssueDue("Late but this week", dayOffset(-1));

    const list = await listIssues(user, {
      assigneeIds: [user.id],
      resolution: "open",
      dueWeek: true,
      pageSize: 200,
    });
    expect(list.rows.map((row) => row.id)).toContain(issueId);

    const overdue = await prisma.issue.count({
      where: { id: issueId, ...overdueFilter() },
    });
    expect(overdue).toBe(1);
  });

  it("drops work as soon as it is finished", async () => {
    const user = await userByEmail(TESTER);
    const issueId = await anIssueDue("Finished this week", dayOffset(0));

    await actAs("admin@symbiosystech.com");
    expect((await updateIssue({ issueId, status: "DONE" })).ok).toBe(true);

    const list = await listIssues(user, {
      assigneeIds: [user.id],
      resolution: "open",
      dueWeek: true,
      pageSize: 200,
    });
    expect(list.rows.map((row) => row.id)).not.toContain(issueId);

    const counted = await prisma.issue.count({
      where: { id: issueId, ...dueThisWeekFilter() },
    });
    expect(counted).toBe(0);
  });
});

describe("project progress", () => {
  it("is computed from the project's own issues", async () => {
    const user = await userByEmail(TESTER);
    const data = await loadDashboard(user);

    for (const project of data.projects) {
      const total = await prisma.issue.count({
        where: { projectId: project.id },
      });
      const done = await prisma.issue.count({
        where: { projectId: project.id, status: "DONE" },
      });

      expect(project.total, `${project.key} counts its issues`).toBe(total);
      expect(project.done, `${project.key} counts what is finished`).toBe(done);
    }
  });
});
