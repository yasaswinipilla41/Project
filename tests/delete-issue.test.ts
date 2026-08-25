import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { deleteIssue } from "@/server/issues";
import { actAs, actAsAnonymous, projectByKey } from "./helpers";

/**
 * Deleting an issue.
 *
 * The permission shape mirrors project deletion and comment deletion: the
 * reporter or an administrator, and nobody else — specifically, not just any
 * project member. `updateIssue` already lets any member edit an issue, so this
 * is the one property that actually needs pinning down here: that editing
 * access and delete access are NOT the same thing.
 */

const ADMIN = "admin@symbiosystech.com";
const REPORTER = "priya.nair@symbiosystech.com";
const OTHER_MEMBER = "kiran.das@symbiosystech.com";

const createdIssues: string[] = [];

afterAll(async () => {
  if (createdIssues.length > 0) {
    // Some of these were deleted mid-test; only remove what's still there.
    await prisma.issue.deleteMany({ where: { id: { in: createdIssues } } });
  }
  await prisma.$disconnect();
});

/** A fresh issue reported by REPORTER, so deletion never touches seed data. */
async function makeIssue() {
  const project = await projectByKey("ENG");
  const reporter = await prisma.user.findUniqueOrThrow({
    where: { email: REPORTER },
  });

  const issue = await prisma.$transaction(async (tx) => {
    const updated = await tx.project.update({
      where: { id: project.id },
      data: { issueSequence: { increment: 1 } },
      select: { issueSequence: true, key: true },
    });
    return tx.issue.create({
      data: {
        key: `${updated.key}-${updated.issueSequence}`,
        number: updated.issueSequence,
        projectId: project.id,
        type: "TASK",
        title: "Delete-fixture issue",
        reporterId: reporter.id,
      },
      select: { id: true, key: true },
    });
  });

  createdIssues.push(issue.id);
  return issue;
}

describe("who may delete an issue", () => {
  it("lets the reporter delete their own issue", async () => {
    const issue = await makeIssue();
    await actAs(REPORTER);

    const result = await deleteIssue(issue.id);

    expect(result.ok).toBe(true);
    expect(await prisma.issue.count({ where: { id: issue.id } })).toBe(0);
  });

  it("lets an administrator delete an issue they did not report", async () => {
    const issue = await makeIssue();
    await actAs(ADMIN);

    const result = await deleteIssue(issue.id);

    expect(result.ok).toBe(true);
    expect(await prisma.issue.count({ where: { id: issue.id } })).toBe(0);
  });

  it("refuses another project member — editing access is not delete access", async () => {
    const issue = await makeIssue();
    await actAs(OTHER_MEMBER);

    const result = await deleteIssue(issue.id);

    expect(result.ok).toBe(false);
    // Nothing changed: the issue survives exactly as it was.
    expect(await prisma.issue.count({ where: { id: issue.id } })).toBe(1);
  });

  it("refuses an unauthenticated caller", async () => {
    const issue = await makeIssue();
    actAsAnonymous();

    const result = await deleteIssue(issue.id);

    expect(result.ok).toBe(false);
    expect(await prisma.issue.count({ where: { id: issue.id } })).toBe(1);
  });

  it("says the issue does not exist rather than that it is forbidden", async () => {
    await actAs(OTHER_MEMBER);

    const result = await deleteIssue("clzzzzzzzzzzzzzzzzzzzzzzz");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/no longer exists/i);
    }
  });
});

describe("deleting takes its dependents with it, safely", () => {
  it("removes comments, mentions and activity, and orphans no records", async () => {
    const issue = await makeIssue();
    const reporter = await prisma.user.findUniqueOrThrow({
      where: { email: REPORTER },
    });

    const comment = await prisma.comment.create({
      data: {
        issueId: issue.id,
        authorId: reporter.id,
        body: "This should not outlive the issue.",
        mentions: { create: { userId: reporter.id } },
      },
      select: { id: true },
    });

    await prisma.activityLogEntry.create({
      data: { issueId: issue.id, actorId: reporter.id, action: "issue.created" },
    });

    await actAs(REPORTER);
    const result = await deleteIssue(issue.id);
    expect(result.ok).toBe(true);

    expect(await prisma.issue.count({ where: { id: issue.id } })).toBe(0);
    expect(await prisma.comment.count({ where: { id: comment.id } })).toBe(0);
    expect(
      await prisma.commentMention.count({ where: { commentId: comment.id } }),
    ).toBe(0);
    expect(
      await prisma.activityLogEntry.count({ where: { issueId: issue.id } }),
    ).toBe(0);
  });

  it("orphans a sub-issue's parent link rather than deleting the sub-issue", async () => {
    const parent = await makeIssue();
    const project = await projectByKey("ENG");
    const reporter = await prisma.user.findUniqueOrThrow({
      where: { email: REPORTER },
    });

    const child = await prisma.$transaction(async (tx) => {
      const updated = await tx.project.update({
        where: { id: project.id },
        data: { issueSequence: { increment: 1 } },
        select: { issueSequence: true, key: true },
      });
      return tx.issue.create({
        data: {
          key: `${updated.key}-${updated.issueSequence}`,
          number: updated.issueSequence,
          projectId: project.id,
          type: "TASK",
          title: "Sub-issue of the delete fixture",
          reporterId: reporter.id,
          parentId: parent.id,
        },
        select: { id: true },
      });
    });
    createdIssues.push(child.id);

    await actAs(REPORTER);
    const result = await deleteIssue(parent.id);
    expect(result.ok).toBe(true);

    // The child survives — deleting a parent must not cascade to its children.
    const row = await prisma.issue.findUnique({
      where: { id: child.id },
      select: { parentId: true },
    });
    expect(row).not.toBeNull();
    expect(row?.parentId).toBeNull();
  });

  it("removes both directions of an issue link", async () => {
    const a = await makeIssue();
    const b = await makeIssue();
    const reporter = await prisma.user.findUniqueOrThrow({
      where: { email: REPORTER },
    });

    await prisma.issueLink.createMany({
      data: [
        {
          sourceId: a.id,
          targetId: b.id,
          type: "BLOCKS",
          createdById: reporter.id,
        },
        {
          sourceId: b.id,
          targetId: a.id,
          type: "IS_BLOCKED_BY",
          createdById: reporter.id,
        },
      ],
    });

    await actAs(REPORTER);
    const result = await deleteIssue(a.id);
    expect(result.ok).toBe(true);

    expect(
      await prisma.issueLink.count({
        where: { OR: [{ sourceId: a.id }, { targetId: a.id }] },
      }),
    ).toBe(0);
  });

  it("leaves every other issue in the project untouched", async () => {
    const before = await prisma.issue.count();

    const issue = await makeIssue();
    await actAs(REPORTER);
    await deleteIssue(issue.id);

    const after = await prisma.issue.count();
    expect(after).toBe(before);
  });
});
