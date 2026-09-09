import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEVELOPMENT_TEAM_SLUG,
  TESTING_TEAM_SLUG,
  workRoleOf,
} from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { claimIssue, createIssue, updateIssue } from "@/server/issues";
import { createSprint } from "@/server/sprints";
import { actAs, projectByKey } from "./helpers";

/**
 * The Full Stack Developer: both jobs at once, and neither of them silently.
 *
 * The rule this file exists to defend is that Testing + Development is *not*
 * resolved in one side's favour. Somebody on both teams builds and checks, so
 * every capability a pure tester has and every capability a pure developer has
 * must hold for them — and the two restrictions that make those roles distinct
 * must hold for nobody else.
 *
 * Asserted against the server actions directly, never against the interface. A
 * hidden button is not a permission, and the whole point of the matrix below is
 * what happens when the button is bypassed.
 *
 * The seed puts nobody on either team, so all three people are made here and
 * every membership is removed again afterwards.
 */

const ADMIN = "admin@symbiosystech.com";
/** On Testing only. */
const TESTER = "priya.nair@symbiosystech.com";
/** On neither team — a developer by the long-standing default. */
const DEVELOPER = "kiran.das@symbiosystech.com";
/** On both teams. */
const FULLSTACK = "meera.pillai@symbiosystech.com";

const createdIssueIds: string[] = [];
const createdSprintIds: string[] = [];
const memberships: string[] = [];

async function userId(email: string): Promise<string> {
  const row = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: { id: true },
  });
  return row.id;
}

async function join(email: string, slug: string): Promise<void> {
  const [user, team] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } }),
    prisma.team.findUniqueOrThrow({ where: { slug }, select: { id: true } }),
  ]);
  const row = await prisma.teamMember.upsert({
    where: { teamId_userId: { teamId: team.id, userId: user.id } },
    update: {},
    create: { teamId: team.id, userId: user.id },
    select: { id: true },
  });
  memberships.push(row.id);
}

/** An issue in ENG, filed by the administrator, optionally moved on. */
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

const suspended: { teamId: string; userId: string }[] = [];

/**
 * Takes somebody off a team for the run, remembering to put them back.
 *
 * This file turns on the difference between a pure tester and somebody who
 * also builds, so the pure one has to actually be pure. A Development row left
 * behind by another suite would make them full stack and every "still refuses
 * a pure tester…" case below would pass for the wrong reason.
 */
async function leaveFor(email: string, slug: string): Promise<void> {
  const [user, team] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } }),
    prisma.team.findUniqueOrThrow({ where: { slug }, select: { id: true } }),
  ]);
  const existing = await prisma.teamMember.findFirst({
    where: { teamId: team.id, userId: user.id },
    select: { id: true },
  });
  if (!existing) return;

  await prisma.teamMember.delete({ where: { id: existing.id } });
  suspended.push({ teamId: team.id, userId: user.id });
}

beforeAll(async () => {
  await leaveFor(TESTER, DEVELOPMENT_TEAM_SLUG);
  await join(TESTER, TESTING_TEAM_SLUG);
  await join(FULLSTACK, TESTING_TEAM_SLUG);
  await join(FULLSTACK, DEVELOPMENT_TEAM_SLUG);

  /* Everybody involved must be able to open the project they are working in;
     team membership grants no project access on its own. */
  const project = await projectByKey("ENG");
  for (const email of [TESTER, DEVELOPER, FULLSTACK]) {
    await prisma.projectMember.upsert({
      where: {
        projectId_userId: { projectId: project.id, userId: await userId(email) },
      },
      update: {},
      create: { projectId: project.id, userId: await userId(email) },
    });
  }
});

afterAll(async () => {
  for (const row of suspended) {
    await prisma.teamMember.upsert({
      where: { teamId_userId: { teamId: row.teamId, userId: row.userId } },
      update: {},
      create: { teamId: row.teamId, userId: row.userId },
    });
  }
  if (createdSprintIds.length > 0) {
    await prisma.sprint.deleteMany({ where: { id: { in: createdSprintIds } } });
  }
  if (createdIssueIds.length > 0) {
    await prisma.notification.deleteMany({
      where: { issueId: { in: createdIssueIds } },
    });
    await prisma.activityLogEntry.deleteMany({
      where: { issueId: { in: createdIssueIds } },
    });
    await prisma.issue.deleteMany({ where: { id: { in: createdIssueIds } } });
  }
  if (memberships.length > 0) {
    await prisma.teamMember.deleteMany({ where: { id: { in: memberships } } });
  }
  await prisma.$disconnect();
});

describe("who a full stack developer is", () => {
  it("resolves to FULLSTACK, not to either half", async () => {
    const person = await prisma.user.findUniqueOrThrow({
      where: { email: FULLSTACK },
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

    const role = await workRoleOf(person);
    expect(role).toBe("FULLSTACK");
    expect(role).not.toBe("QA");
    expect(role).not.toBe("DEVELOPER");
  });
});

describe("the QA half", () => {
  it("lets a full stack developer raise work, as a tester may", async () => {
    await actAs(FULLSTACK);
    const project = await projectByKey("ENG");

    const result = await createIssue({
      projectId: project.id,
      type: "BUG",
      title: `Full stack files work ${createdIssueIds.length}`,
      description: "x",
      priority: "MEDIUM",
    });

    expect(result.ok).toBe(true);
    if (result.ok) createdIssueIds.push(result.data.id);
  });

  it("lets them verify: In QA, then Done", async () => {
    const issueId = await anIssue("Full stack verifies", {
      assigneeId: await userId(FULLSTACK),
      status: "IN_REVIEW",
    });

    await actAs(FULLSTACK);
    const intoQa = await updateIssue({ issueId, status: "IN_QA" });
    expect(intoQa.ok).toBe(true);

    const done = await updateIssue({ issueId, status: "DONE" });
    expect(done.ok).toBe(true);
  });

  it("still refuses a pure developer those same declarations", async () => {
    /* The restriction that makes DEVELOPER distinct must survive: full stack
       gaining the capability must not have handed it to everybody. */
    const issueId = await anIssue("Developer may not verify", {
      assigneeId: await userId(DEVELOPER),
      status: "IN_REVIEW",
    });

    await actAs(DEVELOPER);
    const intoQa = await updateIssue({ issueId, status: "IN_QA" });
    expect(intoQa.ok).toBe(false);
    if (!intoQa.ok) expect(intoQa.error).toMatch(/tester or an administrator/i);
  });

  it("still refuses a pure developer raising work", async () => {
    await actAs(DEVELOPER);
    const project = await projectByKey("ENG");

    const result = await createIssue({
      projectId: project.id,
      type: "BUG",
      title: "Developer still may not file this",
      description: "x",
      priority: "MEDIUM",
    });

    expect(result.ok).toBe(false);
    expect(
      await prisma.issue.count({
        where: { title: "Developer still may not file this" },
      }),
    ).toBe(0);
  });
});

describe("the developer half", () => {
  it("lets a full stack developer claim unassigned work", async () => {
    const issueId = await anIssue("Full stack claims", { status: "TODO" });

    await actAs(FULLSTACK);
    const claimed = await claimIssue({ issueId });
    expect(claimed.ok).toBe(true);

    const after = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: { assigneeId: true },
    });
    expect(after.assigneeId).toBe(await userId(FULLSTACK));
  });

  it("lets them hand work back as Ready for QA", async () => {
    const issueId = await anIssue("Full stack hands back", {
      assigneeId: await userId(FULLSTACK),
      status: "IN_PROGRESS",
    });

    await actAs(FULLSTACK);
    const handedBack = await updateIssue({ issueId, status: "IN_REVIEW" });
    expect(handedBack.ok).toBe(true);
  });

  it("still refuses a pure tester claiming development work", async () => {
    const issueId = await anIssue("Tester may not claim", { status: "TODO" });

    await actAs(TESTER);
    const claimed = await claimIssue({ issueId });
    expect(claimed.ok).toBe(false);
    if (!claimed.ok) expect(claimed.error).toMatch(/do not take development/i);

    const after = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: { assigneeId: true },
    });
    expect(after.assigneeId).toBeNull();
  });

  it("still refuses a pure tester the statuses of the build", async () => {
    /* Ready for QA is a tester's to say as well — asking for something to be
       checked is not a claim about who wrote it. What stays the developer
       half's alone is the build itself: moving work back into Backlog, New or
       In Progress is a decision about what is being worked on next, and a
       tester hands work back by reopening it instead. */
    const issueId = await anIssue("Tester may not move the build", {
      status: "IN_QA",
    });

    await actAs(TESTER);
    /* Ready for QA is not among these: it is the hand-off, shared by both
       halves, and a tester who finds a fault hands the work straight back
       with it. What stays the build's is New and In Progress. */
    for (const status of ["TODO", "IN_PROGRESS"] as const) {
      const result = await updateIssue({ issueId, status });
      expect(result.ok, `${status} must be refused`).toBe(false);
    }

    const after = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: { status: true },
    });
    expect(after.status).toBe("IN_QA");
  });

  it("lets a full stack developer move work back into the build", async () => {
    const issueId = await anIssue("Full stack reworks", { status: "IN_QA" });

    await actAs(FULLSTACK);
    const result = await updateIssue({ issueId, status: "IN_PROGRESS" });
    expect(result.ok).toBe(true);
  });
});

describe("what full stack is not", () => {
  it("does not confer administration", async () => {
    /* Two member jobs, and neither of them is ADMIN. Sprints are the clearest
       admin-only surface, so they are the one asked. */
    await actAs(FULLSTACK);
    const project = await projectByKey("ENG");

    const result = await createSprint({
      projectId: project.id,
      name: `Full stack should not create ${Date.now()}`,
      goal: "x",
    });

    expect(result.ok).toBe(false);

    const leaked = await prisma.sprint.findFirst({
      where: { name: { startsWith: "Full stack should not create" } },
      select: { id: true },
    });
    if (leaked) createdSprintIds.push(leaked.id);
    expect(leaked).toBeNull();
  });

  it("does not let them assign work to somebody else", async () => {
    /* Taking work for yourself is a developer's act; deciding who else does it
       is an administrator's. Full stack gets the first and not the second. */
    const issueId = await anIssue("Full stack may not reassign", {
      status: "TODO",
    });

    await actAs(FULLSTACK);
    const result = await updateIssue({
      issueId,
      assigneeId: await userId(DEVELOPER),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/only an administrator/i);
  });
});
