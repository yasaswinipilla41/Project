import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COMMENT_ACTIONS, isCommentAction } from "@/lib/activity";
import { prisma } from "@/lib/prisma";
import { createComment, deleteComment, updateComment } from "@/server/comments";
import { createIssue } from "@/server/issues";
import { listActivity } from "@/server/queries/activity";
import { requireUser } from "@/lib/session";
import { actAs, projectByKey } from "./helpers";

/**
 * The comment audit trail, and the Activity feed's view of it.
 *
 * The claim worth testing is not that a comment can be written — it is that
 * the record of what happened to a comment outlives the comment. An audit
 * trail that disappears along with the thing it was auditing is not a trail,
 * and the only reason this one survives is structural: an activity row belongs
 * to the *issue*, so removing a comment cannot cascade to it.
 */

describe("comment audit", () => {
  const issues: string[] = [];
  let actorId = "";

  beforeAll(async () => {
    await actAs("admin@symbiosystech.com");
    actorId = (await requireUser()).id;
  });

  afterAll(async () => {
    if (issues.length > 0) {
      await prisma.issue.deleteMany({ where: { id: { in: issues } } });
    }
  });

  async function anIssue(title: string): Promise<string> {
    const project = await projectByKey("ENG");
    const result = await createIssue({
      projectId: project.id,
      type: "TASK",
      title,
      description: "Created by the integration suite.",
      status: "TODO",
    });
    if (!result.ok) throw new Error("fixture not created");
    issues.push(result.data.id);
    return result.data.id;
  }

  function actionsFor(issueId: string) {
    return prisma.activityLogEntry.findMany({
      where: { issueId, action: { in: [...COMMENT_ACTIONS] } },
      orderBy: { createdAt: "asc" },
      select: { action: true, actorId: true },
    });
  }

  it("records a row for each of writing, editing and deleting", async () => {
    const issueId = await anIssue("Audit fixture: full life");

    const created = await createComment({
      issueId,
      body: "First version.",
      attachmentIds: [],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(
      await updateComment({
        commentId: created.data.id,
        body: "Second version.",
      }),
    ).toMatchObject({ ok: true });

    expect(await deleteComment(created.data.id)).toMatchObject({ ok: true });

    const rows = await actionsFor(issueId);
    expect(rows.map((row) => row.action)).toEqual([
      "comment.created",
      "comment.edited",
      "comment.deleted",
    ]);
    // Every row names who did it, or the trail cannot answer the one question
    // it exists to answer.
    expect(rows.every((row) => row.actorId === actorId)).toBe(true);
  });

  it("keeps the deletion record after the comment row is gone", async () => {
    const issueId = await anIssue("Audit fixture: survives deletion");

    const created = await createComment({
      issueId,
      body: "This one gets removed.",
      attachmentIds: [],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(await deleteComment(created.data.id)).toMatchObject({ ok: true });

    // The comment really is gone...
    expect(await prisma.comment.count({ where: { id: created.data.id } })).toBe(
      0,
    );

    // ...and the record of its removal is not.
    const actions = (await actionsFor(issueId)).map((row) => row.action);
    expect(actions).toContain("comment.deleted");
  });

  it("survives deletion of the whole thread it belonged to", async () => {
    /* A reply cascades when its parent goes. The audit rows must not — and
       cannot, because they hang off the issue rather than off a comment. */
    const issueId = await anIssue("Audit fixture: threaded");

    const parent = await createComment({
      issueId,
      body: "Parent.",
      attachmentIds: [],
    });
    if (!parent.ok) throw new Error("parent not created");

    const reply = await createComment({
      issueId,
      body: "Reply.",
      parentId: parent.data.id,
      attachmentIds: [],
    });
    if (!reply.ok) throw new Error("reply not created");

    expect(await deleteComment(parent.data.id)).toMatchObject({ ok: true });

    // The reply went with its parent.
    expect(await prisma.comment.count({ where: { id: reply.data.id } })).toBe(0);

    // Both creations and the deletion are still on record.
    const actions = (await actionsFor(issueId)).map((row) => row.action);
    expect(actions.filter((a) => a === "comment.created")).toHaveLength(2);
    expect(actions.filter((a) => a === "comment.deleted")).toHaveLength(1);
  });

  it("appends rather than rewriting what it already recorded", async () => {
    const issueId = await anIssue("Audit fixture: append only");

    const created = await createComment({
      issueId,
      body: "Original.",
      attachmentIds: [],
    });
    if (!created.ok) throw new Error("not created");

    const before = await actionsFor(issueId);
    await updateComment({ commentId: created.data.id, body: "Changed." });
    const after = await actionsFor(issueId);

    // Editing adds a row; it does not replace the creation row.
    expect(after).toHaveLength(before.length + 1);
    expect(after[0]?.action).toBe("comment.created");
  });
});

describe("the Activity feed reads comment audit", () => {
  const issues: string[] = [];

  beforeAll(async () => {
    await actAs("admin@symbiosystech.com");
  });

  afterAll(async () => {
    if (issues.length > 0) {
      await prisma.issue.deleteMany({ where: { id: { in: issues } } });
    }
  });

  it("returns only comment events for the Comments type", async () => {
    const user = await requireUser();
    const project = await projectByKey("ENG");
    const result = await createIssue({
      projectId: project.id,
      type: "TASK",
      title: "Activity fixture: comment kind",
      description: "Created by the integration suite.",
      status: "TODO",
    });
    if (!result.ok) throw new Error("fixture not created");
    issues.push(result.data.id);

    expect(
      await createComment({
        issueId: result.data.id,
        body: "Something to find.",
        attachmentIds: [],
      }),
    ).toMatchObject({ ok: true });

    const feed = await listActivity(user, { type: "comment" });

    expect(feed.total).toBeGreaterThan(0);
    /* Every row really is a comment event. The query used to key off `field`,
       which a comment row never sets, so before this these read as
       assignments — the feed did not merely omit them, it mislabelled them. */
    expect(feed.rows.every((row) => row.kind === "comment")).toBe(true);
    expect(
      feed.rows.every((row) => isCommentAction(row.commentAction ?? "")),
    ).toBe(true);
    // A comment says nothing about an assignee or a status.
    expect(feed.rows.every((row) => row.assigneeName === undefined)).toBe(true);
    expect(feed.rows.every((row) => row.toStatus === undefined)).toBe(true);
  });

  it("includes comment events in the unfiltered feed", async () => {
    const user = await requireUser();
    const [all, comments] = await Promise.all([
      listActivity(user, {}),
      listActivity(user, { type: "comment" }),
    ]);

    expect(comments.total).toBeGreaterThan(0);
    // "All activity" is the union of the kinds the feed can say, so it cannot
    // be smaller than any one of them.
    expect(all.total).toBeGreaterThanOrEqual(comments.total);
  });

  it("still separates assignments from status changes", async () => {
    const user = await requireUser();
    const [assignments, statuses] = await Promise.all([
      listActivity(user, { type: "assignment" }),
      listActivity(user, { type: "status" }),
    ]);

    expect(assignments.rows.every((row) => row.kind === "assignment")).toBe(
      true,
    );
    expect(statuses.rows.every((row) => row.kind === "status")).toBe(true);
  });

  it("scopes the feed to one project when asked", async () => {
    const user = await requireUser();
    const project = await projectByKey("ENG");

    const scoped = await listActivity(user, { projectId: project.id });

    expect(scoped.rows.every((row) => row.project.id === project.id)).toBe(true);
  });
});
