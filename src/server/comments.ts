"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  assertIssueAccess,
  AuthorizationError,
  NotFoundError,
} from "@/lib/authz";
import { requireUser } from "@/lib/session";
import {
  extractMentions,
  isBlankRichText,
  normalizeRichText,
  richTextToPlain,
} from "@/lib/richtext";
import { addWatchers, notify, watcherIds } from "@/server/activity";
import { sendIssueMailInBackground } from "@/server/mailer";
import { fieldErrors, type FieldErrors } from "@/server/schemas";

/**
 * Comments, mentions and the notifications they produce.
 *
 * Built on the `Comment` and `CommentMention` tables that already existed — no
 * second comment system. What is added here is the write path: validation,
 * mention resolution, the activity entry, in-app notifications and email.
 *
 * The rule that shapes mention handling: **a mention can only ever name
 * somebody who can already read the issue.** The candidate list is derived
 * server-side from project membership, and the text is matched against that
 * list. Typing `@` and a stranger's name does not reach them, does not create a
 * row, and does not confirm that the name exists.
 */

export type CommentResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: FieldErrors };

function failure(error: unknown): CommentResult<never> {
  if (error instanceof AuthorizationError || error instanceof NotFoundError) {
    return { ok: false, error: error.message };
  }
  console.error("[prio] comment action failed:", error);
  return { ok: false, error: "Something went wrong. Please try again." };
}

const createCommentSchema = z.object({
  issueId: z.string().min(1),
  body: z.string().max(20_000, "That comment is too long."),
  /** Set when replying to an existing comment. */
  parentId: z.string().nullable().optional(),
  /** Attachments already uploaded and awaiting a comment to belong to. */
  attachmentIds: z.array(z.string()).max(20).default([]),
});

const updateCommentSchema = z.object({
  commentId: z.string().min(1),
  body: z.string().max(20_000, "That comment is too long."),
});

/**
 * Everyone who may be mentioned on this issue: the project's members, plus
 * administrators, who can read every project.
 */
async function mentionableFor(projectId: string) {
  const [members, admins] = await Promise.all([
    prisma.projectMember.findMany({
      where: { projectId },
      select: { user: { select: { id: true, name: true, email: true, isActive: true } } },
    }),
    prisma.user.findMany({
      where: { role: "ADMIN", isActive: true },
      select: { id: true, name: true, email: true, isActive: true },
    }),
  ]);

  const people = [...members.map((m) => m.user), ...admins].filter(
    (person) => person.isActive,
  );

  return [...new Map(people.map((p) => [p.id, p])).values()];
}

/**
 * People allowed to be `@`-mentioned on an issue, for the composer's picker.
 *
 * Exposed as an action so the client never assembles this list itself. The
 * caller must be able to read the issue; the response says nothing about who
 * exists elsewhere in the organization.
 */
export async function listMentionable(
  issueId: string,
): Promise<CommentResult<{ id: string; name: string; image: string | null }[]>> {
  try {
    const user = await requireUser();
    const projectId = await assertIssueAccess(user, issueId);

    const people = await prisma.projectMember.findMany({
      where: { projectId, user: { isActive: true } },
      orderBy: { user: { name: "asc" } },
      select: { user: { select: { id: true, name: true, image: true } } },
    });

    const admins = await prisma.user.findMany({
      where: { role: "ADMIN", isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, image: true },
    });

    const merged = [...new Map(
      [...people.map((p) => p.user), ...admins].map((p) => [p.id, p]),
    ).values()].sort((a, b) => a.name.localeCompare(b.name));

    return { ok: true, data: merged };
  } catch (error) {
    return failure(error);
  }
}

/* --------------------------------------------------------------- create */

export async function createComment(
  raw: unknown,
): Promise<CommentResult<{ id: string }>> {
  try {
    const user = await requireUser();

    const parsed = createCommentSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        error: "Please correct the highlighted fields.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }

    const input = parsed.data;
    const body = normalizeRichText(input.body);

    const projectId = await assertIssueAccess(user, input.issueId);

    // Attachments may carry a comment on their own, so an empty body is only a
    // problem when there is nothing else to show.
    if (isBlankRichText(body) && input.attachmentIds.length === 0) {
      return {
        ok: false,
        error: "Write something before posting.",
        fieldErrors: { body: "Write something before posting." },
      };
    }

    // A reply must belong to the same issue; otherwise a crafted parentId
    // could graft this comment onto a thread the author cannot see.
    if (input.parentId) {
      const parent = await prisma.comment.findUnique({
        where: { id: input.parentId },
        select: { issueId: true },
      });
      if (!parent || parent.issueId !== input.issueId) {
        return { ok: false, error: "That comment is no longer available." };
      }
    }

    const candidates = await mentionableFor(projectId);
    const mentionedIds = extractMentions(
      body,
      candidates.map(({ id, name }) => ({ id, name })),
    );

    const issue = await prisma.issue.findUniqueOrThrow({
      where: { id: input.issueId },
      select: {
        id: true,
        key: true,
        title: true,
        assigneeId: true,
        reporterId: true,
        project: { select: { name: true } },
      },
    });

    const comment = await prisma.$transaction(async (tx) => {
      const created = await tx.comment.create({
        data: {
          issueId: input.issueId,
          authorId: user.id,
          body,
          parentId: input.parentId ?? null,
          mentions: {
            createMany: { data: mentionedIds.map((userId) => ({ userId })) },
          },
        },
        select: { id: true },
      });

      /* Attachments were uploaded before the comment existed, so they are
         claimed here. The WHERE clause pins them to this issue and this
         uploader — an id belonging to someone else simply matches nothing. */
      if (input.attachmentIds.length > 0) {
        await tx.attachment.updateMany({
          where: {
            id: { in: input.attachmentIds },
            issueId: input.issueId,
            uploadedById: user.id,
            commentId: null,
          },
          data: { commentId: created.id },
        });
      }

      await tx.activityLogEntry.create({
        data: {
          issueId: input.issueId,
          actorId: user.id,
          action: "comment.created",
        },
      });

      // Commenting is an expression of interest, so the author starts watching.
      await addWatchers(tx, input.issueId, [user.id]);

      const excerpt = richTextToPlain(body, 140);
      const watchers = await watcherIds(tx, input.issueId);

      if (mentionedIds.length > 0) {
        await notify(tx, {
          issueId: input.issueId,
          actorId: user.id,
          userIds: mentionedIds,
          type: "MENTIONED",
          message: `${user.name} mentioned you on ${issue.key}`,
          commentId: created.id,
        });
      }

      /* Watchers who were mentioned already have a notification; sending them a
         second one for the same comment would be noise. */
      await notify(tx, {
        issueId: input.issueId,
        actorId: user.id,
        userIds: [
          ...watchers,
          issue.assigneeId,
          issue.reporterId,
        ].filter((id) => id && !mentionedIds.includes(id)),
        type: "COMMENT_ADDED",
        message: `${user.name} commented on ${issue.key}${
          excerpt ? `: ${excerpt}` : ""
        }`,
        commentId: created.id,
      });

      return created;
    });

    /* Email goes to the people the comment concerns, once the write has
       committed — a rolled-back transaction must never produce a sent email. */
    const recipientIds = [
      ...new Set(
        [
          ...mentionedIds,
          ...(await watcherIds(prisma, input.issueId)),
          issue.assigneeId,
          issue.reporterId,
        ].filter((id): id is string => Boolean(id) && id !== user.id),
      ),
    ];

    if (recipientIds.length > 0) {
      const recipients = await prisma.user.findMany({
        where: { id: { in: recipientIds }, isActive: true },
        select: { email: true, name: true },
      });

      sendIssueMailInBackground(recipients, {
        issueKey: issue.key,
        issueTitle: issue.title,
        projectName: issue.project.name,
        actorName: user.name,
        event:
          mentionedIds.length > 0
            ? "mentioned you in a comment on"
            : "commented on",
        excerpt: richTextToPlain(body, 400),
      });
    }

    revalidatePath(`/issues/${issue.key.toLowerCase()}`);
    revalidatePath("/notifications");
    revalidatePath("/");

    return { ok: true, data: { id: comment.id } };
  } catch (error) {
    return failure(error);
  }
}

/* --------------------------------------------------------------- update */

/**
 * Edit a comment.
 *
 * Only its author may edit it — not an administrator. An audit trail whose
 * entries can be rewritten by someone other than the person who wrote them is
 * not an audit trail. `editedAt` records that it happened.
 */
export async function updateComment(
  raw: unknown,
): Promise<CommentResult<{ id: string }>> {
  try {
    const user = await requireUser();

    const parsed = updateCommentSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        error: "Please correct the highlighted fields.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }

    const body = normalizeRichText(parsed.data.body);

    const existing = await prisma.comment.findUnique({
      where: { id: parsed.data.commentId },
      select: {
        id: true,
        authorId: true,
        issueId: true,
        issue: { select: { key: true } },
        _count: { select: { attachments: true } },
      },
    });

    if (!existing) throw new NotFoundError("That comment no longer exists.");
    await assertIssueAccess(user, existing.issueId);

    if (existing.authorId !== user.id) {
      throw new AuthorizationError("You can only edit your own comments.");
    }

    if (isBlankRichText(body) && existing._count.attachments === 0) {
      return {
        ok: false,
        error: "A comment cannot be empty.",
        fieldErrors: { body: "A comment cannot be empty." },
      };
    }

    const projectId = await assertIssueAccess(user, existing.issueId);
    const candidates = await mentionableFor(projectId);
    const mentionedIds = extractMentions(
      body,
      candidates.map(({ id, name }) => ({ id, name })),
    );

    await prisma.$transaction(async (tx) => {
      await tx.comment.update({
        where: { id: existing.id },
        data: { body, editedAt: new Date() },
      });

      // Mentions are replaced wholesale: an edit that removes a name should
      // stop that person being listed as mentioned.
      await tx.commentMention.deleteMany({ where: { commentId: existing.id } });
      if (mentionedIds.length > 0) {
        await tx.commentMention.createMany({
          data: mentionedIds.map((userId) => ({
            commentId: existing.id,
            userId,
          })),
        });
      }

      await tx.activityLogEntry.create({
        data: {
          issueId: existing.issueId,
          actorId: user.id,
          action: "comment.edited",
        },
      });
    });

    revalidatePath(`/issues/${existing.issue.key.toLowerCase()}`);

    return { ok: true, data: { id: existing.id } };
  } catch (error) {
    return failure(error);
  }
}

/* --------------------------------------------------------------- delete */

/**
 * Delete a comment.
 *
 * Its author may remove it; so may an administrator, who needs a way to take
 * down something inappropriate. Either way the deletion is recorded in the
 * activity trail, which is append-only — the comment goes, the fact that it
 * existed and was removed does not.
 */
export async function deleteComment(
  commentId: string,
): Promise<CommentResult<{ id: string }>> {
  try {
    const user = await requireUser();

    const existing = await prisma.comment.findUnique({
      where: { id: commentId },
      select: {
        id: true,
        authorId: true,
        issueId: true,
        issue: { select: { key: true } },
        attachments: { select: { id: true, storageKey: true } },
      },
    });

    if (!existing) throw new NotFoundError("That comment no longer exists.");
    await assertIssueAccess(user, existing.issueId);

    if (existing.authorId !== user.id && user.role !== "ADMIN") {
      throw new AuthorizationError(
        "You can only delete your own comments.",
      );
    }

    await prisma.$transaction(async (tx) => {
      // Mentions, notifications and attachment rows cascade from the comment.
      await tx.comment.delete({ where: { id: existing.id } });
      await tx.activityLogEntry.create({
        data: {
          issueId: existing.issueId,
          actorId: user.id,
          action: "comment.deleted",
        },
      });
    });

    /* Stored bytes are removed after the row, not before: an orphaned file is
       recoverable, a row pointing at a file that is gone is a broken page. */
    if (existing.attachments.length > 0) {
      const { storage } = await import("@/server/storage");
      await Promise.allSettled(
        existing.attachments.map((a) => storage().remove(a.storageKey)),
      );
    }

    revalidatePath(`/issues/${existing.issue.key.toLowerCase()}`);

    return { ok: true, data: { id: existing.id } };
  } catch (error) {
    return failure(error);
  }
}
