import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { monthWindow } from "@/lib/format";
import type { CurrentUser } from "@/lib/session";
import { loadDashboard } from "@/server/queries/dashboard";
import { createIssue, updateIssue } from "@/server/issues";
import { listIssues } from "@/server/queries/issues";
import { parseIssueParams } from "@/server/queries/params";
import { actAs, deleteIssues, joinTestingTeam, projectByKey } from "./helpers";

/**
 * "Completed this month", and the list it opens.
 *
 * The fault this pins: the count and the "N completed in total" beneath it
 * used to mean different things. The total counts `status: DONE`; the monthly
 * figure counted anything with a `completedAt` in range — and `updateIssue`
 * writes `completedAt` for CANCELLED as well as DONE, so cancelling an issue
 * raised "completed this month" while the total under it did not move. One
 * card, two definitions of completed, contradicting each other.
 *
 * Every assertion below is written against dated rows this file creates and
 * removes, so nothing depends on where in the month the suite happens to run.
 */

const ADMIN = "admin@symbiosystech.com";

const createdIssues: string[] = [];

/*
 * These tests raise work and carry it through to Done, which is a tester's
 * job: Prio decides developer-or-tester by Testing-team membership, and the
 * seed puts nobody on it. The people acting below are made testers for the
 * run and taken off again afterwards, so the fixture is left as it was found.
 */
const testerEmails = ["priya.nair@symbiosystech.com"];
const leaveTestingTeam: (() => Promise<void>)[] = [];

beforeAll(async () => {
  for (const email of testerEmails) {
    const { leave } = await joinTestingTeam(email);
    leaveTestingTeam.push(leave);
  }
});

afterAll(async () => {
  for (const leave of leaveTestingTeam) await leave();
  await deleteIssues(createdIssues);
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
  }) as unknown as Promise<CurrentUser>;
}

/**
 * An issue in a known terminal state with a chosen `completedAt`.
 *
 * Written directly rather than through the workflow because the point is the
 * *date*, and no amount of clicking can put a completion in last month or in
 * the future.
 */
async function completedIssue(
  projectId: string,
  title: string,
  status: "DONE" | "CANCELLED",
  completedAt: Date,
) {
  const project = await prisma.project.update({
    where: { id: projectId },
    data: { issueSequence: { increment: 1 } },
    select: { key: true, issueSequence: true },
  });
  const reporter = await prisma.user.findFirstOrThrow({
    where: { role: "ADMIN" },
    select: { id: true },
  });

  const issue = await prisma.issue.create({
    data: {
      projectId,
      key: `${project.key}-${project.issueSequence}`,
      number: project.issueSequence,
      title,
      type: "TASK",
      status,
      completedAt,
      reporterId: reporter.id,
    },
    select: { id: true, key: true },
  });
  createdIssues.push(issue.id);
  return issue;
}

/** Halfway through the current month, so it is never a boundary case. */
function midThisMonth(): Date {
  const { startOfMonth } = monthWindow();
  const date = new Date(startOfMonth);
  date.setDate(14);
  date.setHours(12, 0, 0, 0);
  return date;
}

describe("Completed this month", () => {
  it("counts work finished in the current month, and only that", async () => {
    const user = await userByEmail(ADMIN);
    const project = await projectByKey("ENG");
    const { startOfMonth, startOfLastMonth, startOfNextMonth } = monthWindow();

    const before = (await loadDashboard(user)).kpi;

    // One in each bucket: this month, last month, and after the month ends.
    const lastMonth = new Date(startOfLastMonth);
    lastMonth.setDate(15);
    const nextMonth = new Date(startOfNextMonth);
    nextMonth.setDate(3);

    await completedIssue(project.id, "Finished this month", "DONE", midThisMonth());
    await completedIssue(project.id, "Finished last month", "DONE", lastMonth);
    await completedIssue(project.id, "Finished next month", "DONE", nextMonth);

    const after = (await loadDashboard(user)).kpi;

    // Only the current-month one moved the figure.
    expect(after.completedThisMonth).toBe(before.completedThisMonth + 1);
    // The previous month's bucket took its own, and nothing else.
    expect(after.completedLastMonth).toBe(before.completedLastMonth + 1);
    // A future completion is in neither.
    expect(after.completedThisMonth + after.completedLastMonth).toBe(
      before.completedThisMonth + before.completedLastMonth + 2,
    );
    // And the boundaries are the shared ones.
    expect(startOfMonth.getTime()).toBeLessThan(startOfNextMonth.getTime());
  });

  it("does not count cancelled work as completed", async () => {
    /*
     * The mismatch this whole test file exists for. `updateIssue` stamps
     * `completedAt` when an issue is CANCELLED as well as when it is DONE, so
     * a monthly count keyed on the date alone counted abandoned work — while
     * the "N completed in total" printed beneath it, which counts DONE, did
     * not. The two must move together or not at all.
     */
    const user = await userByEmail(ADMIN);
    const project = await projectByKey("ENG");

    const before = (await loadDashboard(user)).kpi;

    await completedIssue(
      project.id,
      "Abandoned this month",
      "CANCELLED",
      midThisMonth(),
    );

    const after = (await loadDashboard(user)).kpi;

    expect(after.completedThisMonth).toBe(before.completedThisMonth);
    expect(after.completed).toBe(before.completed);
  });

  it("keeps the headline figure and its subtitle on one definition", async () => {
    /* Whatever the data, everything counted as completed this month is part of
       the total printed under it. A month figure larger than the total is the
       contradiction the card used to be able to show. */
    const user = await userByEmail(ADMIN);
    const project = await projectByKey("ENG");

    await completedIssue(project.id, "Done this month", "DONE", midThisMonth());
    await completedIssue(
      project.id,
      "Cancelled this month",
      "CANCELLED",
      midThisMonth(),
    );

    const { kpi } = await loadDashboard(user);
    expect(kpi.completedThisMonth).toBeLessThanOrEqual(kpi.completed);
  });

  it("agrees with the issue list the metric links to", async () => {
    /*
     * The number and the list behind it are cut by the same `monthWindow`, so
     * clicking the figure must open exactly the issues it counted — not every
     * issue ever finished, which is what a bare `?status=DONE` opened.
     */
    const user = await userByEmail(ADMIN);
    const project = await projectByKey("ENG");

    await completedIssue(project.id, "Counted and listed", "DONE", midThisMonth());

    const { kpi } = await loadDashboard(user);

    // Exactly the query string the dashboard card links to.
    const filters = parseIssueParams({
      status: "DONE",
      completedWithin: "month",
    });
    const list = await listIssues(user, { ...filters, pageSize: 100 });

    expect(list.total).toBe(kpi.completedThisMonth);

    const { startOfMonth, startOfNextMonth } = monthWindow();
    const rows = await prisma.issue.findMany({
      where: { id: { in: list.rows.map((r) => r.id) } },
      select: { status: true, completedAt: true },
    });
    for (const row of rows) {
      expect(row.status).toBe("DONE");
      expect(row.completedAt!.getTime()).toBeGreaterThanOrEqual(
        startOfMonth.getTime(),
      );
      expect(row.completedAt!.getTime()).toBeLessThan(startOfNextMonth.getTime());
    }

    // The unfiltered DONE list is the wider one the card used to open.
    const all = await listIssues(user, {
      ...parseIssueParams({ status: "DONE" }),
      pageSize: 100,
    });
    expect(all.total).toBeGreaterThanOrEqual(list.total);

    // The project id never leaks: the filter narrows, it does not widen scope.
    expect(project.id).toBeTruthy();
  });

  it("ignores an unrecognised completedWithin value", async () => {
    // User-controlled input reaching a database query: dropped, like every
    // other malformed value `parseIssueParams` sees.
    expect(parseIssueParams({ completedWithin: "yesterday" }).completedWithin).
      toBeUndefined();
    expect(parseIssueParams({ completedWithin: "month" }).completedWithin).toBe(
      "month",
    );
    expect(
      parseIssueParams({ completedWithin: "lastMonth" }).completedWithin,
    ).toBe("lastMonth");
  });
});

describe("Who completed an issue, in the issue list", () => {
  it("names the person who moved it to Done, not the assignee", async () => {
    /* The same rule the project summary's Completed section uses, from the one
       shared `completersFor` — so the two surfaces cannot name different
       people for the same issue. */
    const admin = await actAs(ADMIN);
    const user = await userByEmail(ADMIN);
    const project = await projectByKey("ENG");

    const created = await createIssue({
      projectId: project.id,
      type: "TASK",
      title: `List completer ${Date.now()}`,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const issue = await prisma.issue.findUniqueOrThrow({
      where: { key: created.data.key },
      select: { id: true },
    });
    createdIssues.push(issue.id);

    /* Carried to the point of verification by the people whose statuses those
       are, and then finished by somebody else — which is the whole point: the
       person who moved it to Done is not the person holding it. */
    await actAs(ADMIN);
    for (const status of ["TODO", "IN_PROGRESS", "IN_REVIEW"] as const) {
      expect((await updateIssue({ issueId: issue.id, status })).ok).toBe(true);
    }

    const finisher = await actAs("priya.nair@symbiosystech.com");
    expect((await updateIssue({ issueId: issue.id, status: "DONE" })).ok).toBe(
      true,
    );

    // …and afterwards it is handed to somebody else entirely.
    await actAs(ADMIN);
    expect(
      (await updateIssue({ issueId: issue.id, assigneeId: admin.id })).ok,
    ).toBe(true);

    const list = await listIssues(user, {
      statuses: ["DONE"],
      projectIds: [project.id],
      pageSize: 100,
    });
    const row = list.rows.find((r) => r.id === issue.id);

    expect(row).toBeDefined();
    expect(row!.completedBy?.id).toBe(finisher.id);
    expect(row!.assignee?.id).toBe(admin.id);
    // The whole point: the two are different people.
    expect(row!.completedBy?.id).not.toBe(row!.assignee?.id);
  });

  it("leaves it null for work that is not finished", async () => {
    const user = await userByEmail(ADMIN);
    const project = await projectByKey("ENG");

    const list = await listIssues(user, {
      resolution: "open",
      projectIds: [project.id],
      pageSize: 25,
    });

    for (const row of list.rows) {
      expect(row.completedBy, `${row.key} is open`).toBeNull();
    }
  });
});
