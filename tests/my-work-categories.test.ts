import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { issueScope } from "@/lib/authz";
import { OPEN_STATUSES } from "@/lib/domain";
import { dueWindow } from "@/lib/format";
import type { CurrentUser } from "@/lib/session";
import { completedByFilter } from "@/server/queries/completedWork";
import { dueThisWeekFilter, overdueFilter } from "@/server/queries/due";
import { joinProject, projectByKey } from "./helpers";

/**
 * The three claims My Work's tiles rest on that nothing else pinned.
 *
 * The categories themselves are covered elsewhere — `my-work-scope` proves a
 * tile counts its own list and nobody else's work, `my-work-completed` proves
 * who finished a piece of work, `due-this-week` proves where the calendar week
 * starts and ends. What none of them asks is what happens at the edges:
 *
 *   1. work that was finished and then reopened, which must leave Completed
 *      and rejoin Open rather than being counted in both or in neither;
 *   2. the overdue day boundary read against real rows — something due today
 *      is due today until the day is over, whatever the clock says;
 *   3. whether Overdue and Due this week are one person's, since a date
 *      category is the easiest place to lose the ownership half of the rule.
 *
 * The fixtures are rows written straight to the database rather than driven
 * through the workflow, because what is under test is the where-clause: the
 * transitions themselves belong to the workflow suites.
 */

const OWNER = "kiran.das@symbiosystech.com";
const OTHER = "vikram.shetty@symbiosystech.com";

const created: string[] = [];
const leavers: (() => Promise<void>)[] = [];
let projectId = "";
let ownerId = "";
let otherId = "";
let ownerUser: CurrentUser;

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

/** A row in the fixture project, written directly. */
async function makeIssue(opts: {
  title: string;
  assigneeId: string | null;
  status?: "TODO" | "IN_PROGRESS" | "DONE";
  dueDate?: Date | null;
}): Promise<string> {
  const number = Math.floor(Math.random() * 1_000_000) + 500_000;
  const issue = await prisma.issue.create({
    data: {
      key: `MWC-${number}`,
      number,
      projectId,
      type: "TASK",
      title: opts.title,
      status: opts.status ?? "TODO",
      priority: "MEDIUM",
      reporterId: ownerId,
      assigneeId: opts.assigneeId,
      dueDate: opts.dueDate ?? null,
    },
    select: { id: true },
  });
  created.push(issue.id);
  return issue.id;
}

/** The page's own where-clause for one tile, asked as a set of ids. */
async function idsIn(tile: "open" | "completed" | "overdue" | "dueWeek", now: Date) {
  const scope = issueScope(ownerUser);
  const assigned = {
    ...scope,
    assigneeId: ownerId,
    status: { in: [...OPEN_STATUSES] },
  };

  const where =
    tile === "open"
      ? assigned
      : tile === "completed"
        ? { ...scope, ...completedByFilter([ownerId]) }
        : {
            ...scope,
            assigneeId: ownerId,
            AND: [
              { status: { in: [...OPEN_STATUSES] } },
              tile === "overdue" ? overdueFilter(now) : dueThisWeekFilter(now),
            ],
          };

  const rows = await prisma.issue.findMany({ where, select: { id: true } });
  return new Set(rows.map((row) => row.id));
}

beforeAll(async () => {
  projectId = (await projectByKey("ENG")).id;
  ownerUser = await userByEmail(OWNER);
  ownerId = ownerUser.id;
  otherId = (await userByEmail(OTHER)).id;

  for (const email of [OWNER, OTHER]) {
    leavers.push((await joinProject("ENG", email)).leave);
  }
});

afterAll(async () => {
  if (created.length > 0) {
    await prisma.notification.deleteMany({ where: { issueId: { in: created } } });
    await prisma.activityLogEntry.deleteMany({
      where: { issueId: { in: created } },
    });
    await prisma.issue.deleteMany({ where: { id: { in: created } } });
  }
  for (const leave of leavers) await leave();
  await prisma.$disconnect();
});

describe("work that was finished and then reopened", () => {
  it("leaves Completed and rejoins Open, on its current status alone", async () => {
    const now = new Date();

    /* Finished, and credited through the trail the Completed tile reads. */
    const id = await makeIssue({
      title: `Reopened ${Date.now()}`,
      assigneeId: ownerId,
      status: "DONE",
    });
    await prisma.activityLogEntry.create({
      data: {
        issueId: id,
        actorId: ownerId,
        action: "issue.updated",
        field: "status",
        newValue: "DONE",
      },
    });

    expect(await idsIn("completed", now)).toContain(id);
    expect(await idsIn("open", now)).not.toContain(id);

    /* Reopened. The trail still records that it was once Done — that is what
       an append-only trail is for — so this is exactly the case where a
       history-based rule would keep it in Completed for ever. */
    await prisma.issue.update({ where: { id }, data: { status: "TODO" } });

    expect(await idsIn("completed", now)).not.toContain(id);
    expect(await idsIn("open", now)).toContain(id);
  });
});

describe("the overdue day boundary", () => {
  it("is the start of today, so work due later today is not yet overdue", async () => {
    const now = new Date(2026, 8, 9, 16, 45); // A Wednesday afternoon.
    const { startOfToday } = dueWindow(now);

    const yesterday = await makeIssue({
      title: `Due yesterday ${Date.now()}`,
      assigneeId: ownerId,
      dueDate: new Date(startOfToday.getTime() - 1),
    });
    const firstMomentToday = await makeIssue({
      title: `Due at midnight ${Date.now()}`,
      assigneeId: ownerId,
      dueDate: startOfToday,
    });
    const laterToday = await makeIssue({
      title: `Due this evening ${Date.now()}`,
      assigneeId: ownerId,
      dueDate: new Date(startOfToday.getTime() + 20 * 3600_000),
    });
    const undated = await makeIssue({
      title: `No due date ${Date.now()}`,
      assigneeId: ownerId,
      dueDate: null,
    });

    const overdue = await idsIn("overdue", now);

    expect(overdue, "a moment before today is overdue").toContain(yesterday);
    expect(overdue, "the first moment of today is not").not.toContain(
      firstMomentToday,
    );
    expect(overdue, "later today is not").not.toContain(laterToday);
    expect(overdue, "no due date is never overdue").not.toContain(undated);
  });

  it("does not hold finished work, however late it was", async () => {
    const now = new Date(2026, 8, 9, 16, 45);
    const { startOfToday } = dueWindow(now);

    const id = await makeIssue({
      title: `Late but done ${Date.now()}`,
      assigneeId: ownerId,
      status: "DONE",
      dueDate: new Date(startOfToday.getTime() - 7 * 86_400_000),
    });

    expect(await idsIn("overdue", now)).not.toContain(id);
  });
});

describe("a date category is still one person's work", () => {
  it("excludes another person's and nobody's, in both date tiles", async () => {
    const now = new Date(2026, 8, 9, 16, 45);
    const { startOfToday, startOfWeek } = dueWindow(now);
    const late = new Date(startOfToday.getTime() - 86_400_000);

    const theirsOverdue = await makeIssue({
      title: `Their overdue ${Date.now()}`,
      assigneeId: otherId,
      dueDate: late,
    });
    const nobodysOverdue = await makeIssue({
      title: `Unassigned overdue ${Date.now()}`,
      assigneeId: null,
      dueDate: late,
    });
    const theirsThisWeek = await makeIssue({
      title: `Their week ${Date.now()}`,
      assigneeId: otherId,
      dueDate: startOfWeek,
    });
    const nobodysThisWeek = await makeIssue({
      title: `Unassigned week ${Date.now()}`,
      assigneeId: null,
      dueDate: startOfWeek,
    });
    const mineThisWeek = await makeIssue({
      title: `My week ${Date.now()}`,
      assigneeId: ownerId,
      dueDate: startOfWeek,
    });

    const [overdue, dueWeek] = await Promise.all([
      idsIn("overdue", now),
      idsIn("dueWeek", now),
    ]);

    for (const id of [theirsOverdue, nobodysOverdue]) {
      expect(overdue).not.toContain(id);
    }
    for (const id of [theirsThisWeek, nobodysThisWeek]) {
      expect(dueWeek).not.toContain(id);
    }

    /* And the first moment of the week is inside it, so the exclusions above
       are about who holds the work rather than about the date landing out of
       range for everybody. */
    expect(dueWeek).toContain(mineThisWeek);
  });

  it("does not hold finished work in Due this week", async () => {
    const now = new Date(2026, 8, 9, 16, 45);
    const { startOfWeek } = dueWindow(now);

    const id = await makeIssue({
      title: `Done this week ${Date.now()}`,
      assigneeId: ownerId,
      status: "DONE",
      dueDate: startOfWeek,
    });

    expect(await idsIn("dueWeek", now)).not.toContain(id);
  });

  it("ends the week before the next one starts", async () => {
    const now = new Date(2026, 8, 9, 16, 45);
    const { endOfWeek } = dueWindow(now);

    const lastMoment = await makeIssue({
      title: `Last moment ${Date.now()}`,
      assigneeId: ownerId,
      dueDate: new Date(endOfWeek.getTime() - 1),
    });
    const nextWeek = await makeIssue({
      title: `Next week ${Date.now()}`,
      assigneeId: ownerId,
      dueDate: endOfWeek,
    });

    const dueWeek = await idsIn("dueWeek", now);
    expect(dueWeek, "the last moment of the week is in").toContain(lastMoment);
    expect(dueWeek, "the first moment of the next is out").not.toContain(nextWeek);
  });
});
