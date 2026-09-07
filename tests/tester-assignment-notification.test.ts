import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { TESTING_TEAM_SLUG } from "@/lib/authz";
import { updateIssue, createIssue } from "@/server/issues";
import { actAs, projectByKey } from "./helpers";

/**
 * Being assigned an issue as a tester.
 *
 * Assignment already notified whoever received the work; what is under test
 * here is that a tester — somebody on the Testing team, which is how the rest
 * of Prio decides who a tester is — is told they were assigned *as a tester*,
 * and that the surrounding rules did not move: one notification for the person
 * who now holds the work, none for the person who lost it, none for an
 * unassignment, and none at all when the assignee did not actually change.
 *
 * Every row is read back from the database rather than inferred from a return
 * value, because a notification nobody can find is the failure this guards.
 */

const ADMIN = "admin@symbiosystech.com";

let testerId: string;
let otherTesterId: string;
let plainId: string;
let teamId: string | null = null;
const createdIssueIds: string[] = [];
const addedTeamMemberIds: string[] = [];

/** Notifications written for `userId` about `issueId`, newest first. */
async function assignmentsFor(userId: string, issueId: string) {
  return prisma.notification.findMany({
    where: { userId, issueId, type: "ISSUE_ASSIGNED" },
    orderBy: { createdAt: "desc" },
    select: { id: true, message: true, issueId: true, actorId: true },
  });
}

beforeAll(async () => {
  /* Three people on a project: two of them testers, one not. The Testing team
     is created if this installation has none — teams are rows, and the fixture
     must not depend on one having been made by hand. */
  const project = await projectByKey("ENG");
  const members = await prisma.projectMember.findMany({
    where: { projectId: project.id, user: { isActive: true } },
    select: { user: { select: { id: true, email: true } } },
    take: 6,
  });

  const pool = members
    .map((m) => m.user)
    .filter((u) => u.email !== ADMIN);
  if (pool.length < 3) throw new Error("ENG needs three non-admin members");

  testerId = pool[0]!.id;
  otherTesterId = pool[1]!.id;
  plainId = pool[2]!.id;

  const team =
    (await prisma.team.findUnique({
      where: { slug: TESTING_TEAM_SLUG },
      select: { id: true },
    })) ??
    (await prisma.team.create({
      data: { slug: TESTING_TEAM_SLUG, name: "Testing" },
      select: { id: true },
    }));
  teamId = team.id;

  for (const userId of [testerId, otherTesterId]) {
    const existing = await prisma.teamMember.findFirst({
      where: { teamId: team.id, userId },
      select: { id: true },
    });
    if (existing) continue;
    const added = await prisma.teamMember.create({
      data: { teamId: team.id, userId },
      select: { id: true },
    });
    addedTeamMemberIds.push(added.id);
  }

  // The third must not be a tester, or the negative case proves nothing.
  await prisma.teamMember.deleteMany({ where: { teamId: team.id, userId: plainId } });
});

afterAll(async () => {
  if (createdIssueIds.length > 0) {
    await prisma.notification.deleteMany({
      where: { issueId: { in: createdIssueIds } },
    });
    await prisma.issue.deleteMany({ where: { id: { in: createdIssueIds } } });
  }
  if (addedTeamMemberIds.length > 0) {
    await prisma.teamMember.deleteMany({
      where: { id: { in: addedTeamMemberIds } },
    });
  }
  await prisma.$disconnect();
});

/** An unassigned issue in ENG, reported by the acting admin. */
async function anIssue(title: string): Promise<string> {
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
  return result.data.id;
}

describe("assigning an issue to a tester", () => {
  it("tells the tester they are the tester, and names the issue", async () => {
    await actAs(ADMIN);
    const issueId = await anIssue("Tester assignment — unassigned to tester");

    const result = await updateIssue({ issueId, assigneeId: testerId });
    expect(result.ok).toBe(true);

    const rows = await assignmentsFor(testerId, issueId);
    expect(rows).toHaveLength(1);

    const issue = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: { key: true, title: true },
    });

    // Says it is a tester assignment, and which issue, by key and by title.
    expect(rows[0]!.message).toContain("as tester");
    expect(rows[0]!.message).toContain(issue.key);
    expect(rows[0]!.message).toContain(issue.title);

    /* And it points at that issue — `issueId` is what the notification list
       turns into `/issues/<key>`, so this is the navigation. */
    expect(rows[0]!.issueId).toBe(issueId);
  });

  it("notifies nobody else", async () => {
    await actAs(ADMIN);
    const issueId = await anIssue("Tester assignment — only the assignee");

    await updateIssue({ issueId, assigneeId: testerId });

    const everyone = await prisma.notification.findMany({
      where: { issueId, type: "ISSUE_ASSIGNED" },
      select: { userId: true },
    });
    expect(everyone.map((n) => n.userId)).toEqual([testerId]);
  });

  it("on reassignment tells the new tester and not the old one", async () => {
    await actAs(ADMIN);
    const issueId = await anIssue("Tester assignment — A to B");

    await updateIssue({ issueId, assigneeId: testerId });
    await updateIssue({ issueId, assigneeId: otherTesterId });

    expect(await assignmentsFor(otherTesterId, issueId)).toHaveLength(1);
    // Tester A keeps only the one from when the work was theirs.
    expect(await assignmentsFor(testerId, issueId)).toHaveLength(1);
  });

  it("writes nothing when the assignee does not actually change", async () => {
    await actAs(ADMIN);
    const issueId = await anIssue("Tester assignment — same tester twice");

    await updateIssue({ issueId, assigneeId: testerId });
    await updateIssue({ issueId, assigneeId: testerId });
    // …and an edit that touches something else entirely.
    await updateIssue({ issueId, priority: "HIGH" });

    expect(await assignmentsFor(testerId, issueId)).toHaveLength(1);
  });

  it("writes nothing when the tester is unassigned", async () => {
    await actAs(ADMIN);
    const issueId = await anIssue("Tester assignment — tester to nobody");

    await updateIssue({ issueId, assigneeId: testerId });
    const before = await assignmentsFor(testerId, issueId);

    await updateIssue({ issueId, assigneeId: null });

    expect(await assignmentsFor(testerId, issueId)).toHaveLength(before.length);
    const issue = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: { assigneeId: true },
    });
    expect(issue.assigneeId).toBeNull();
  });

  it("assigns a non-tester with the ordinary wording", async () => {
    await actAs(ADMIN);
    const issueId = await anIssue("Tester assignment — not a tester");

    await updateIssue({ issueId, assigneeId: plainId });

    const rows = await assignmentsFor(plainId, issueId);
    expect(rows).toHaveLength(1);
    // Assignment is still announced; it simply is not a tester assignment.
    expect(rows[0]!.message).not.toContain("as tester");
    expect(rows[0]!.message).toContain("to you");
  });

  it("says so at creation too, when the issue is filed onto a tester", async () => {
    await actAs(ADMIN);
    const project = await projectByKey("ENG");

    const result = await createIssue({
      projectId: project.id,
      type: "BUG",
      title: "Tester assignment — assigned at creation",
      description: "fixture",
      priority: "MEDIUM",
      assigneeId: testerId,
    });
    if (!result.ok) throw new Error(result.error);
    createdIssueIds.push(result.data.id);

    const rows = await assignmentsFor(testerId, result.data.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.message).toContain("as tester");
  });
});

describe("the tester check itself", () => {
  it("reads Testing team membership rather than a role", async () => {
    expect(teamId).not.toBeNull();

    const onTeam = await prisma.teamMember.count({
      where: { teamId: teamId!, userId: testerId },
    });
    expect(onTeam).toBe(1);

    const notOnTeam = await prisma.teamMember.count({
      where: { teamId: teamId!, userId: plainId },
    });
    expect(notOnTeam).toBe(0);
  });
});
