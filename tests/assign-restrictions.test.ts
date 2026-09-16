import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEVELOPMENT_TEAM_SLUG,
  FULLSTACK_TEAM_SLUG,
  TESTING_TEAM_SLUG,
  workRoleOf,
} from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { claimIssue, createIssue, updateIssue } from "@/server/issues";
import { actAs, projectByKey } from "./helpers";

/**
 * Who decides whom a piece of work belongs to.
 *
 * An administrator, and nobody else. Everybody who builds may still take work
 * *for themselves* and put down work that is already theirs — neither of those
 * puts somebody else's name on an issue, which is the thing being withheld.
 *
 * A developer used to be able to hand their own work to a tester, and that is
 * what has gone. The hand-off it existed for still happens: marking work Ready
 * for QA returns it to the tester who raised it, decided on the server, with
 * nobody naming a recipient.
 *
 * Every case calls `updateIssue` directly — the same call a forged request
 * makes — because a hidden control is not a rule.
 */

const ADMIN = "admin@symbiosystech.com";
const DEVELOPER = "kiran.das@symbiosystech.com";
const OTHER_DEVELOPER = "vikram.shetty@symbiosystech.com";
const TESTER = "priya.nair@symbiosystech.com";
const FULLSTACK = "meera.pillai@symbiosystech.com";

const created: string[] = [];
const teamRows: string[] = [];
const suspended: { teamId: string; userId: string }[] = [];
let projectId = "";

const TEAM_NAMES: Record<string, string> = {
  [TESTING_TEAM_SLUG]: "Testing",
  [DEVELOPMENT_TEAM_SLUG]: "Development",
  [FULLSTACK_TEAM_SLUG]: "Full Stack Developers",
};

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

const idOf = async (email: string) => (await userByEmail(email)).id;

async function join(email: string, slug: string): Promise<void> {
  const [user, team] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } }),
    prisma.team.upsert({
      where: { slug },
      update: {},
      create: { slug, name: TEAM_NAMES[slug] ?? slug },
      select: { id: true },
    }),
  ]);
  const existing = await prisma.teamMember.findFirst({
    where: { teamId: team.id, userId: user.id },
    select: { id: true },
  });
  if (existing) return;

  const row = await prisma.teamMember.create({
    data: { teamId: team.id, userId: user.id },
    select: { id: true },
  });
  teamRows.push(row.id);
}

async function leaveFor(email: string, slug: string): Promise<void> {
  const [user, team] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } }),
    prisma.team.findUnique({ where: { slug }, select: { id: true } }),
  ]);
  if (!team) return;

  const existing = await prisma.teamMember.findFirst({
    where: { teamId: team.id, userId: user.id },
    select: { id: true },
  });
  if (!existing) return;

  await prisma.teamMember.delete({ where: { id: existing.id } });
  suspended.push({ teamId: team.id, userId: user.id });
}

/** An ENG task held by `holder`, filed by the administrator. */
async function anIssue(title: string, holder?: string): Promise<string> {
  await actAs(ADMIN);
  const result = await createIssue({
    projectId,
    type: "TASK",
    title: `${title} ${Date.now()}-${Math.random()}`,
    description: "fixture",
    priority: "MEDIUM",
    status: "TODO",
    assigneeId: holder,
  });
  if (!result.ok) throw new Error(result.error);
  created.push(result.data.id);
  return result.data.id;
}

const assigneeOf = async (issueId: string) =>
  (
    await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: { assigneeId: true },
    })
  ).assigneeId;

beforeAll(async () => {
  projectId = (await projectByKey("ENG")).id;

  await leaveFor(DEVELOPER, TESTING_TEAM_SLUG);
  await leaveFor(DEVELOPER, FULLSTACK_TEAM_SLUG);
  await join(DEVELOPER, DEVELOPMENT_TEAM_SLUG);

  await leaveFor(OTHER_DEVELOPER, TESTING_TEAM_SLUG);
  await leaveFor(OTHER_DEVELOPER, FULLSTACK_TEAM_SLUG);
  await join(OTHER_DEVELOPER, DEVELOPMENT_TEAM_SLUG);

  await leaveFor(TESTER, DEVELOPMENT_TEAM_SLUG);
  await leaveFor(TESTER, FULLSTACK_TEAM_SLUG);
  await join(TESTER, TESTING_TEAM_SLUG);

  await leaveFor(FULLSTACK, TESTING_TEAM_SLUG);
  await leaveFor(FULLSTACK, DEVELOPMENT_TEAM_SLUG);
  await join(FULLSTACK, FULLSTACK_TEAM_SLUG);

  for (const email of [DEVELOPER, OTHER_DEVELOPER, TESTER, FULLSTACK]) {
    await prisma.projectMember.upsert({
      where: { projectId_userId: { projectId, userId: await idOf(email) } },
      update: {},
      create: { projectId, userId: await idOf(email) },
    });
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
  if (teamRows.length > 0) {
    await prisma.teamMember.deleteMany({ where: { id: { in: teamRows } } });
  }
  for (const row of suspended) {
    await prisma.teamMember.upsert({
      where: { teamId_userId: { teamId: row.teamId, userId: row.userId } },
      update: {},
      create: { teamId: row.teamId, userId: row.userId },
    });
  }
  await prisma.$disconnect();
});

describe("a developer", () => {
  it("resolves to DEVELOPER", async () => {
    expect(await workRoleOf(await userByEmail(DEVELOPER))).toBe("DEVELOPER");
  });

  it("cannot hand work they hold to a tester", async () => {
    const issueId = await anIssue("Developer to tester", await idOf(DEVELOPER));

    await actAs(DEVELOPER);
    const result = await updateIssue({
      issueId,
      assigneeId: await idOf(TESTER),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/only an administrator/i);
    expect(await assigneeOf(issueId)).toBe(await idOf(DEVELOPER));
  });

  it("cannot hand work they hold to another developer", async () => {
    const issueId = await anIssue("Developer to developer", await idOf(DEVELOPER));

    await actAs(DEVELOPER);
    const result = await updateIssue({
      issueId,
      assigneeId: await idOf(OTHER_DEVELOPER),
    });

    expect(result.ok).toBe(false);
    expect(await assigneeOf(issueId)).toBe(await idOf(DEVELOPER));
  });

  it("cannot reassign work somebody else holds", async () => {
    const issueId = await anIssue("Not theirs", await idOf(OTHER_DEVELOPER));

    await actAs(DEVELOPER);
    const result = await updateIssue({
      issueId,
      assigneeId: await idOf(TESTER),
    });

    expect(result.ok).toBe(false);
    expect(await assigneeOf(issueId)).toBe(await idOf(OTHER_DEVELOPER));
  });

  it("may still take unassigned work for themselves", async () => {
    /* The permission being withheld is naming *somebody else*. Picking work up
       is untouched, and is how a developer gets work at all. */
    const issueId = await anIssue("Developer claims");

    await actAs(DEVELOPER);
    expect((await claimIssue({ issueId })).ok).toBe(true);
    expect(await assigneeOf(issueId)).toBe(await idOf(DEVELOPER));
  });

  it("may still put down work that is their own", async () => {
    const issueId = await anIssue("Developer puts down", await idOf(DEVELOPER));

    await actAs(DEVELOPER);
    const result = await updateIssue({ issueId, assigneeId: null });

    expect(result.ok, result.ok ? "" : result.error).toBe(true);
    expect(await assigneeOf(issueId)).toBeNull();
  });
});

describe("a full stack developer", () => {
  it("resolves to FULLSTACK", async () => {
    expect(await workRoleOf(await userByEmail(FULLSTACK))).toBe("FULLSTACK");
  });

  it("cannot hand work they hold to a tester", async () => {
    const issueId = await anIssue("Full stack to tester", await idOf(FULLSTACK));

    await actAs(FULLSTACK);
    const result = await updateIssue({
      issueId,
      assigneeId: await idOf(TESTER),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/only an administrator/i);
    expect(await assigneeOf(issueId)).toBe(await idOf(FULLSTACK));
  });

  it("cannot hand work they hold to a developer", async () => {
    const issueId = await anIssue("Full stack to developer", await idOf(FULLSTACK));

    await actAs(FULLSTACK);
    const result = await updateIssue({
      issueId,
      assigneeId: await idOf(DEVELOPER),
    });

    expect(result.ok).toBe(false);
    expect(await assigneeOf(issueId)).toBe(await idOf(FULLSTACK));
  });

  it("may still take unassigned work for themselves", async () => {
    const issueId = await anIssue("Full stack claims");

    await actAs(FULLSTACK);
    expect((await claimIssue({ issueId })).ok).toBe(true);
    expect(await assigneeOf(issueId)).toBe(await idOf(FULLSTACK));
  });
});

describe("the roles whose assignment is unchanged", () => {
  it("still lets an administrator assign anybody", async () => {
    const issueId = await anIssue("Admin assigns");

    await actAs(ADMIN);
    const result = await updateIssue({
      issueId,
      assigneeId: await idOf(DEVELOPER),
    });

    expect(result.ok, result.ok ? "" : result.error).toBe(true);
    expect(await assigneeOf(issueId)).toBe(await idOf(DEVELOPER));
  });

  it("still refuses a tester the assignee entirely", async () => {
    /* Unchanged, and unchanged for its own reason: a tester raises work and
       verifies it, and has never decided who builds it. */
    const issueId = await anIssue("Tester assigns", await idOf(TESTER));

    await actAs(TESTER);
    const result = await updateIssue({
      issueId,
      assigneeId: await idOf(DEVELOPER),
    });

    expect(result.ok).toBe(false);
    expect(await assigneeOf(issueId)).toBe(await idOf(TESTER));
  });
});

describe("the rule is the server's", () => {
  it("ignores a role and an actor supplied by the caller", async () => {
    const issueId = await anIssue("Forged assignment", await idOf(DEVELOPER));

    await actAs(DEVELOPER);
    const result = await updateIssue({
      issueId,
      assigneeId: await idOf(TESTER),
      workRole: "ADMIN",
      role: "ADMIN",
      isAdmin: true,
      userId: await idOf(ADMIN),
    } as unknown);

    expect(result.ok).toBe(false);
    expect(await assigneeOf(issueId)).toBe(await idOf(DEVELOPER));
  });
});
