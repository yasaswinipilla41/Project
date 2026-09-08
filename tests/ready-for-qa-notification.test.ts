import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createIssue, updateIssue } from "@/server/issues";
import { actAs, joinTestingTeam, projectByKey } from "./helpers";

/**
 * Handing work back for checking (§28).
 *
 * A developer moving an issue to Ready for QA is asking somebody to do
 * something, not merely reporting that a field changed — and the people who
 * have to act on it are the project's testers, who at that moment are usually
 * not assigned to it and therefore not watching it. So the move raises a
 * second notice addressed to them, worded as the request it is.
 *
 * What is asserted here: the testers are told, in readable words; a tester
 * outside the project is not; and the ordinary status line names the status the
 * way the interface does rather than repeating the enum.
 */

const ADMIN = "admin@symbiosystech.com";
const TESTER = "priya.nair@symbiosystech.com";
const DEVELOPER = "kiran.das@symbiosystech.com";

let leaveTeam: () => Promise<void> = async () => {};
let testerId = "";
const createdIssueIds: string[] = [];

beforeAll(async () => {
  ({ userId: testerId, leave: leaveTeam } = await joinTestingTeam(TESTER));
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

/** An ENG issue the developer is holding and has started. */
async function startedIssue(title: string): Promise<{ id: string; key: string }> {
  await actAs(ADMIN);
  const project = await projectByKey("ENG");
  const created = await createIssue({
    projectId: project.id,
    type: "TASK",
    title,
    description: "fixture",
    priority: "MEDIUM",
  });
  if (!created.ok) throw new Error(created.error);
  createdIssueIds.push(created.data.id);

  const developer = await prisma.user.findUniqueOrThrow({
    where: { email: DEVELOPER },
    select: { id: true },
  });
  const assigned = await updateIssue({
    issueId: created.data.id,
    assigneeId: developer.id,
    status: "IN_PROGRESS",
  });
  if (!assigned.ok) throw new Error(assigned.error);

  return { id: created.data.id, key: created.data.key };
}

describe("marking work ready for QA", () => {
  it("asks the project's testers to check it, by name and title", async () => {
    const issue = await startedIssue("Ready for QA — the ask");

    await actAs(DEVELOPER);
    const moved = await updateIssue({ issueId: issue.id, status: "IN_REVIEW" });
    expect(moved.ok).toBe(true);

    const told = await prisma.notification.findMany({
      where: { issueId: issue.id, userId: testerId },
      select: { message: true, type: true },
    });

    const ask = told.filter((n) => /ready for qa/i.test(n.message));
    expect(ask).toHaveLength(1);
    expect(ask[0]!.message).toContain(issue.key);
    expect(ask[0]!.message).toContain("Ready for QA — the ask");
    expect(ask[0]!.type).toBe("STATUS_CHANGED");
  });

  it("names the status the way the interface does, not the enum", async () => {
    const issue = await startedIssue("Ready for QA — wording");

    await actAs(DEVELOPER);
    await updateIssue({ issueId: issue.id, status: "IN_REVIEW" });

    const messages = await prisma.notification.findMany({
      where: { issueId: issue.id },
      select: { message: true },
    });

    expect(messages.length).toBeGreaterThan(0);
    for (const { message } of messages) {
      expect(message, message).not.toContain("IN_REVIEW");
    }
  });

  it("says nothing to a tester who is not on the project", async () => {
    /* The tester is on ENG. An issue raised somewhere they are not a member
       must not reach them — the notice is bounded by what they can open. */
    const project = await prisma.project.findFirstOrThrow({
      where: { members: { none: { userId: testerId } } },
      select: { id: true, key: true },
    });

    await actAs(ADMIN);
    const created = await createIssue({
      projectId: project.id,
      type: "TASK",
      title: "Ready for QA — not their project",
      description: "fixture",
      priority: "MEDIUM",
    });
    if (!created.ok) throw new Error(created.error);
    createdIssueIds.push(created.data.id);

    await updateIssue({ issueId: created.data.id, status: "IN_REVIEW" });

    const told = await prisma.notification.count({
      where: { issueId: created.data.id, userId: testerId },
    });
    expect(told).toBe(0);
  });

  it("does not tell the tester who moved it there themselves", async () => {
    const issue = await startedIssue("Ready for QA — own move");

    /* A tester is refused this move by the status rules, so an administrator
       makes it: the point is only that whoever acts is never notified of their
       own action, which is what would otherwise make this notice noise. */
    await actAs(ADMIN);
    await updateIssue({ issueId: issue.id, status: "IN_REVIEW" });

    const admin = await prisma.user.findUniqueOrThrow({
      where: { email: ADMIN },
      select: { id: true },
    });
    const toSelf = await prisma.notification.count({
      where: { issueId: issue.id, userId: admin.id },
    });
    expect(toSelf).toBe(0);
  });
});
