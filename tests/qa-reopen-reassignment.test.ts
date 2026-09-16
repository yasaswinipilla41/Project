import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEVELOPMENT_TEAM_SLUG, TESTING_TEAM_SLUG } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { createIssue, updateIssue } from "@/server/issues";
import { actAs, joinTestingTeam, projectByKey } from "./helpers";

/**
 * Reopening sends the work back to whoever built it.
 *
 * The workflow this is about runs: a tester raises a defect and hands it to a
 * developer, the developer builds it and marks it Ready for QA, it returns to
 * the tester, the tester tests it — and then finds it still broken. At that
 * moment the issue is assigned to the tester, was reported by the tester and
 * was created by the tester, so every field on the row points at QA. The one
 * person it must go to is the only one the row does not name.
 *
 * That is the whole point of these tests: the answer is read from the
 * append-only trail, and each case is arranged so that the current assignee,
 * the reporter and the creator are all somebody *other* than the expected
 * developer. An implementation reading any of them fails every case here rather
 * than passing by coincidence.
 */

const ADMIN = "admin@symbiosystech.com";
const TESTER = "priya.nair@symbiosystech.com";
const DEVELOPER = "kiran.das@symbiosystech.com";
const FULLSTACK = "meera.pillai@symbiosystech.com";
const BYSTANDER = "vikram.shetty@symbiosystech.com";

const created: string[] = [];
const memberships: string[] = [];
const projectMemberships: string[] = [];
let leaveTesting: () => Promise<void> = async () => {};
let projectId = "";

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
  const existing = await prisma.teamMember.findFirst({
    where: { teamId: team.id, userId: user.id },
    select: { id: true },
  });
  if (existing) return;

  const row = await prisma.teamMember.create({
    data: { teamId: team.id, userId: user.id },
    select: { id: true },
  });
  memberships.push(row.id);
}

async function putOnProject(email: string): Promise<void> {
  const user = await userId(email);
  const existing = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId: user } },
    select: { id: true },
  });
  if (existing) return;

  const row = await prisma.projectMember.create({
    data: { projectId, userId: user },
    select: { id: true },
  });
  projectMemberships.push(row.id);
}

async function assigneeOf(issueId: string): Promise<string | null> {
  const row = await prisma.issue.findUniqueOrThrow({
    where: { id: issueId },
    select: { assigneeId: true },
  });
  return row.assigneeId;
}

/**
 * A defect raised by the tester and handed to `builderEmail`, carried through
 * the build to Ready for QA and then into In QA.
 *
 * It comes back with the tester holding it — that is what the hand-off does —
 * so every case below starts from the state the reassignment has to correct.
 */
async function aTestedBuild(
  title: string,
  builderEmail: string,
): Promise<string> {
  const builder = await userId(builderEmail);

  await actAs(TESTER);
  const raised = await createIssue({
    projectId,
    type: "BUG",
    title,
    description: "fixture",
    priority: "MEDIUM",
    assigneeId: builder,
  });
  if (!raised.ok) throw new Error(raised.error);
  created.push(raised.data.id);

  await actAs(builderEmail);
  for (const status of ["IN_PROGRESS", "IN_REVIEW"] as const) {
    const moved = await updateIssue({ issueId: raised.data.id, status });
    if (!moved.ok) throw new Error(moved.error);
  }

  await actAs(TESTER);
  const intoQa = await updateIssue({ issueId: raised.data.id, status: "IN_QA" });
  if (!intoQa.ok) throw new Error(intoQa.error);

  return raised.data.id;
}

beforeAll(async () => {
  projectId = (await projectByKey("ENG")).id;

  ({ leave: leaveTesting } = await joinTestingTeam(TESTER));
  await join(DEVELOPER, DEVELOPMENT_TEAM_SLUG);
  await join(FULLSTACK, TESTING_TEAM_SLUG);
  await join(FULLSTACK, DEVELOPMENT_TEAM_SLUG);

  for (const email of [TESTER, DEVELOPER, FULLSTACK, BYSTANDER]) {
    await putOnProject(email);
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
  if (projectMemberships.length > 0) {
    await prisma.projectMember.deleteMany({
      where: { id: { in: projectMemberships } },
    });
  }
  if (memberships.length > 0) {
    await prisma.teamMember.deleteMany({ where: { id: { in: memberships } } });
  }
  await leaveTesting();
  await prisma.$disconnect();
});

describe("QA reopens work", () => {
  it("sends it back to the developer who marked it Ready for QA", async () => {
    const issueId = await aTestedBuild(`Reopen to builder ${Date.now()}`, DEVELOPER);
    const developerId = await userId(DEVELOPER);
    const testerId = await userId(TESTER);

    /* The state the reassignment has to correct: QA holds it, QA raised it,
       QA created it. Every field on the row points at the tester. */
    expect(await assigneeOf(issueId)).toBe(testerId);

    await actAs(TESTER);
    const reopened = await updateIssue({ issueId, status: "REOPENED" });
    expect(reopened.ok, reopened.ok ? "" : reopened.error).toBe(true);

    // Read back, not trusted from the call: it has to have persisted.
    const row = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: { assigneeId: true, status: true, reporterId: true },
    });
    expect(row.assigneeId).toBe(developerId);
    expect(row.status).toBe("REOPENED");
    // And emphatically none of the fields an easier implementation would read.
    expect(row.assigneeId).not.toBe(testerId);
    expect(row.reporterId).toBe(testerId);
  });

  it("records QA as the actor of both the reopen and the hand-back", async () => {
    const issueId = await aTestedBuild(`Reopen actor ${Date.now()}`, DEVELOPER);
    const developerId = await userId(DEVELOPER);
    const testerId = await userId(TESTER);

    await actAs(TESTER);
    expect((await updateIssue({ issueId, status: "REOPENED" })).ok).toBe(true);

    const entries = await prisma.activityLogEntry.findMany({
      where: { issueId },
      select: { field: true, oldValue: true, newValue: true, actorId: true },
      orderBy: { createdAt: "asc" },
    });

    const reopen = entries.find(
      (row) => row.field === "status" && row.newValue === "REOPENED",
    );
    expect(reopen?.actorId, "QA reopened it").toBe(testerId);

    const handBack = entries.find(
      (row) => row.field === "assigneeId" && row.newValue === developerId,
    );
    expect(handBack, "the hand-back is on the record").toBeTruthy();
    expect(handBack!.oldValue, "it came off the tester").toBe(testerId);
    expect(
      handBack!.actorId,
      "QA sent it back — the developer did not take it",
    ).toBe(testerId);
  });

  it("tells the developer it has gone back to them", async () => {
    const issueId = await aTestedBuild(`Reopen notice ${Date.now()}`, DEVELOPER);
    const developerId = await userId(DEVELOPER);

    await actAs(TESTER);
    expect((await updateIssue({ issueId, status: "REOPENED" })).ok).toBe(true);

    const notice = await prisma.notification.findFirst({
      where: { issueId, userId: developerId, type: "ISSUE_ASSIGNED" },
      select: { message: true },
      orderBy: { createdAt: "desc" },
    });
    expect(notice).not.toBeNull();
    expect(notice!.message).toMatch(/reopened/i);
  });

  it("works for a full stack developer who built it", async () => {
    const issueId = await aTestedBuild(
      `Reopen to full stack ${Date.now()}`,
      FULLSTACK,
    );
    const fullstackId = await userId(FULLSTACK);

    await actAs(TESTER);
    expect((await updateIssue({ issueId, status: "REOPENED" })).ok).toBe(true);

    expect(await assigneeOf(issueId)).toBe(fullstackId);
  });

  it("falls back to whoever had it In Progress when it never reached Ready for QA", async () => {
    const developerId = await userId(DEVELOPER);

    await actAs(TESTER);
    const raised = await createIssue({
      projectId,
      type: "BUG",
      title: `Reopen from in progress ${Date.now()}`,
      description: "fixture",
      priority: "MEDIUM",
      assigneeId: developerId,
    });
    if (!raised.ok) throw new Error(raised.error);
    created.push(raised.data.id);

    await actAs(DEVELOPER);
    expect(
      (await updateIssue({ issueId: raised.data.id, status: "IN_PROGRESS" })).ok,
    ).toBe(true);

    /* Into QA by the administrator, and handed to the tester, so the issue
       reaches the reopen with no Ready for QA entry behind it and with
       somebody other than the developer holding it. */
    await actAs(ADMIN);
    expect(
      (await updateIssue({ issueId: raised.data.id, status: "IN_QA" })).ok,
    ).toBe(true);
    expect(
      (await updateIssue({
        issueId: raised.data.id,
        assigneeId: await userId(TESTER),
      })).ok,
    ).toBe(true);

    await actAs(TESTER);
    expect(
      (await updateIssue({ issueId: raised.data.id, status: "REOPENED" })).ok,
    ).toBe(true);

    expect(await assigneeOf(raised.data.id)).toBe(developerId);
  });

  it("lets an explicit assignee in the same request win", async () => {
    /* Somebody who said where the work should go has made a decision, and the
       rule must not quietly overrule it — the same precedence Ready for QA
       already follows. Done as the administrator, because deciding who builds
       something is not a pure tester's to make. */
    const issueId = await aTestedBuild(`Reopen explicit ${Date.now()}`, DEVELOPER);
    const bystanderId = await userId(BYSTANDER);

    await actAs(ADMIN);
    const reopened = await updateIssue({
      issueId,
      status: "REOPENED",
      assigneeId: bystanderId,
    });
    expect(reopened.ok, reopened.ok ? "" : reopened.error).toBe(true);

    expect(await assigneeOf(issueId)).toBe(bystanderId);
  });

  it("leaves the work where it is when the builder has left the project", async () => {
    /* An assignee who cannot open the issue is a state the rest of Prio
       refuses to create, so where the developer is no longer a member the
       reassignment stands down rather than writing one. */
    const issueId = await aTestedBuild(`Reopen builder gone ${Date.now()}`, DEVELOPER);
    const developerId = await userId(DEVELOPER);
    const testerId = await userId(TESTER);

    const membership = await prisma.projectMember.findUniqueOrThrow({
      where: { projectId_userId: { projectId, userId: developerId } },
      select: { id: true },
    });
    await prisma.projectMember.delete({ where: { id: membership.id } });

    try {
      await actAs(TESTER);
      expect((await updateIssue({ issueId, status: "REOPENED" })).ok).toBe(true);

      expect(await assigneeOf(issueId)).toBe(testerId);
    } finally {
      /* Put the fixture back exactly as it was found — every other file shares
         this database, and a developer silently off ENG would change what they
         see. */
      const restored = await prisma.projectMember.create({
        data: { projectId, userId: developerId },
        select: { id: true },
      });
      projectMemberships.push(restored.id);
    }
  });

  it("does not disturb an issue reopened with no build behind it at all", async () => {
    /* Work parked in the backlog and reopened has no developer to go back to.
       Nothing is invented for it: it stays exactly where it was. */
    await actAs(ADMIN);
    const raised = await createIssue({
      projectId,
      type: "TASK",
      title: `Reopen with no build ${Date.now()}`,
      description: "fixture",
      priority: "MEDIUM",
      status: "IN_QA",
    });
    if (!raised.ok) throw new Error(raised.error);
    created.push(raised.data.id);

    await actAs(TESTER);
    expect(
      (await updateIssue({ issueId: raised.data.id, status: "REOPENED" })).ok,
    ).toBe(true);

    expect(await assigneeOf(raised.data.id)).toBeNull();
  });
});
