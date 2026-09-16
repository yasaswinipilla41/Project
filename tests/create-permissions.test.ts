import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEVELOPMENT_TEAM_SLUG,
  FULLSTACK_TEAM_SLUG,
  TESTING_TEAM_SLUG,
  workRoleOf,
} from "@/lib/authz";
import {
  ISSUE_TYPES,
  canCreateSprint,
  canCreateWorkItem,
  creatableWorkItems,
  type WorkRole,
} from "@/lib/domain";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { createIssue } from "@/server/issues";
import { createSprint } from "@/server/sprints";
import { actAs, projectByKey } from "./helpers";

/**
 * Who may raise what.
 *
 * The approved matrix, asserted twice over: once against the table itself, and
 * once against the server actions a browser actually calls. Both matter — the
 * table is what the create menu draws from, and the actions are what stop a
 * request that never went near a menu.
 *
 *   every working role   →  Task, Bug, Story, Epic, Feature
 *   administrators only  →  Sprint
 *
 * Note what a row is. Prio has no `ISSUE` type: an issue is the record, and
 * those five are what it can be — a Bug is `Issue.type = BUG` and stays its own
 * kind of thing. "Create an issue" and "create a bug" are one act with a
 * different type on it, which is why every type is walked rather than assumed.
 */

const ADMIN = "admin@symbiosystech.com";
const DEVELOPER = "kiran.das@symbiosystech.com";
const TESTER = "priya.nair@symbiosystech.com";
const FULLSTACK = "meera.pillai@symbiosystech.com";

/** The four working roles, and somebody who actually holds each. */
const WHO: { email: string; role: WorkRole }[] = [
  { email: ADMIN, role: "ADMIN" },
  { email: DEVELOPER, role: "DEVELOPER" },
  { email: TESTER, role: "QA" },
  { email: FULLSTACK, role: "FULLSTACK" },
];

const created: string[] = [];
const createdSprints: string[] = [];
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

beforeAll(async () => {
  projectId = (await projectByKey("ENG")).id;

  /* Each of the four roles held by somebody, explicitly — team rows are shared
     state, and a role inherited from another file would make these pass or
     fail for the wrong reason. */
  await leaveFor(DEVELOPER, TESTING_TEAM_SLUG);
  await leaveFor(DEVELOPER, FULLSTACK_TEAM_SLUG);
  await join(DEVELOPER, DEVELOPMENT_TEAM_SLUG);

  await leaveFor(TESTER, DEVELOPMENT_TEAM_SLUG);
  await leaveFor(TESTER, FULLSTACK_TEAM_SLUG);
  await join(TESTER, TESTING_TEAM_SLUG);

  await leaveFor(FULLSTACK, TESTING_TEAM_SLUG);
  await leaveFor(FULLSTACK, DEVELOPMENT_TEAM_SLUG);
  await join(FULLSTACK, FULLSTACK_TEAM_SLUG);

  for (const { email } of WHO) {
    const person = await userByEmail(email);
    await prisma.projectMember.upsert({
      where: { projectId_userId: { projectId, userId: person.id } },
      update: {},
      create: { projectId, userId: person.id },
    });
  }
});

afterAll(async () => {
  if (createdSprints.length > 0) {
    await prisma.sprint.deleteMany({ where: { id: { in: createdSprints } } });
  }
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

describe("the matrix itself", () => {
  it("offers every work-item type to every working role", () => {
    for (const { role } of WHO) {
      expect(new Set(creatableWorkItems(role)), role).toEqual(
        new Set(ISSUE_TYPES),
      );
      for (const type of ISSUE_TYPES) {
        expect(canCreateWorkItem(role, type), `${role} → ${type}`).toBe(true);
      }
    }
  });

  it("offers a sprint to an administrator and to nobody else", () => {
    expect(canCreateSprint("ADMIN")).toBe(true);
    for (const role of ["DEVELOPER", "QA", "FULLSTACK"] as const) {
      expect(canCreateSprint(role), role).toBe(false);
    }
  });
});

describe("raising work, through the action a browser calls", () => {
  for (const { email, role } of WHO) {
    it(`lets a ${role} raise every type`, async () => {
      /* The role is resolved from the database rather than assumed, so a
         fixture that drifted would fail here rather than silently testing the
         wrong person. */
      expect(await workRoleOf(await userByEmail(email))).toBe(role);

      for (const type of ISSUE_TYPES) {
        await actAs(email);
        const result = await createIssue({
          projectId,
          type,
          title: `${role} raises ${type} ${Date.now()}-${Math.random()}`,
          description: "fixture",
          priority: "MEDIUM",
        });

        expect(result.ok, result.ok ? "" : `${role}/${type}: ${result.error}`).toBe(
          true,
        );
        if (result.ok) {
          created.push(result.data.id);
          /* The type asked for is the type written — a Bug is still a Bug. */
          const row = await prisma.issue.findUniqueOrThrow({
            where: { id: result.data.id },
            select: { type: true },
          });
          expect(row.type).toBe(type);
        }
      }
    });
  }
});

/**
 * A valid fortnight.
 *
 * Supplied on purpose: the schema requires both dates, so a payload without
 * them is refused before authorization is ever reached — and a test that
 * omitted them would pass whatever the permission rule said.
 */
const dates = () => ({
  startDate: new Date().toISOString(),
  endDate: new Date(Date.now() + 14 * 864e5).toISOString(),
});

describe("creating a sprint, through the action a browser calls", () => {
  it("lets an administrator create one", async () => {
    await actAs(ADMIN);
    const result = await createSprint({
      projectId,
      name: `Admin sprint ${Date.now()}`,
      goal: "fixture",
      ...dates(),
    });

    expect(result.ok, result.ok ? "" : result.error).toBe(true);
    if (result.ok) createdSprints.push(result.data.id);
  });

  for (const { email, role } of WHO.filter((who) => who.role !== "ADMIN")) {
    it(`refuses a ${role}`, async () => {
      const name = `${role} sprint ${Date.now()}-${Math.random()}`;

      await actAs(email);
      const result = await createSprint({
        projectId,
        name,
        goal: "fixture",
        ...dates(),
      });

      expect(result.ok).toBe(false);
      // Refused means nothing was written.
      expect(await prisma.sprint.count({ where: { name } })).toBe(0);
    });
  }

  it("ignores a role supplied by the caller", async () => {
    /*
     * The shape a forged request takes: the payload claims a role of its own.
     * `createSprint` parses only what it accepts and resolves the caller from
     * the session, so the claim reaches no decision.
     */
    const name = `Forged admin sprint ${Date.now()}`;

    await actAs(DEVELOPER);
    const result = await createSprint({
      projectId,
      name,
      goal: "fixture",
      ...dates(),
      role: "ADMIN",
      workRole: "ADMIN",
      isAdmin: true,
    } as unknown);

    expect(result.ok).toBe(false);
    expect(await prisma.sprint.count({ where: { name } })).toBe(0);
  });
});

describe("project authorization still decides where", () => {
  it("refuses work raised in a project the caller cannot open", async () => {
    /* Permission to raise work is not permission to raise it anywhere. The
       developer is taken off the project for the duration and put back. */
    const person = await userByEmail(DEVELOPER);
    const membership = await prisma.projectMember.findUniqueOrThrow({
      where: { projectId_userId: { projectId, userId: person.id } },
      select: { id: true },
    });
    await prisma.projectMember.delete({ where: { id: membership.id } });

    const title = `Outside the project ${Date.now()}`;
    try {
      await actAs(DEVELOPER);
      const result = await createIssue({
        projectId,
        type: "TASK",
        title,
        description: "fixture",
        priority: "MEDIUM",
      });

      expect(result.ok).toBe(false);
      expect(await prisma.issue.count({ where: { title } })).toBe(0);
    } finally {
      await prisma.projectMember.create({
        data: { projectId, userId: person.id },
      });
    }
  });
});
