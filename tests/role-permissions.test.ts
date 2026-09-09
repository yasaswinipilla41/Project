import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { workRoleOf } from "@/lib/authz";
import { createIssue, updateIssue } from "@/server/issues";
import { createSprint, updateSprint, startSprint } from "@/server/sprints";
import { actAs, joinTestingTeam, projectByKey } from "./helpers";

/**
 * Who may do what, asserted against the server rather than the interface.
 *
 * Hiding a control is not a permission, so every case here calls the action
 * directly — the same call a forged request would make. Three people:
 *
 *   an administrator,
 *   a tester   — a member on the Testing team,
 *   a developer — a member who is not.
 *
 * The seed puts nobody on that team, so the tester is made here and the
 * membership is removed again afterwards, leaving the fixture as it was found.
 */

const ADMIN = "admin@symbiosystech.com";
const TESTER = "priya.nair@symbiosystech.com";
const DEVELOPER = "kiran.das@symbiosystech.com";

let leaveTeam: () => Promise<void> = async () => {};
const createdIssueIds: string[] = [];
const createdSprintIds: string[] = [];

beforeAll(async () => {
  ({ leave: leaveTeam } = await joinTestingTeam(TESTER));
});

afterAll(async () => {
  if (createdSprintIds.length > 0) {
    await prisma.sprint.deleteMany({ where: { id: { in: createdSprintIds } } });
  }
  if (createdIssueIds.length > 0) {
    await prisma.notification.deleteMany({
      where: { issueId: { in: createdIssueIds } },
    });
    await prisma.issue.deleteMany({ where: { id: { in: createdIssueIds } } });
  }
  await leaveTeam();
  await prisma.$disconnect();
});

/** An issue in ENG, filed by the administrator, in a given state. */
async function anIssue(
  title: string,
  patch?: {
    assigneeId?: string | null;
    status?: "TODO" | "IN_PROGRESS" | "IN_REVIEW" | "IN_QA";
  },
): Promise<string> {
  await actAs(ADMIN);
  const project = await projectByKey("ENG");
  const result = await createIssue({
    projectId: project.id,
    type: "TASK",
    title,
    description: "fixture",
    priority: "MEDIUM",
  });
  if (!result.ok) throw new Error(result.error);
  createdIssueIds.push(result.data.id);

  if (patch) {
    const applied = await updateIssue({ issueId: result.data.id, ...patch });
    if (!applied.ok) throw new Error(applied.error);
  }
  return result.data.id;
}

async function userId(email: string): Promise<string> {
  const row = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: { id: true },
  });
  return row.id;
}

/* --------------------------------------------------------- role resolution */

describe("who somebody is", () => {
  it("reads the role from Prio's own role and the Testing team", async () => {
    const admin = await actAs(ADMIN);
    expect(await workRoleOf({ ...admin, image: null, jobTitle: null, isActive: true })).toBe("ADMIN");

    const tester = await actAs(TESTER);
    expect(await workRoleOf({ ...tester, image: null, jobTitle: null, isActive: true })).toBe("QA");

    const developer = await actAs(DEVELOPER);
    expect(
      await workRoleOf({ ...developer, image: null, jobTitle: null, isActive: true }),
    ).toBe("DEVELOPER");
  });
});

/* ------------------------------------------------------------- creating work */

describe("raising work", () => {
  it("is refused to a developer", async () => {
    await actAs(DEVELOPER);
    const project = await projectByKey("ENG");

    const result = await createIssue({
      projectId: project.id,
      type: "BUG",
      title: "Developer should not be able to file this",
      description: "x",
      priority: "MEDIUM",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/administrator or a tester/i);

    // Refused means nothing was written.
    const filed = await prisma.issue.count({
      where: { title: "Developer should not be able to file this" },
    });
    expect(filed).toBe(0);
  });

  it("is allowed to a tester", async () => {
    await actAs(TESTER);
    const project = await projectByKey("ENG");

    const result = await createIssue({
      projectId: project.id,
      type: "BUG",
      title: `Tester files work ${Date.now()}`,
      description: "x",
      priority: "MEDIUM",
    });

    expect(result.ok).toBe(true);
    if (result.ok) createdIssueIds.push(result.data.id);
  });
});

/* --------------------------------------------------------------- assignment */

describe("deciding who work belongs to", () => {
  it("lets an administrator assign anybody", async () => {
    const issueId = await anIssue("Assignment — admin assigns");
    await actAs(ADMIN);

    const result = await updateIssue({
      issueId,
      assigneeId: await userId(DEVELOPER),
    });
    expect(result.ok).toBe(true);
  });

  it("refuses a developer assigning somebody else", async () => {
    const issueId = await anIssue("Assignment — developer pushes work");
    await actAs(DEVELOPER);

    const result = await updateIssue({
      issueId,
      assigneeId: await userId(TESTER),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/only an administrator/i);

    const after = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: { assigneeId: true },
    });
    expect(after.assigneeId).toBeNull();
  });

  it("lets a developer take unassigned work for themselves", async () => {
    const issueId = await anIssue("Assignment — developer takes it");
    await actAs(DEVELOPER);

    const result = await updateIssue({
      issueId,
      assigneeId: await userId(DEVELOPER),
    });
    expect(result.ok).toBe(true);
  });

  it("refuses a tester touching the assignee at all", async () => {
    const issueId = await anIssue("Assignment — tester assigns");
    await actAs(TESTER);

    const result = await updateIssue({
      issueId,
      assigneeId: await userId(DEVELOPER),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/only an administrator/i);
  });
});

/* ------------------------------------------------------------------ status */

describe("who may declare what", () => {
  it("refuses a developer putting work into QA or marking it done", async () => {
    const issueId = await anIssue("Status — developer oversteps", {
      status: "IN_PROGRESS",
    });

    await actAs(DEVELOPER);
    for (const status of ["IN_QA", "DONE"] as const) {
      const result = await updateIssue({ issueId, status });
      expect(result.ok, `${status} must be refused`).toBe(false);
    }

    const after = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: { status: true },
    });
    expect(after.status).toBe("IN_PROGRESS");
  });

  it("lets a developer hand work back as Ready for QA", async () => {
    const issueId = await anIssue("Status — developer finishes", {
      status: "IN_PROGRESS",
    });

    await actAs(DEVELOPER);
    const result = await updateIssue({ issueId, status: "IN_REVIEW" });
    expect(result.ok).toBe(true);
  });

  it("lets a tester verify: In QA, then Done", async () => {
    const issueId = await anIssue("Status — tester verifies", {
      status: "IN_REVIEW",
    });

    await actAs(TESTER);
    expect((await updateIssue({ issueId, status: "IN_QA" })).ok).toBe(true);
    expect((await updateIssue({ issueId, status: "DONE" })).ok).toBe(true);

    const after = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: { status: true, completedAt: true },
    });
    expect(after.status).toBe("DONE");
    expect(after.completedAt).not.toBeNull();
  });

  it("lets a tester send failed work back, and not into the backlog", async () => {
    /* Testing found a problem, so the work is not finished. Reopen is how a
       tester says so — it names what happened. The backlog is planning, which
       is an administrator's, so a tester cannot quietly re-file the work as
       something nobody has started. */
    const issueId = await anIssue("Status — tester sends it back", {
      status: "IN_REVIEW",
    });

    await actAs(TESTER);
    await updateIssue({ issueId, status: "IN_QA" });

    const reopened = await updateIssue({ issueId, status: "REOPENED" });
    expect(reopened.ok, "Reopen is a tester's").toBe(true);

    const refused = await updateIssue({ issueId, status: "BACKLOG" });
    expect(refused.ok, "the backlog is an administrator's").toBe(false);
  });

  it("refuses a tester the statuses of the build", async () => {
    /* A tester's four are Ready for QA, In QA, Done and Reopen. What is not
       theirs is the build — New and In Progress say what somebody is working
       on — nor the backlog, nor writing work off. Ready for QA is deliberately
       absent from the refusals: it is the hand-off, and a tester who finds a
       fault hands the work straight back with it. */
    const issueId = await anIssue("Status — tester oversteps", {
      status: "IN_QA",
    });

    await actAs(TESTER);
    for (const status of ["TODO", "IN_PROGRESS", "BACKLOG"] as const) {
      const result = await updateIssue({ issueId, status });
      expect(result.ok, `${status} must be refused`).toBe(false);
    }

    const after = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: { status: true },
    });
    expect(after.status).toBe("IN_QA");
  });

  it("refuses a tester writing work off", async () => {
    /* Not every reported problem is one — but deciding that a piece of work
       will never be done is a call about the plan rather than a verdict about
       the build, so Reject / Not an Issue and Cancelled stay an
       administrator's. A tester says what testing found, and Reopen is how
       they say it. */
    const issueId = await anIssue("Status — tester rejects", { status: "IN_QA" });

    await actAs(TESTER);
    for (const status of ["REJECTED", "CANCELLED"] as const) {
      const result = await updateIssue({ issueId, status });
      expect(result.ok, `${status} must be refused`).toBe(false);
    }
  });

  it("refuses a developer writing work off", async () => {
    const issueId = await anIssue("Status — developer writes off", {
      status: "IN_PROGRESS",
    });

    await actAs(DEVELOPER);
    /* Reopen is deliberately absent: work that came back is a developer's to
       pick up again, so Reopen sits in the build half as well. What a
       developer may not do is decide the work is finished with — that, and
       what sits in the backlog, are an administrator's. */
    for (const status of ["REJECTED", "CANCELLED", "BACKLOG"] as const) {
      const result = await updateIssue({ issueId, status });
      expect(result.ok, `${status} must be refused`).toBe(false);
    }

    const reopened = await updateIssue({ issueId, status: "REOPENED" });
    expect(reopened.ok, "Reopen is a developer's").toBe(true);
  });

  it("refuses a tester marking work done that was never tested", async () => {
    /* Done is what testing concluded, so it follows In QA. This is the rule
       that stops the whole verification step being skipped. */
    const issueId = await anIssue("Status — done without testing", {
      status: "IN_REVIEW",
    });

    await actAs(TESTER);
    const straight = await updateIssue({ issueId, status: "DONE" });
    expect(straight.ok).toBe(false);
    if (!straight.ok) expect(straight.error).toMatch(/in qa/i);

    // …and through In QA it is allowed, which is the workflow itself.
    expect((await updateIssue({ issueId, status: "IN_QA" })).ok).toBe(true);
    expect((await updateIssue({ issueId, status: "DONE" })).ok).toBe(true);
  });
});

/* ---------------------------------------------------------- the round trip */

describe("the workflow, walked end to end", () => {
  it("passes: built, handed over, tested, done", async () => {
    /* The whole of the successful path, each step taken by the person whose
       step it is. Nothing here is a new rule — it is the rules already
       asserted above, walked in order, which is the thing a reader wants to
       see once. */
    const issueId = await anIssue("Round trip — passes", { status: "IN_PROGRESS" });

    await actAs(DEVELOPER);
    expect((await updateIssue({ issueId, status: "IN_REVIEW" })).ok).toBe(true);

    await actAs(TESTER);
    expect((await updateIssue({ issueId, status: "IN_QA" })).ok).toBe(true);
    expect((await updateIssue({ issueId, status: "DONE" })).ok).toBe(true);

    const after = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: { status: true, completedAt: true },
    });
    expect(after.status).toBe("DONE");
    expect(after.completedAt).not.toBeNull();
  });

  it("fails: tested, sent back, fixed, handed back, and done the second time", async () => {
    const issueId = await anIssue("Round trip — fails first", {
      status: "IN_PROGRESS",
    });

    await actAs(DEVELOPER);
    expect((await updateIssue({ issueId, status: "IN_REVIEW" })).ok).toBe(true);

    // Testing finds a problem, so the work is reopened: it is not finished,
    // and Reopen is what says so.
    await actAs(TESTER);
    expect((await updateIssue({ issueId, status: "IN_QA" })).ok).toBe(true);
    expect((await updateIssue({ issueId, status: "REOPENED" })).ok).toBe(true);

    // …which is the developer's again: they take it back into the build.
    await actAs(DEVELOPER);
    expect((await updateIssue({ issueId, status: "IN_PROGRESS" })).ok).toBe(true);
    expect((await updateIssue({ issueId, status: "IN_REVIEW" })).ok).toBe(true);

    // Second time through, it passes.
    await actAs(TESTER);
    expect((await updateIssue({ issueId, status: "IN_QA" })).ok).toBe(true);
    expect((await updateIssue({ issueId, status: "DONE" })).ok).toBe(true);

    const trail = await prisma.activityLogEntry.findMany({
      where: { issueId, field: "status" },
      orderBy: { createdAt: "asc" },
      select: { newValue: true },
    });
    expect(trail.map((row) => row.newValue)).toEqual([
      "IN_PROGRESS",
      "IN_REVIEW",
      "IN_QA",
      "REOPENED",
      "IN_PROGRESS",
      "IN_REVIEW",
      "IN_QA",
      "DONE",
    ]);
  });

  it("cannot be short-circuited: the tester's Done needs the In QA before it", async () => {
    const issueId = await anIssue("Round trip — no shortcut", {
      status: "IN_PROGRESS",
    });

    await actAs(DEVELOPER);
    await updateIssue({ issueId, status: "IN_REVIEW" });

    await actAs(TESTER);
    const straight = await updateIssue({ issueId, status: "DONE" });
    expect(straight.ok).toBe(false);

    const after = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: { status: true },
    });
    expect(after.status).toBe("IN_REVIEW");
  });
});

/* ----------------------------------------------------------------- sprints */

describe("sprints", () => {
  it("are an administrator's to create", async () => {
    await actAs(ADMIN);
    const project = await projectByKey("ENG");

    const result = await createSprint({
      projectId: project.id,
      name: `Role sprint ${Date.now()}`,
      goal: "fixture",
      startDate: new Date().toISOString(),
      endDate: new Date(Date.now() + 7 * 864e5).toISOString(),
    });

    expect(result.ok).toBe(true);
    if (result.ok) createdSprintIds.push(result.data.id);
  });

  for (const [who, email] of [
    ["a developer", DEVELOPER],
    ["a tester", TESTER],
  ] as const) {
    it(`cannot be created by ${who}`, async () => {
      await actAs(email);
      const project = await projectByKey("ENG");

      const result = await createSprint({
        projectId: project.id,
        name: `Forbidden sprint ${Date.now()}`,
        goal: "x",
        startDate: new Date().toISOString(),
        endDate: new Date(Date.now() + 7 * 864e5).toISOString(),
      });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/administrator/i);
    });

    it(`cannot be edited or started by ${who}`, async () => {
      const sprintId = createdSprintIds[0];
      expect(sprintId, "the admin sprint above exists").toBeTruthy();

      await actAs(email);
      expect((await updateSprint({ sprintId: sprintId!, name: "renamed" })).ok).toBe(
        false,
      );
      expect((await startSprint({ sprintId: sprintId! })).ok).toBe(false);

      // …and the sprint is untouched.
      const after = await prisma.sprint.findUniqueOrThrow({
        where: { id: sprintId! },
        select: { name: true, status: true },
      });
      expect(after.name).not.toBe("renamed");
      expect(after.status).toBe("PLANNED");
    });
  }

  it("stay readable to everybody who can open the project", async () => {
    const sprintId = createdSprintIds[0]!;
    for (const email of [DEVELOPER, TESTER]) {
      await actAs(email);
      const visible = await prisma.sprint.findUnique({
        where: { id: sprintId },
        select: { name: true, goal: true, startDate: true, status: true },
      });
      expect(visible, `${email} can read the sprint`).not.toBeNull();
    }
  });
});
