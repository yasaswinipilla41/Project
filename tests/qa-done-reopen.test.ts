import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TESTING_TEAM_SLUG } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { createIssue, updateIssue } from "@/server/issues";
import { actAs, projectByKey } from "./helpers";

/**
 * QA closes its own verdict, and QA sends work back.
 *
 * `canSetStatus("QA", "IN_QA", "DONE")` is already asserted as a pure
 * function elsewhere. That is not the same claim as "a tester can actually
 * finish an issue", because the pure rule is only one of the gates a real
 * request passes: the server resolves the caller's work role from team
 * membership, applies the transition matrix, applies the authority lists, and
 * then writes. This file asserts the whole of that path through the real
 * `updateIssue`, and reads the row back out of the database afterwards — a
 * status that is accepted but not persisted is the failure mode a
 * function-level test cannot see.
 *
 * Both halves of the QA verdict are covered, because they are one decision
 * with two outcomes: In QA → Done when verification succeeded, In QA →
 * Reopen when it did not.
 */

const ADMIN = "admin@symbiosystech.com";
/** Put on Testing here, so the fixture owns the role rather than the seed. */
const TESTER = "priya.nair@symbiosystech.com";
/** On neither team, so a developer by the long-standing default. */
const DEVELOPER = "kiran.das@symbiosystech.com";

const createdIssueIds: string[] = [];
const membershipIds: string[] = [];

async function userId(email: string): Promise<string> {
  const row = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: { id: true },
  });
  return row.id;
}

async function joinTesting(email: string): Promise<void> {
  const [user, team] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } }),
    prisma.team.findUniqueOrThrow({
      where: { slug: TESTING_TEAM_SLUG },
      select: { id: true },
    }),
  ]);
  const row = await prisma.teamMember.upsert({
    where: { teamId_userId: { teamId: team.id, userId: user.id } },
    update: {},
    create: { teamId: team.id, userId: user.id },
    select: { id: true },
  });
  membershipIds.push(row.id);
}

/** An issue in ENG, filed by the administrator and parked in `status`. */
async function anIssueInQa(title: string, status: "IN_QA" | "IN_REVIEW") {
  await actAs(ADMIN);
  const project = await projectByKey("ENG");
  const created = await createIssue({
    projectId: project.id,
    type: "BUG",
    title,
    priority: "MEDIUM",
    status,
  });
  if (!created.ok) throw new Error(created.error);
  createdIssueIds.push(created.data.id);
  return created.data.id;
}

async function statusOf(issueId: string) {
  const row = await prisma.issue.findUniqueOrThrow({
    where: { id: issueId },
    select: { status: true },
  });
  return row.status;
}

beforeAll(async () => {
  await joinTesting(TESTER);
  // The tester has to be able to open ENG before they can act on its work.
  const project = await projectByKey("ENG");
  await prisma.projectMember.upsert({
    where: {
      projectId_userId: { projectId: project.id, userId: await userId(TESTER) },
    },
    update: {},
    create: { projectId: project.id, userId: await userId(TESTER) },
  });
});

afterAll(async () => {
  await prisma.issue.deleteMany({ where: { id: { in: createdIssueIds } } });
  await prisma.teamMember.deleteMany({ where: { id: { in: membershipIds } } });
});

describe("QA finishes work", () => {
  it("moves an issue from In QA to Done, and it stays Done", async () => {
    const issueId = await anIssueInQa("QA closes this one", "IN_QA");

    await actAs(TESTER);
    const result = await updateIssue({ issueId, status: "DONE" });

    expect(result.ok).toBe(true);
    // Read back rather than trusting the action's own return: the claim is
    // that Done persisted, not that the call returned without complaint.
    expect(await statusOf(issueId)).toBe("DONE");
  });

  it("records the move in the activity trail", async () => {
    const issueId = await anIssueInQa("QA closes this too", "IN_QA");

    await actAs(TESTER);
    await updateIssue({ issueId, status: "DONE" });

    const entries = await prisma.activityLogEntry.findMany({
      where: { issueId, field: "status" },
      select: { oldValue: true, newValue: true, actorId: true },
    });
    expect(entries).toContainEqual({
      oldValue: "IN_QA",
      newValue: "DONE",
      actorId: await userId(TESTER),
    });
  });

  it("refuses Done straight from Ready for QA, naming what it may set", async () => {
    const issueId = await anIssueInQa("Not tested yet", "IN_REVIEW");

    await actAs(TESTER);
    const result = await updateIssue({ issueId, status: "DONE" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("In QA");
    expect(await statusOf(issueId)).toBe("IN_REVIEW");
  });
});

describe("QA sends work back", () => {
  it("moves an issue from In QA to Reopen, and it stays Reopen", async () => {
    const issueId = await anIssueInQa("QA sends this back", "IN_QA");

    await actAs(TESTER);
    const result = await updateIssue({ issueId, status: "REOPENED" });

    expect(result.ok).toBe(true);
    expect(await statusOf(issueId)).toBe("REOPENED");
  });

  it("leaves reopened work available to a developer again", async () => {
    const issueId = await anIssueInQa("Back to the developer", "IN_QA");

    await actAs(TESTER);
    await updateIssue({ issueId, status: "REOPENED" });

    await actAs(DEVELOPER);
    const result = await updateIssue({ issueId, status: "IN_PROGRESS" });

    expect(result.ok).toBe(true);
    expect(await statusOf(issueId)).toBe("IN_PROGRESS");
  });
});

describe("nobody else is let through", () => {
  it("refuses a developer trying to mark work Done", async () => {
    const issueId = await anIssueInQa("A developer cannot close this", "IN_QA");

    await actAs(DEVELOPER);
    const result = await updateIssue({ issueId, status: "DONE" });

    expect(result.ok).toBe(false);
    expect(await statusOf(issueId)).toBe("IN_QA");
  });

  it("still lets an administrator close work from Ready for QA", async () => {
    const issueId = await anIssueInQa("An admin may close this", "IN_REVIEW");

    await actAs(ADMIN);
    const result = await updateIssue({ issueId, status: "DONE" });

    expect(result.ok).toBe(true);
    expect(await statusOf(issueId)).toBe("DONE");
  });
});
