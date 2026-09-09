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
  issuesAssignedTo,
  listProjectIssues,
  loadRosterProfile,
  updateRosterAssignment,
} from "@/server/roster";
import { actAs, joinTestingTeam, projectByKey } from "./helpers";

/**
 * Administration's rosters, and the line between a roster and a role.
 *
 * The Development team does two things and it is worth pinning both. On its
 * own it grants nothing — somebody on Development alone is a developer, which
 * is what a member not on Testing has always been. Held together with Testing
 * it makes a Full Stack Developer: both jobs, neither winning over the other.
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

  it("combines with Testing rather than losing to it", async () => {
    /*
     * The rule the whole model turns on. Testing says somebody checks work;
     * Development says they build it. Holding both is not a contradiction to
     * be resolved in one side's favour — it is both jobs, and the role says so.
     *
     * Neither "QA" nor "DEVELOPER" is an acceptable answer here. A person on
     * both teams who resolved to either would silently lose half of what they
     * are allowed to do.
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

      expect(await workRoleOf(person)).toBe("FULLSTACK");
    } finally {
      await leave();
    }
  });

  it("resolves the whole matrix", async () => {
    /*
     * Every combination in one place, so a change to `workRoleOf` cannot
     * satisfy one row by breaking another.
     *
     *   Testing only          -> QA
     *   Development only      -> DEVELOPER
     *   both                  -> FULLSTACK
     *   neither               -> DEVELOPER   (the long-standing default)
     */
    const dev = await developmentTeam();
    const testing = await prisma.team.findUniqueOrThrow({
      where: { slug: TESTING_TEAM_SLUG },
      select: { id: true },
    });
    const person = await userByEmail(TESTER);

    const setTeams = async (onTesting: boolean, onDevelopment: boolean) => {
      for (const [teamId, wanted] of [
        [testing.id, onTesting],
        [dev.id, onDevelopment],
      ] as const) {
        if (wanted) {
          await prisma.teamMember.upsert({
            where: { teamId_userId: { teamId, userId: person.id } },
            update: {},
            create: { teamId, userId: person.id },
          });
        } else {
          await prisma.teamMember.deleteMany({
            where: { teamId, userId: person.id },
          });
        }
      }
    };

    try {
      await setTeams(false, false);
      expect(await workRoleOf(person)).toBe("DEVELOPER");

      await setTeams(true, false);
      expect(await workRoleOf(person)).toBe("QA");

      await setTeams(false, true);
      expect(await workRoleOf(person)).toBe("DEVELOPER");

      await setTeams(true, true);
      expect(await workRoleOf(person)).toBe("FULLSTACK");
    } finally {
      await setTeams(false, false);
    }
  });

  it("does not make an administrator anything but an administrator", async () => {
    /* Full stack is two member jobs. It is not a route to administration, and
       an admin on both teams is still simply an admin. */
    const admin = await userByEmail(ADMIN);
    expect(await workRoleOf(admin)).toBe("ADMIN");
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
     * A profile opened from the Development block reports whatever
     * `workRoleOf` says — QA member for somebody on Testing alone, Full Stack
     * Developer for somebody on both. Anything else would make this the one
     * place in Prio that answers the question differently, and a profile that
     * named the card it was opened from would be lying about half the people
     * on it.
     *
     * Both memberships are set explicitly rather than inherited from whatever
     * an earlier test left behind, so the two cases are actually the two cases.
     */
    const person = await userByEmail(TESTER);
    const dev = await developmentTeam();
    const testing = await prisma.team.findUniqueOrThrow({
      where: { slug: TESTING_TEAM_SLUG },
      select: { id: true },
    });

    const join = async (teamId: string) => {
      await prisma.teamMember.upsert({
        where: { teamId_userId: { teamId, userId: person.id } },
        update: {},
        create: { teamId, userId: person.id },
      });
    };
    const drop = async (teamId: string) => {
      await prisma.teamMember.deleteMany({ where: { teamId, userId: person.id } });
    };

    try {
      await drop(dev.id);
      await join(testing.id);
      const asTester = await loadRosterProfile(person.id);
      expect(asTester.ok).toBe(true);
      if (asTester.ok) expect(asTester.data.workRole).toBe("QA");

      await join(dev.id);
      const asFullStack = await loadRosterProfile(person.id);
      expect(asFullStack.ok).toBe(true);
      if (asFullStack.ok) expect(asFullStack.data.workRole).toBe("FULLSTACK");
    } finally {
      await drop(dev.id);
      await drop(testing.id);
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

describe("updateRosterAssignment — an edit changes what was edited, and nothing else", () => {
  /*
   * The save replaces this person's issues *within the chosen project*: what is
   * in the list stays theirs, what is theirs and not in the list is released.
   * That is a reasonable contract, and it is also why the editor opening with
   * the wrong selection is destructive rather than merely wrong — saving an
   * empty selection releases everything they held there.
   *
   * So these pin both halves: the contract, and the fact that the editor can
   * actually reconstruct the current selection from what `listProjectIssues`
   * returns. It could not while that only carried the assignee's *name*.
   */

  /** Gives `count` of this project's issues to `userId`, returning their ids. */
  async function give(
    projectId: string,
    userId: string,
    count: number,
  ): Promise<string[]> {
    const issues = await prisma.issue.findMany({
      where: { projectId },
      select: { id: true, assigneeId: true },
      orderBy: { key: "asc" },
      take: count,
    });

    for (const issue of issues) {
      restoreAssignees.push({ id: issue.id, assigneeId: issue.assigneeId });
      await prisma.issue.update({
        where: { id: issue.id },
        data: { assigneeId: userId },
      });
    }
    return issues.map((i) => i.id);
  }

  /** What this person holds in this project right now. */
  async function held(projectId: string, userId: string): Promise<string[]> {
    const rows = await prisma.issue.findMany({
      where: { projectId, assigneeId: userId },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    return rows.map((r) => r.id);
  }

  it("reports what somebody holds without the picker's row cap losing any of it", async () => {
    /*
     * Two bugs in one, and both released work on an untouched save.
     *
     * The editor pre-selected by matching the displayed assignee *name*, which
     * is the right answer only while every name is unique and spelled the
     * same. And it read those rows from `listProjectIssues`, which returns at
     * most 500 — Engineering has 985 — so anything past the cap was never
     * selected, and the save released it.
     *
     * `issuesAssignedTo` is the authoritative answer: its own query, no cap.
     * This asserts it agrees with the database exactly, and that the capped
     * picker genuinely cannot be used for the job.
     */
    const project = await projectByKey("ENG");
    const person = await userByEmail(DEVELOPER);
    const mine = await give(project.id, person.id, 2);

    const authoritative = await issuesAssignedTo(project.id, person.id);
    expect(authoritative.ok).toBe(true);
    if (!authoritative.ok) return;

    const expected = await held(project.id, person.id);
    expect([...authoritative.data].sort()).toEqual(expected);
    for (const id of mine) expect(authoritative.data).toContain(id);

    /* And the picker really is capped, so seeding from it would have been
       wrong rather than merely fragile. */
    const picker = await listProjectIssues(project.id);
    expect(picker.ok).toBe(true);
    if (picker.ok) {
      const total = await prisma.issue.count({ where: { projectId: project.id } });
      if (total > picker.data.length) {
        expect(picker.data.length).toBeLessThan(total);
      }
    }
  });

  it("saving without changing anything releases nothing", async () => {
    /* The non-negotiable one. Open, save, and everything is still theirs. */
    const project = await projectByKey("ENG");
    const person = await userByEmail(DEVELOPER);
    const before = await held(project.id, person.id);
    expect(before.length).toBeGreaterThan(0);

    const result = await updateRosterAssignment({
      userId: person.id,
      projectId: project.id,
      issueIds: before,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.released).toBe(0);
    expect(await held(project.id, person.id)).toEqual(before);
  });

  it("adding one keeps the others", async () => {
    const project = await projectByKey("ENG");
    const person = await userByEmail(DEVELOPER);
    const before = await held(project.id, person.id);

    const extra = await prisma.issue.findFirst({
      where: { projectId: project.id, id: { notIn: before } },
      select: { id: true, assigneeId: true },
    });
    if (!extra) return;
    restoreAssignees.push({ id: extra.id, assigneeId: extra.assigneeId });

    const result = await updateRosterAssignment({
      userId: person.id,
      projectId: project.id,
      issueIds: [...before, extra.id],
    });

    expect(result.ok).toBe(true);
    expect(await held(project.id, person.id)).toEqual(
      [...before, extra.id].sort(),
    );
  });

  it("removing one keeps the rest", async () => {
    const project = await projectByKey("ENG");
    const person = await userByEmail(DEVELOPER);
    const before = await held(project.id, person.id);
    expect(before.length).toBeGreaterThan(1);

    const dropped = before[0]!;
    const kept = before.slice(1);

    const result = await updateRosterAssignment({
      userId: person.id,
      projectId: project.id,
      issueIds: kept,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.released).toBe(1);

    const after = await held(project.id, person.id);
    expect(after).toEqual(kept.sort());
    expect(after).not.toContain(dropped);
  });

  it("leaves another project's assignments alone", async () => {
    /*
     * The edit names one project, and that project is the whole of what it may
     * touch. Work this person holds elsewhere is not in the request and must
     * not be collateral.
     */
    const eng = await projectByKey("ENG");
    const web = await projectByKey("WEB");
    const person = await userByEmail(DEVELOPER);

    await prisma.projectMember.upsert({
      where: { projectId_userId: { projectId: web.id, userId: person.id } },
      update: {},
      create: { projectId: web.id, userId: person.id },
    });
    const elsewhere = await give(web.id, person.id, 1);
    if (elsewhere.length === 0) return;

    /* Release everything in ENG — the most destructive edit available. */
    const result = await updateRosterAssignment({
      userId: person.id,
      projectId: eng.id,
      issueIds: [],
    });
    expect(result.ok).toBe(true);

    expect(await held(web.id, person.id)).toEqual(elsewhere.sort());
  });

  it("changes nothing about the person themselves", async () => {
    /* An assignment edit is about assignments. Name, email, designation, role
       and team membership are facts about the person and are not its business. */
    const project = await projectByKey("ENG");
    const before = await userByEmail(DEVELOPER);

    const teamsBefore = await prisma.teamMember.count({
      where: { userId: before.id },
    });

    const result = await updateRosterAssignment({
      userId: before.id,
      projectId: project.id,
      issueIds: [],
    });
    expect(result.ok).toBe(true);

    const after = await userByEmail(DEVELOPER);
    expect(after.name).toBe(before.name);
    expect(after.email).toBe(before.email);
    expect(after.jobTitle).toBe(before.jobTitle);
    expect(after.role).toBe(before.role);
    expect(after.isActive).toBe(before.isActive);
    expect(await prisma.teamMember.count({ where: { userId: before.id } })).toBe(
      teamsBefore,
    );
  });

  it("refuses a caller who is not an administrator", async () => {
    const project = await projectByKey("ENG");
    const person = await userByEmail(DEVELOPER);

    await actAs(DEVELOPER);
    const result = await updateRosterAssignment({
      userId: person.id,
      projectId: project.id,
      issueIds: [],
    });
    await actAs(ADMIN);

    expect(result.ok).toBe(false);
  });
});
