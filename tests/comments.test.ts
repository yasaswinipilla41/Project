import { afterAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  createComment,
  deleteComment,
  listMentionable,
  updateComment,
} from "@/server/comments";
import { actAs, actAsAnonymous, projectByKey } from "./helpers";

/**
 * Comments, mentions and the notifications they produce.
 *
 * Two properties matter most and are tested from the server side, where they
 * are enforced:
 *
 *  - a comment can only be written on an issue the author can already read;
 *  - a mention can only ever name somebody who can already read that issue.
 *
 * Email is stubbed. The point of these tests is what is written to the
 * database, and a test that waited on SMTP would be testing Mailpit.
 */

vi.mock("@/server/mailer", () => ({
  sendIssueMail: async () => ({ sent: 0, skipped: true }),
  sendIssueMailInBackground: () => undefined,
  setMailTransport: () => undefined,
}));

const ADMIN = "admin@symbiosystech.com";
const MEMBER = "priya.nair@symbiosystech.com";
const OTHER_MEMBER = "kiran.das@symbiosystech.com";
/** Belongs to no project the fixtures use. */
const OUTSIDER = "sneha.iyer@symbiosystech.com";

const createdComments: string[] = [];
const createdIssues: string[] = [];

afterAll(async () => {
  if (createdComments.length > 0) {
    await prisma.comment.deleteMany({ where: { id: { in: createdComments } } });
  }
  if (createdIssues.length > 0) {
    await prisma.issue.deleteMany({ where: { id: { in: createdIssues } } });
  }
  await prisma.$disconnect();
});

/** An issue in ENG, which both members belong to. */
async function anIssue() {
  const project = await projectByKey("ENG");
  const issue = await prisma.issue.findFirstOrThrow({
    where: { projectId: project.id },
    select: { id: true, key: true, projectId: true },
    orderBy: { number: "asc" },
  });
  return issue;
}

describe("writing a comment", () => {
  it("stores it and records an activity entry", async () => {
    const author = await actAs(MEMBER);
    const issue = await anIssue();

    const before = await prisma.activityLogEntry.count({
      where: { issueId: issue.id, action: "comment.created" },
    });

    const result = await createComment({
      issueId: issue.id,
      body: "Checked this against the staging build and it still reproduces.",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdComments.push(result.data.id);

    const row = await prisma.comment.findUniqueOrThrow({
      where: { id: result.data.id },
      select: { body: true, authorId: true, issueId: true, editedAt: true },
    });

    expect(row.authorId).toBe(author.id);
    expect(row.issueId).toBe(issue.id);
    expect(row.body).toContain("still reproduces");
    expect(row.editedAt).toBeNull();

    const after = await prisma.activityLogEntry.count({
      where: { issueId: issue.id, action: "comment.created" },
    });
    expect(after).toBe(before + 1);
  });

  it("stores exactly what was typed, markup and all", async () => {
    await actAs(MEMBER);
    const issue = await anIssue();

    const payload = "<script>alert(1)</script> and **bold**";
    const result = await createComment({ issueId: issue.id, body: payload });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdComments.push(result.data.id);

    const row = await prisma.comment.findUniqueOrThrow({
      where: { id: result.data.id },
      select: { body: true },
    });

    /* Nothing is stripped on the way in. Safety comes from never rendering the
       stored text as HTML — see tests/richtext.test.ts — not from mangling what
       somebody wrote, which would also corrupt legitimate code samples. */
    expect(row.body).toBe(payload);
  });

  it("refuses an empty comment", async () => {
    await actAs(MEMBER);
    const issue = await anIssue();

    const result = await createComment({ issueId: issue.id, body: "   \n  " });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fieldErrors?.body).toBeDefined();
    }
  });

  it("refuses an unauthenticated caller", async () => {
    actAsAnonymous();
    const issue = await anIssue();

    const before = await prisma.comment.count({ where: { issueId: issue.id } });
    const result = await createComment({
      issueId: issue.id,
      body: "Should never be stored.",
    });

    expect(result.ok).toBe(false);
    expect(await prisma.comment.count({ where: { issueId: issue.id } })).toBe(
      before,
    );
  });

  it("refuses someone who cannot read the issue", async () => {
    /* A project the outsider does not belong to. Built here so the test does
       not depend on the seed's membership staying the way it is today. */
    const owner = await prisma.user.findUniqueOrThrow({ where: { email: ADMIN } });
    const outsider = await prisma.user.findUniqueOrThrow({
      where: { email: OUTSIDER },
    });

    const project = await prisma.project.create({
      data: {
        name: "Closed Fixture",
        key: `CF${Date.now().toString(36).slice(-5).toUpperCase()}`,
        createdById: owner.id,
        members: { create: { userId: owner.id } },
      },
      select: { id: true, key: true },
    });

    const issue = await prisma.issue.create({
      data: {
        key: `${project.key}-1`,
        number: 1,
        projectId: project.id,
        type: "TASK",
        title: "Not visible to everyone",
        reporterId: owner.id,
      },
      select: { id: true },
    });

    try {
      await actAs(OUTSIDER);
      const result = await createComment({
        issueId: issue.id,
        body: "I should not be able to write here.",
      });

      expect(result.ok).toBe(false);
      expect(await prisma.comment.count({ where: { issueId: issue.id } })).toBe(0);

      // And the outsider is not offered anyone to mention there either.
      const people = await listMentionable(issue.id);
      expect(people.ok).toBe(false);
      expect(outsider.id).toBeTruthy();
    } finally {
      await prisma.project.delete({ where: { id: project.id } });
    }
  });
});

describe("mentions", () => {
  it("records a mention and notifies the person named", async () => {
    const author = await actAs(MEMBER);
    const issue = await anIssue();

    const mentioned = await prisma.user.findUniqueOrThrow({
      where: { email: OTHER_MEMBER },
      select: { id: true, name: true },
    });

    const result = await createComment({
      issueId: issue.id,
      body: `@${mentioned.name} could you take a look?`,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdComments.push(result.data.id);

    const mentions = await prisma.commentMention.findMany({
      where: { commentId: result.data.id },
      select: { userId: true },
    });
    expect(mentions.map((m) => m.userId)).toEqual([mentioned.id]);

    const notification = await prisma.notification.findFirst({
      where: {
        userId: mentioned.id,
        commentId: result.data.id,
        type: "MENTIONED",
      },
      select: { message: true, actorId: true },
    });

    expect(notification).not.toBeNull();
    expect(notification?.actorId).toBe(author.id);
    expect(notification?.message).toContain(author.name);
  });

  it("does not notify the author for mentioning themselves", async () => {
    const author = await actAs(MEMBER);
    const issue = await anIssue();

    const result = await createComment({
      issueId: issue.id,
      body: `@${author.name} note to self`,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdComments.push(result.data.id);

    const own = await prisma.notification.count({
      where: { userId: author.id, commentId: result.data.id },
    });
    expect(own).toBe(0);
  });

  it("ignores a name that belongs to nobody on the project", async () => {
    await actAs(MEMBER);
    const issue = await anIssue();

    const result = await createComment({
      issueId: issue.id,
      body: "@Nobody At All please advise",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdComments.push(result.data.id);

    expect(
      await prisma.commentMention.count({ where: { commentId: result.data.id } }),
    ).toBe(0);
  });

  it("offers only people who can read the issue", async () => {
    const user = await actAs(MEMBER);
    const issue = await anIssue();

    const result = await listMentionable(issue.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const offeredIds = result.data.map((p) => p.id);
    expect(offeredIds).toContain(user.id);

    // Everyone offered must genuinely be able to open the issue: a member of
    // the project, or an administrator.
    for (const id of offeredIds) {
      const [membership, person] = await Promise.all([
        prisma.projectMember.count({
          where: { projectId: issue.projectId, userId: id },
        }),
        prisma.user.findUniqueOrThrow({
          where: { id },
          select: { role: true, isActive: true },
        }),
      ]);

      expect(membership > 0 || person.role === "ADMIN").toBe(true);
      expect(person.isActive).toBe(true);
    }
  });
});

describe("editing and deleting", () => {
  async function ownComment() {
    const issue = await anIssue();
    const result = await createComment({
      issueId: issue.id,
      body: "Original text.",
    });
    if (!result.ok) throw new Error(result.error);
    createdComments.push(result.data.id);
    return result.data.id;
  }

  it("lets the author edit their own comment and stamps it", async () => {
    await actAs(MEMBER);
    const commentId = await ownComment();

    const result = await updateComment({
      commentId,
      body: "Corrected text.",
    });

    expect(result.ok).toBe(true);

    const row = await prisma.comment.findUniqueOrThrow({
      where: { id: commentId },
      select: { body: true, editedAt: true },
    });
    expect(row.body).toBe("Corrected text.");
    expect(row.editedAt).not.toBeNull();
  });

  it("refuses to let anyone else edit it — including an administrator", async () => {
    await actAs(MEMBER);
    const commentId = await ownComment();

    for (const email of [OTHER_MEMBER, ADMIN]) {
      await actAs(email);
      const result = await updateComment({
        commentId,
        body: `Rewritten by ${email}.`,
      });
      expect(result.ok).toBe(false);
    }

    const row = await prisma.comment.findUniqueOrThrow({
      where: { id: commentId },
      select: { body: true },
    });
    // An audit trail somebody else can rewrite is not an audit trail.
    expect(row.body).toBe("Original text.");
  });

  it("replaces mentions when an edit removes a name", async () => {
    await actAs(MEMBER);
    const issue = await anIssue();
    const other = await prisma.user.findUniqueOrThrow({
      where: { email: OTHER_MEMBER },
      select: { id: true, name: true },
    });

    const created = await createComment({
      issueId: issue.id,
      body: `@${other.name} first draft`,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    createdComments.push(created.data.id);

    expect(
      await prisma.commentMention.count({ where: { commentId: created.data.id } }),
    ).toBe(1);

    await updateComment({ commentId: created.data.id, body: "second draft" });

    expect(
      await prisma.commentMention.count({ where: { commentId: created.data.id } }),
    ).toBe(0);
  });

  it("lets the author delete their own comment", async () => {
    await actAs(MEMBER);
    const commentId = await ownComment();

    const result = await deleteComment(commentId);
    expect(result.ok).toBe(true);
    expect(await prisma.comment.count({ where: { id: commentId } })).toBe(0);
  });

  it("lets an administrator delete somebody else's comment", async () => {
    await actAs(MEMBER);
    const commentId = await ownComment();

    await actAs(ADMIN);
    const result = await deleteComment(commentId);

    expect(result.ok).toBe(true);
    expect(await prisma.comment.count({ where: { id: commentId } })).toBe(0);
  });

  it("refuses another member", async () => {
    await actAs(MEMBER);
    const commentId = await ownComment();

    await actAs(OTHER_MEMBER);
    const result = await deleteComment(commentId);

    expect(result.ok).toBe(false);
    expect(await prisma.comment.count({ where: { id: commentId } })).toBe(1);
  });

  it("records the deletion even though the comment is gone", async () => {
    await actAs(MEMBER);
    const issue = await anIssue();
    const commentId = await ownComment();

    const before = await prisma.activityLogEntry.count({
      where: { issueId: issue.id, action: "comment.deleted" },
    });

    await deleteComment(commentId);

    const after = await prisma.activityLogEntry.count({
      where: { issueId: issue.id, action: "comment.deleted" },
    });
    expect(after).toBe(before + 1);
  });
});
