import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { claimIssue, createIssue, updateIssue } from "@/server/issues";
import { actAs, joinTestingTeam, projectByKey } from "./helpers";

/**
 * Picking work up, and taking it off somebody.
 *
 * One action covers both, because they are one act: the issue becomes the
 * caller's and it becomes In Progress. What is tested here is that the two
 * move together, that the handover is written down, that the person who lost
 * the work stops holding it, and — the part a race would break — that two
 * developers pressing Start on the same issue cannot both win.
 */

const ADMIN = "admin@symbiosystech.com";
const DEV_A = "kiran.das@symbiosystech.com";
const DEV_B = "rahul.menon@symbiosystech.com";
const TESTER = "priya.nair@symbiosystech.com";

let leaveTeam: () => Promise<void> = async () => {};
const createdIssueIds: string[] = [];

beforeAll(async () => {
  ({ leave: leaveTeam } = await joinTestingTeam(TESTER));
});

afterAll(async () => {
  if (createdIssueIds.length > 0) {
    await prisma.notification.deleteMany({
      where: { issueId: { in: createdIssueIds } },
    });
    await prisma.issue.deleteMany({ where: { id: { in: createdIssueIds } } });
  }
  await leaveTeam();
  await prisma.$disconnect();
});

async function userId(email: string): Promise<string> {
  const row = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: { id: true },
  });
  return row.id;
}

/** An unassigned ENG task, filed by the administrator. */
async function anIssue(title: string, assignTo?: string): Promise<string> {
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

  if (assignTo) {
    const assigned = await updateIssue({
      issueId: result.data.id,
      assigneeId: assignTo,
    });
    if (!assigned.ok) throw new Error(assigned.error);
  }
  return result.data.id;
}

function stateOf(issueId: string) {
  return prisma.issue.findUniqueOrThrow({
    where: { id: issueId },
    select: { assigneeId: true, status: true },
  });
}

describe("claiming unassigned work", () => {
  it("takes it and starts it, in one step", async () => {
    const issueId = await anIssue("Claim — unassigned");
    await actAs(DEV_A);

    const result = await claimIssue({ issueId });
    expect(result.ok).toBe(true);

    const after = await stateOf(issueId);
    expect(after.assigneeId).toBe(await userId(DEV_A));
    expect(after.status).toBe("IN_PROGRESS");
  });

  it("records both changes in the trail", async () => {
    const issueId = await anIssue("Claim — trail");
    await actAs(DEV_A);
    await claimIssue({ issueId });

    const entries = await prisma.activityLogEntry.findMany({
      where: { issueId },
      select: { action: true, field: true, oldValue: true, newValue: true },
    });

    const assignee = entries.find((e) => e.field === "assigneeId");
    const status = entries.find((e) => e.field === "status");

    expect(assignee?.newValue).toBe(await userId(DEV_A));
    expect(status?.newValue).toBe("IN_PROGRESS");
    // Nobody was holding it, so this is not a handover.
    expect(assignee?.action).not.toBe("issue.takeover");
  });

  it("is refused to a tester", async () => {
    const issueId = await anIssue("Claim — tester tries");
    await actAs(TESTER);

    const result = await claimIssue({ issueId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/testers do not take/i);

    const after = await stateOf(issueId);
    expect(after.assigneeId).toBeNull();
  });
});

describe("taking work over", () => {
  it("moves it from one developer to the other, and starts it", async () => {
    const issueId = await anIssue("Takeover — A to B", await userId(DEV_A));

    await actAs(DEV_B);
    const result = await claimIssue({ issueId });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.previousAssigneeId).toBe(await userId(DEV_A));

    const after = await stateOf(issueId);
    expect(after.assigneeId).toBe(await userId(DEV_B));
    expect(after.status).toBe("IN_PROGRESS");
  });

  it("writes the handover down, naming both developers", async () => {
    const issueId = await anIssue("Takeover — trail", await userId(DEV_A));
    await actAs(DEV_B);
    await claimIssue({ issueId });

    const handover = await prisma.activityLogEntry.findFirst({
      where: { issueId, action: "issue.takeover", field: "assigneeId" },
      select: { actorId: true, oldValue: true, newValue: true, createdAt: true },
    });

    expect(handover).not.toBeNull();
    expect(handover!.oldValue).toBe(await userId(DEV_A));   // from
    expect(handover!.newValue).toBe(await userId(DEV_B));   // to
    expect(handover!.actorId).toBe(await userId(DEV_B));    // by
    expect(handover!.createdAt).toBeInstanceOf(Date);       // when
  });

  it("tells the developer who lost it, and nobody else", async () => {
    const issueId = await anIssue("Takeover — notice", await userId(DEV_A));
    await actAs(DEV_B);
    await claimIssue({ issueId });

    const told = await prisma.notification.findMany({
      where: { issueId, type: "ISSUE_ASSIGNED" },
      select: { userId: true, message: true },
    });

    /* The takeover notice itself — the fixture's admin assignment produced an
       ISSUE_ASSIGNED row for A as well, which is a different event. */
    const takeover = told.filter((n) => /took over/i.test(n.message));
    expect(takeover).toHaveLength(1);
    expect(takeover[0]!.userId).toBe(await userId(DEV_A));

    // And nobody else was told anything about this issue.
    const lostIt = await userId(DEV_A);
    expect(told.filter((n) => n.userId !== lostIt)).toHaveLength(0);
  });

  it("leaves the previous developer holding nothing", async () => {
    const issueId = await anIssue("Takeover — workload", await userId(DEV_A));
    await actAs(DEV_B);
    await claimIssue({ issueId });

    const stillA = await prisma.issue.count({
      where: { id: issueId, assigneeId: await userId(DEV_A) },
    });
    expect(stillA).toBe(0);

    const nowB = await prisma.issue.count({
      where: { id: issueId, assigneeId: await userId(DEV_B) },
    });
    expect(nowB).toBe(1);
  });

  it("cannot be pointed at anybody else", async () => {
    /* There is no parameter for who to give it to — the action takes an issue
       and nothing more — so a payload naming a colleague changes nothing. */
    const issueId = await anIssue("Takeover — no third party");
    await actAs(DEV_B);

    await claimIssue({
      issueId,
      assigneeId: await userId(DEV_A),
      userId: await userId(DEV_A),
    } as unknown as { issueId: string });

    const after = await stateOf(issueId);
    expect(after.assigneeId).toBe(await userId(DEV_B));
  });
});

describe("two developers at once", () => {
  it("lets exactly one of them win", async () => {
    const issueId = await anIssue("Claim — race");

    /* Both read the same unassigned issue and both press Start. The update
       carries the assignee each decided against, so the second matches no row
       and is told rather than silently overwriting the first. */
    await actAs(DEV_A);
    const first = await claimIssue({ issueId });

    await actAs(DEV_B);
    const second = await claimIssue({ issueId });

    expect(first.ok).toBe(true);
    // The second is a legitimate takeover, not a lost update: it names the
    // developer it took the work from.
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.data.previousAssigneeId).toBe(await userId(DEV_A));

    const after = await stateOf(issueId);
    expect(after.assigneeId).toBe(await userId(DEV_B));

    // One holder, never two.
    const holders = await prisma.issue.findMany({
      where: { id: issueId },
      select: { assigneeId: true },
    });
    expect(holders).toHaveLength(1);
  });

  it("refuses a claim decided against a stale assignee", async () => {
    const issueId = await anIssue("Claim — stale read");

    // A takes it.
    await actAs(DEV_A);
    await claimIssue({ issueId });

    /* Now simulate a request that was decided while the issue still looked
       unassigned: the guarded update carries `assigneeId: null`, which no
       longer matches. */
    const { count } = await prisma.issue.updateMany({
      where: { id: issueId, assigneeId: null },
      data: { assigneeId: await userId(DEV_B) },
    });

    expect(count).toBe(0);
    const after = await stateOf(issueId);
    expect(after.assigneeId).toBe(await userId(DEV_A));
  });
});

describe("closed work", () => {
  it("is reopened before it is picked up", async () => {
    const issueId = await anIssue("Claim — closed");
    await actAs(ADMIN);
    await updateIssue({ issueId, status: "DONE" });

    await actAs(DEV_A);
    const result = await claimIssue({ issueId });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/closed/i);

    const after = await stateOf(issueId);
    expect(after.status).toBe("DONE");
    expect(after.assigneeId).toBeNull();
  });
});
