import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEVELOPMENT_TEAM_SLUG,
  TESTING_TEAM_SLUG,
  workRoleOf,
} from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import {
  assignDevelopers,
  assignTeamMembers,
  listProjectIssues,
  loadRosterProfile,
} from "@/server/roster";
import { actAs, joinTestingTeam, projectByKey } from "./helpers";

/**
 * Administration's rosters, and the line between a roster and a role.
 *
 * The Development team is the new row here, and the thing worth pinning is
 * what it does *not* do: it grants nothing, withholds nothing, and does not
 * decide who is a QA member. `workRoleOf` still reads Testing alone, so
 * somebody on both teams is a QA member and somebody on Development only is a
 * developer exactly as they were before the team existed.
 *
 * Every assignment case calls the server action directly — the same call a
 * forged request would make — because a filtered dropdown is not a check.
 */

const ADMIN = "admin@symbiosystech.com";
const DEVELOPER = "kiran.das@symbiosystech.com";
const TESTER = "priya.nair@symbiosystech.com";

/** Rows this file created, removed afterwards so the fixture is left as found. */
const createdMemberships: string[] = [];
const createdProjectMemberships: string[] = [];
const restoreAssignees: { id: string; assigneeId: string | null }[] = [];

async function developmentTeam() {
  return prisma.team.findUniqueOrThrow({
    where: { slug: DEVELOPMENT_TEAM_SLUG },
    select: { id: true, name: true },
  });
}

/** The full `CurrentUser` shape, because `workRoleOf` takes one. */
async function userByEmail(email: string) {
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

/** Remembers a membership so `afterAll` can undo exactly what a test added. */
async function trackNewMemberships(teamId: string, userIds: string[]) {
  const rows = await prisma.teamMember.findMany({
    where: { teamId, userId: { in: userIds } },
    select: { id: true },
  });
  createdMemberships.push(...rows.map((r) => r.id));
}

beforeAll(async () => {
  await actAs(ADMIN);
});

afterAll(async () => {
  for (const issue of restoreAssignees) {
    await prisma.issue.update({
      where: { id: issue.id },
      data: { assigneeId: issue.assigneeId },
    });
  }
  if (createdMemberships.length > 0) {
    await prisma.teamMember.deleteMany({
      where: { id: { in: createdMemberships } },
    });
  }
  if (createdProjectMemberships.length > 0) {
    await prisma.projectMember.deleteMany({
      where: { id: { in: createdProjectMemberships } },
    });
  }
});

describe("the Development team is a roster, not a role", () => {
  it("exists as an ordinary team row", async () => {
    const team = await developmentTeam();
    expect(team.name).toBe("Development");
  });

  it("does not make its members anything they were not already", async () => {
    /*
     * The whole point of the row. A member on Development and not on Testing
     * is a developer — which is what they were before being added, because a
     * developer is somebody *not* on Testing. Adding the row must not change
     * the answer in either direction.
     */
    const team = await developmentTeam();
    const person = await userByEmail(DEVELOPER);

    const before = await workRoleOf(person);
    expect(before).toBe("DEVELOPER");

    await prisma.teamMember.upsert({
      where: { teamId_userId: { teamId: team.id, userId: person.id } },
      update: {},
      create: { teamId: team.id, userId: person.id },
    });
    await trackNewMemberships(team.id, [person.id]);

    expect(await workRoleOf(person)).toBe("DEVELOPER");
  });

  it("loses to Testing when somebody is on both", async () => {
    /*
     * Precedence, stated once and asserted here. Testing decides who tests;
     * Development records who has been onboarded to build. Being on both is
     * not a contradiction and not an error — it resolves to QA member, because
     * `workRoleOf` asks about Testing and nothing else.
     */
    const team = await developmentTeam();
    const person = await userByEmail(TESTER);
    const { leave } = await joinTestingTeam(TESTER);

    try {
      await prisma.teamMember.upsert({
        where: { teamId_userId: { teamId: team.id, userId: person.id } },
        update: {},
        create: { teamId: team.id, userId: person.id },
      });
      await trackNewMemberships(team.id, [person.id]);

      expect(await workRoleOf(person)).toBe("QA");
    } finally {
      await leave();
    }
  });
});

describe("assignTeamMembers", () => {
  it("writes team membership and project access together", async () => {
    const testing = await prisma.team.findUniqueOrThrow({
      where: { slug: TESTING_TEAM_SLUG },
      select: { id: true },
    });
    const project = await projectByKey("INT");
    const person = await userByEmail(TESTER);

    const result = await assignTeamMembers({
      teamId: testing.id,
      projectId: project.id,
      userIds: [person.id],
    });

    expect(result.ok).toBe(true);
    await trackNewMemberships(testing.id, [person.id]);

    const [onTeam, onProject] = await Promise.all([
      prisma.teamMember.count({
        where: { teamId: testing.id, userId: person.id },
      }),
      prisma.projectMember.findFirst({
        where: { projectId: project.id, userId: person.id },
        select: { id: true },
      }),
    ]);

    expect(onTeam).toBe(1);
    expect(onProject).not.toBeNull();
    if (onProject) createdProjectMemberships.push(onProject.id);
  });

  it("is a no-op the second time rather than an error", async () => {
    const testing = await prisma.team.findUniqueOrThrow({
      where: { slug: TESTING_TEAM_SLUG },
      select: { id: true },
    });
    const project = await projectByKey("INT");
    const person = await userByEmail(TESTER);

    const again = await assignTeamMembers({
      teamId: testing.id,
      projectId: project.id,
      userIds: [person.id],
    });

    expect(again.ok).toBe(true);
    expect(
      await prisma.teamMember.count({
        where: { teamId: testing.id, userId: person.id },
      }),
    ).toBe(1);
  });

  it("refuses a caller who is not an administrator", async () => {
    const testing = await prisma.team.findUniqueOrThrow({
      where: { slug: TESTING_TEAM_SLUG },
      select: { id: true },
    });
    const project = await projectByKey("INT");
    const person = await userByEmail(TESTER);

    await actAs(DEVELOPER);
    const result = await assignTeamMembers({
      teamId: testing.id,
      projectId: project.id,
      userIds: [person.id],
    });
    await actAs(ADMIN);

    expect(result.ok).toBe(false);
  });
});

describe("assignDevelopers", () => {
  it("refuses an issue that belongs to another project", async () => {
    /*
     * The dependent dropdown narrows the list; this is what makes the
     * narrowing binding. The payload names a real issue and a real project —
     * they simply are not each other's.
     */
    const team = await developmentTeam();
    const target = await projectByKey("INT");
    const elsewhere = await prisma.issue.findFirstOrThrow({
      where: { project: { key: "ENG" } },
      select: { id: true },
    });
    const person = await userByEmail(DEVELOPER);

    const result = await assignDevelopers({
      teamId: team.id,
      projectId: target.id,
      issueIds: [elsewhere.id],
      role: "MEMBER",
      userIds: [person.id],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/do not belong to the selected project/i);
    }
  });

  it("adds the roster, the project and the work in one act", async () => {
    const team = await developmentTeam();
    const project = await projectByKey("ENG");
    const person = await userByEmail(DEVELOPER);

    const issue = await prisma.issue.findFirstOrThrow({
      where: { projectId: project.id },
      select: { id: true, assigneeId: true },
    });
    restoreAssignees.push({ id: issue.id, assigneeId: issue.assigneeId });

    const result = await assignDevelopers({
      teamId: team.id,
      projectId: project.id,
      issueIds: [issue.id],
      role: "MEMBER",
      userIds: [person.id],
    });

    expect(result.ok).toBe(true);
    await trackNewMemberships(team.id, [person.id]);

    const after = await prisma.issue.findUniqueOrThrow({
      where: { id: issue.id },
      select: { assigneeId: true },
    });
    expect(after.assigneeId).toBe(person.id);

    const membership = await prisma.projectMember.findFirst({
      where: { projectId: project.id, userId: person.id },
      select: { id: true },
    });
    expect(membership).not.toBeNull();

    /* Assignment is recorded like any other, so the trail does not have a
       hole where an administrator did it. */
    const logged = await prisma.activityLogEntry.count({
      where: { issueId: issue.id, field: "assigneeId" },
    });
    expect(logged).toBeGreaterThan(0);
  });

  it("deals several issues out across several people", async () => {
    /*
     * An issue holds one assignee, so handing the same one to everybody is not
     * something the model can express. They are dealt out in the order both
     * lists were given — two issues and two people is one each — which is the
     * reading that neither drops a selection nor invents a second column.
     */
    const team = await developmentTeam();
    const project = await projectByKey("ENG");
    const first = await userByEmail(DEVELOPER);
    const second = await userByEmail(TESTER);

    const issues = await prisma.issue.findMany({
      where: { projectId: project.id },
      select: { id: true, assigneeId: true },
      orderBy: { key: "asc" },
      take: 2,
    });
    if (issues.length < 2) return;
    restoreAssignees.push(
      ...issues.map((i) => ({ id: i.id, assigneeId: i.assigneeId })),
    );

    const result = await assignDevelopers({
      teamId: team.id,
      projectId: project.id,
      issueIds: issues.map((i) => i.id),
      role: "MEMBER",
      userIds: [first.id, second.id],
    });

    expect(result.ok).toBe(true);
    await trackNewMemberships(team.id, [first.id, second.id]);

    const after = await prisma.issue.findMany({
      where: { id: { in: issues.map((i) => i.id) } },
      select: { id: true, assigneeId: true },
      orderBy: { key: "asc" },
    });

    expect(after[0]?.assigneeId).toBe(first.id);
    expect(after[1]?.assigneeId).toBe(second.id);
  });

  it("refuses a caller who is not an administrator", async () => {
    const team = await developmentTeam();
    const project = await projectByKey("ENG");
    const person = await userByEmail(DEVELOPER);

    await actAs(DEVELOPER);
    const result = await assignDevelopers({
      teamId: team.id,
      projectId: project.id,
      issueIds: [],
      role: "ADMIN",
      userIds: [person.id],
    });
    await actAs(ADMIN);

    expect(result.ok).toBe(false);

    /* And in particular the role was not granted by the refused call. */
    const unchanged = await userByEmail(DEVELOPER);
    expect(unchanged.role).toBe("MEMBER");
  });
});

describe("listProjectIssues", () => {
  it("returns that project's issues and no other project's", async () => {
    const project = await projectByKey("ENG");
    const result = await listProjectIssues(project.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ids = result.data.map((i) => i.id);
    const foreign = await prisma.issue.count({
      where: { id: { in: ids }, NOT: { projectId: project.id } },
    });
    expect(foreign).toBe(0);
    expect(result.data.length).toBeGreaterThan(0);
  });

  it("refuses a caller who is not an administrator", async () => {
    const project = await projectByKey("ENG");

    await actAs(DEVELOPER);
    const result = await listProjectIssues(project.id);
    await actAs(ADMIN);

    expect(result.ok).toBe(false);
  });
});

describe("loadRosterProfile", () => {
  it("reports the derived work role, not the block it was opened from", async () => {
    /*
     * A profile opened from the Development block still says QA member if that
     * is what `workRoleOf` says. Anything else would make this the one place
     * in Prio that answers the question differently.
     */
    const person = await userByEmail(TESTER);
    const { leave } = await joinTestingTeam(TESTER);

    try {
      const result = await loadRosterProfile(person.id);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.workRole).toBe("QA");
    } finally {
      await leave();
    }
  });

  it("lists the projects and work that are actually theirs", async () => {
    const person = await userByEmail(DEVELOPER);
    const result = await loadRosterProfile(person.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const assignedElsewhere = await prisma.issue.count({
      where: {
        id: { in: result.data.issues.map((i) => i.id) },
        NOT: { assigneeId: person.id },
      },
    });
    expect(assignedElsewhere).toBe(0);
  });

  it("refuses a caller who is not an administrator", async () => {
    const person = await userByEmail(TESTER);

    await actAs(DEVELOPER);
    const result = await loadRosterProfile(person.id);
    await actAs(ADMIN);

    expect(result.ok).toBe(false);
  });
});
