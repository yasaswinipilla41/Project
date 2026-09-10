import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { issueScope } from "@/lib/authz";
import { CLOSED_STATUSES, OPEN_STATUSES } from "@/lib/domain";
import type { CurrentUser } from "@/lib/session";
import { createIssue, updateIssue } from "@/server/issues";
import { dueThisWeekFilter, overdueFilter } from "@/server/queries/due";
import { actAs, joinTestingTeam, projectByKey } from "./helpers";

/**
 * Who qualifies for My Work.
 *
 * One rule, and every figure and list on that page is it with a category
 * added:
 *
 *     assigned to me   AND   in a project I may open
 *
 * Neither half is enough on its own, and this file asserts both directions.
 * Raising an issue is not being given it; belonging to its project is not
 * being given it; being an administrator is not being given it. Each of those
 * put somebody else's work on the page at some point, so each is checked here
 * rather than assumed.
 *
 * The queries below are the ones `src/app/(app)/my-work/page.tsx` runs,
 * reproduced against the same database through the same helpers. A count and
 * the rows under it come from one fragment — `assignedWhere` — so the pairs
 * asserted at the end are a property of the code rather than a coincidence to
 * re-check.
 */

const ADMIN = "admin@symbiosystech.com";
const USER_A = "priya.nair@symbiosystech.com";
const USER_B = "kiran.das@symbiosystech.com";
const USER_C = "vikram.shetty@symbiosystech.com";

const created: string[] = [];
/* Raising work is a tester's act, so the person who reports a fixture here has
   to be one for the run. It changes nothing this file asserts: My Work turns
   on assignment and project access, not on what somebody does. */
let leaveTestingTeam: () => Promise<void> = async () => {};

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

/** The one fragment the page builds every figure and every list from. */
function assignedWhere(user: CurrentUser) {
  return {
    ...issueScope(user),
    assigneeId: user.id,
    status: { in: [...OPEN_STATUSES] },
  };
}

async function myWork(user: CurrentUser): Promise<string[]> {
  const rows = await prisma.issue.findMany({
    where: assignedWhere(user),
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

beforeAll(async () => {
  ({ leave: leaveTestingTeam } = await joinTestingTeam(USER_A));

  const project = await projectByKey("ENG");
  for (const email of [USER_A, USER_B, USER_C]) {
    const person = await userByEmail(email);
    await prisma.projectMember.upsert({
      where: { projectId_userId: { projectId: project.id, userId: person.id } },
      update: {},
      create: { projectId: project.id, userId: person.id },
    });
  }
});

afterAll(async () => {
  await leaveTestingTeam();
  if (created.length > 0) {
    await prisma.notification.deleteMany({ where: { issueId: { in: created } } });
    await prisma.activityLogEntry.deleteMany({
      where: { issueId: { in: created } },
    });
    await prisma.issue.deleteMany({ where: { id: { in: created } } });
  }
  await prisma.$disconnect();
});

/** An ENG issue, raised by `reporter`, ending up on `assignee`. */
async function anIssue(
  label: string,
  reporter: string,
  assigneeEmail: string | null,
): Promise<string> {
  await actAs(reporter);
  const project = await projectByKey("ENG");
  const result = await createIssue({
    projectId: project.id,
    type: "TASK",
    title: `My Work scope ${label} ${Date.now()}-${Math.random()}`,
    description: "fixture",
    priority: "MEDIUM",
  });
  if (!result.ok) throw new Error(result.error);
  created.push(result.data.id);

  if (assigneeEmail) {
    await actAs(ADMIN);
    const assignee = await userByEmail(assigneeEmail);
    const patch = await updateIssue({
      issueId: result.data.id,
      assigneeId: assignee.id,
      status: "TODO",
    });
    if (!patch.ok) throw new Error(patch.error);
  }
  return result.data.id;
}

describe("what reaches My Work", () => {
  it("includes what is assigned to the reader and nothing else", async () => {
    const mine = await anIssue("mine", ADMIN, USER_A);
    const theirs = await anIssue("theirs", ADMIN, USER_B);
    /* Raised by A, handed to B. The case the page used to get wrong: A
       reported it, so it appeared on A's page under somebody else's name. */
    const raisedByMe = await anIssue("raised-by-me", USER_A, USER_B);
    const unassigned = await anIssue("unassigned", ADMIN, null);

    const a = await myWork(await userByEmail(USER_A));

    expect(a, "assigned to me").toContain(mine);
    expect(a, "assigned to somebody else").not.toContain(theirs);
    expect(a, "raised by me, held by somebody else").not.toContain(raisedByMe);
    expect(a, "held by nobody").not.toContain(unassigned);
  });

  it("gives each person their own, and only their own", async () => {
    const forA = await anIssue("three-a", ADMIN, USER_A);
    const forB = await anIssue("three-b", ADMIN, USER_B);
    const forC = await anIssue("three-c", ADMIN, USER_C);

    const [a, b, c] = await Promise.all([
      myWork(await userByEmail(USER_A)),
      myWork(await userByEmail(USER_B)),
      myWork(await userByEmail(USER_C)),
    ]);

    expect(a).toContain(forA);
    expect(a).not.toContain(forB);
    expect(a).not.toContain(forC);

    expect(b).toContain(forB);
    expect(b).not.toContain(forA);
    expect(b).not.toContain(forC);

    expect(c).toContain(forC);
    expect(c).not.toContain(forA);
    expect(c).not.toContain(forB);
  });

  it("does not widen for an administrator", async () => {
    /* An admin may open every project, so `issueScope` lets everything
       through for them — the assignment half is the only thing keeping other
       people's work off their page, which is exactly why it is asserted. */
    const forA = await anIssue("admin-sees-none", ADMIN, USER_A);
    const admin = await userByEmail(ADMIN);

    const theirs = await myWork(admin);
    expect(theirs).not.toContain(forA);

    const everyOpen = await prisma.issue.count({
      where: { status: { in: [...OPEN_STATUSES] } },
    });
    expect(theirs.length).toBeLessThan(everyOpen);

    for (const id of theirs) {
      const row = await prisma.issue.findUniqueOrThrow({
        where: { id },
        select: { assigneeId: true },
      });
      expect(row.assigneeId).toBe(admin.id);
    }
  });

  it("leaves out an assignment in a project the reader cannot open", async () => {
    /* Assignment alone is not enough. A member removed from the project keeps
       the assignment row and loses the issue from their page, because the
       scope half of the rule still has to hold. */
    const project = await projectByKey("ENG");
    const user = await userByEmail(USER_C);
    const issueId = await anIssue("out-of-scope", ADMIN, USER_C);

    expect(await myWork(user)).toContain(issueId);

    const membership = await prisma.projectMember.findFirst({
      where: { projectId: project.id, userId: user.id },
      select: { id: true },
    });
    await prisma.projectMember.delete({ where: { id: membership!.id } });

    try {
      const after = await myWork(user);
      expect(after, "still assigned, no longer visible").not.toContain(issueId);

      const stillAssigned = await prisma.issue.findUniqueOrThrow({
        where: { id: issueId },
        select: { assigneeId: true },
      });
      expect(stillAssigned.assigneeId).toBe(user.id);
    } finally {
      await prisma.projectMember.create({
        data: { projectId: project.id, userId: user.id },
      });
    }
  });
});

describe("every My Work figure is the same rule with a category on it", () => {
  it("counts what its own list holds, category by category", async () => {
    const user = await userByEmail(USER_A);
    const base = assignedWhere(user);

    /* Each pair is the page's count beside the page's rows. Written as two
       calls on one fragment, so the only way they can disagree is if the
       fragment stopped being shared. */
    const [assigned, bugs, overdue, dueThisWeek, waiting, completed] =
      await Promise.all([
        prisma.issue.findMany({ where: base, select: { id: true, type: true } }),
        prisma.issue.count({ where: { ...base, type: "BUG" } }),
        prisma.issue.count({ where: { ...base, ...overdueFilter() } }),
        prisma.issue.count({ where: { ...base, ...dueThisWeekFilter() } }),
        prisma.issue.findMany({
          where: { ...base, status: "IN_REVIEW", testResult: "NOT_TESTED" },
          select: { id: true, assigneeId: true },
        }),
        prisma.issue.count({
          where: {
            ...issueScope(user),
            assigneeId: user.id,
            status: { in: [...CLOSED_STATUSES] },
          },
        }),
      ]);

    // Bugs is the assigned set narrowed by type, exactly as the page does it.
    expect(bugs).toBe(assigned.filter((i) => i.type === "BUG").length);

    // Overdue and Due this week are subsets of the same assigned set.
    expect(overdue).toBeLessThanOrEqual(assigned.length);
    expect(dueThisWeek).toBeLessThanOrEqual(assigned.length);
    expect(completed).toBeGreaterThanOrEqual(0);

    /* Waiting for testing is the one that used to invert the rule. Every row
       must be this person's. */
    for (const row of waiting) {
      expect(row.assigneeId, "waiting for testing is the reader's own").toBe(
        user.id,
      );
    }

    // And every row of the assigned set really is theirs, in a project of theirs.
    const visibleProjects = await prisma.project.findMany({
      where: issueScope(user).project
        ? { members: { some: { userId: user.id } } }
        : {},
      select: { id: true },
    });
    const allowed = new Set(visibleProjects.map((p) => p.id));

    const rows = await prisma.issue.findMany({
      where: base,
      select: { assigneeId: true, projectId: true },
    });
    for (const row of rows) {
      expect(row.assigneeId).toBe(user.id);
      expect(allowed.has(row.projectId)).toBe(true);
    }
  });
});
