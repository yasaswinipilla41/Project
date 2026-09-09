import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { DEVELOPMENT_TEAM_SLUG, TESTING_TEAM_SLUG } from "@/lib/authz";
import { createSprint, deleteSprint, addIssuesToSprint } from "@/server/sprints";
import { createIssue } from "@/server/issues";
import { actAs, projectByKey } from "./helpers";

/**
 * Deleting a sprint.
 *
 * Two things are asserted, and the second is the reason the first matters.
 * Only an administrator may do it — checked by calling the action directly,
 * which is what a forged request is. And what it removes is the sprint: the
 * issues that were in it are still there, still where they were, simply no
 * longer in a sprint. That is `Issue.sprintId` being `onDelete: SetNull` in
 * the schema, asserted here so a later migration cannot quietly turn it into a
 * cascade and take somebody's work with it.
 */

const ADMIN = "admin@symbiosystech.com";
const TESTER = "priya.nair@symbiosystech.com";
const DEVELOPER = "kiran.das@symbiosystech.com";

const createdSprints: string[] = [];
const createdIssues: string[] = [];
const memberships: string[] = [];
let projectId = "";

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

beforeAll(async () => {
  const project = await projectByKey("ENG");
  projectId = project.id;
  await join(TESTER, TESTING_TEAM_SLUG);
  // The developer is deliberately on no team: a member on neither is one.
  await prisma.teamMember.deleteMany({
    where: {
      user: { email: DEVELOPER },
      team: { slug: { in: [TESTING_TEAM_SLUG, DEVELOPMENT_TEAM_SLUG] } },
    },
  });
});

afterAll(async () => {
  if (createdSprints.length > 0) {
    await prisma.sprint.deleteMany({ where: { id: { in: createdSprints } } });
  }
  if (createdIssues.length > 0) {
    await prisma.notification.deleteMany({
      where: { issueId: { in: createdIssues } },
    });
    await prisma.activityLogEntry.deleteMany({
      where: { issueId: { in: createdIssues } },
    });
    await prisma.issue.deleteMany({ where: { id: { in: createdIssues } } });
  }
  await prisma.teamMember.deleteMany({ where: { id: { in: memberships } } });
  await prisma.$disconnect();
});

/** A planned sprint in ENG, filed by the administrator. */
async function aSprint(name: string): Promise<string> {
  await actAs(ADMIN);
  const result = await createSprint({
    projectId,
    name: `${name} ${Date.now()}`,
    goal: "fixture",
    startDate: new Date().toISOString(),
    endDate: new Date(Date.now() + 7 * 864e5).toISOString(),
  });
  if (!result.ok) throw new Error(result.error);
  createdSprints.push(result.data.id);
  return result.data.id;
}

/** An issue in ENG, in a sprint. */
async function anIssueIn(sprintId: string, title: string): Promise<string> {
  await actAs(ADMIN);
  const created = await createIssue({
    projectId,
    type: "TASK",
    title: `${title} ${Date.now()}`,
    description: "fixture",
    priority: "MEDIUM",
  });
  if (!created.ok) throw new Error(created.error);
  createdIssues.push(created.data.id);

  const added = await addIssuesToSprint({
    sprintId,
    issueIds: [created.data.id],
  });
  if (!added.ok) throw new Error(added.error);
  return created.data.id;
}

describe("an administrator", () => {
  it("deletes a sprint, and it stays deleted", async () => {
    const sprintId = await aSprint("Delete me");

    await actAs(ADMIN);
    const result = await deleteSprint({ sprintId });
    expect(result.ok).toBe(true);

    expect(
      await prisma.sprint.count({ where: { id: sprintId } }),
      "gone from the database, not just from a list",
    ).toBe(0);
  });

  it("leaves the issues that were in it exactly as they were", async () => {
    const sprintId = await aSprint("Delete with work in it");
    const issueId = await anIssueIn(sprintId, "Work in a doomed sprint");

    const before = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: { status: true, priority: true, assigneeId: true, title: true },
    });
    const trailBefore = await prisma.activityLogEntry.count({
      where: { issueId },
    });

    await actAs(ADMIN);
    expect((await deleteSprint({ sprintId })).ok).toBe(true);

    const after = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: {
        status: true,
        priority: true,
        assigneeId: true,
        title: true,
        sprintId: true,
      },
    });

    // Still there, still itself — and simply no longer in a sprint.
    expect(after.status).toBe(before.status);
    expect(after.priority).toBe(before.priority);
    expect(after.assigneeId).toBe(before.assigneeId);
    expect(after.title).toBe(before.title);
    expect(after.sprintId).toBeNull();

    // Its history is untouched as well.
    expect(await prisma.activityLogEntry.count({ where: { issueId } })).toBe(
      trailBefore,
    );
  });

  it("takes the sprint's own outcome rows with it, and no others", async () => {
    const doomed = await aSprint("Delete me too");
    const survivor = await aSprint("Keep me");
    const issueId = await anIssueIn(doomed, "Work that outlives its sprint");
    await anIssueIn(survivor, "Work in the other sprint");

    // A completed sprint records how each issue ended; make one such row.
    await prisma.sprintIssueOutcome.create({
      data: { sprintId: doomed, issueId, completed: false },
    });

    await actAs(ADMIN);
    expect((await deleteSprint({ sprintId: doomed })).ok).toBe(true);

    expect(
      await prisma.sprintIssueOutcome.count({ where: { sprintId: doomed } }),
      "its own records go with it",
    ).toBe(0);
    expect(
      await prisma.sprint.count({ where: { id: survivor } }),
      "the other sprint is untouched",
    ).toBe(1);
    expect(
      await prisma.issue.count({ where: { sprintId: survivor } }),
      "and still holds its work",
    ).toBe(1);
  });

  it("is told plainly when the sprint is already gone", async () => {
    const sprintId = await aSprint("Delete me twice");

    await actAs(ADMIN);
    expect((await deleteSprint({ sprintId })).ok).toBe(true);

    const second = await deleteSprint({ sprintId });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/no longer exists/i);
  });

  it("refuses an id that is not one", async () => {
    await actAs(ADMIN);

    for (const sprintId of ["", "not-a-sprint"]) {
      const result = await deleteSprint({ sprintId });
      expect(result.ok, `${sprintId || "(empty)"} is refused`).toBe(false);
    }
  });
});

describe("everybody else", () => {
  for (const [who, email] of [
    ["a developer", DEVELOPER],
    ["a tester", TESTER],
  ] as const) {
    it(`refuses ${who}, and the sprint is untouched`, async () => {
      const sprintId = await aSprint(`Not ${who}'s to delete`);

      await actAs(email);
      const result = await deleteSprint({ sprintId });

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/administrator/i);
      expect(await prisma.sprint.count({ where: { id: sprintId } })).toBe(1);
    });
  }

  it("refuses somebody who does both member jobs", async () => {
    /* Full stack is two member jobs held at once, and neither of them is
       administration — which is the whole point of asserting it here. */
    const sprintId = await aSprint("Not full stack's either");
    const fullstack = "meera.pillai@symbiosystech.com";
    await join(fullstack, TESTING_TEAM_SLUG);
    await join(fullstack, DEVELOPMENT_TEAM_SLUG);

    await actAs(fullstack);
    const result = await deleteSprint({ sprintId });

    expect(result.ok).toBe(false);
    expect(await prisma.sprint.count({ where: { id: sprintId } })).toBe(1);
  });
});
