"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import {
  assertIssueAccess,
  AuthorizationError,
  issueScope,
  NotFoundError,
} from "@/lib/authz";
import { requireUser } from "@/lib/session";
import { fieldErrors, type FieldErrors } from "@/server/schemas";
import { LINK_INVERSE as INVERSE, LINK_LABEL, LINK_TYPES } from "@/lib/issue-links";

/**
 * Relationships between issues.
 *
 * Every link is stored twice — once in each direction — so that either issue
 * can be read on its own without a query that searches both columns. Writing
 * and deleting therefore always happen as a pair, in a transaction: a
 * half-written link would show "ENG-1 blocks ENG-4" on one page and nothing on
 * the other.
 *
 * This is deliberately separate from the parent/child hierarchy, which is a
 * containment relationship on `Issue.parentId` and is untouched here.
 */

export type LinkResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: FieldErrors };

function failure(error: unknown): LinkResult<never> {
  if (error instanceof AuthorizationError || error instanceof NotFoundError) {
    return { ok: false, error: error.message };
  }
  console.error("[prio] issue link action failed:", error);
  return { ok: false, error: "Something went wrong. Please try again." };
}

const linkSchema = z.object({
  issueId: z.string().min(1),
  /** The other issue, given by key (ENG-12) as typed in the picker. */
  targetKey: z.string().trim().min(1, "Choose an issue to link."),
  type: z.enum(LINK_TYPES),
});

export async function createIssueLink(
  raw: unknown,
): Promise<LinkResult<{ targetKey: string }>> {
  try {
    const user = await requireUser();

    const parsed = linkSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        error: "Please correct the highlighted fields.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }

    const { issueId, targetKey, type } = parsed.data;

    const source = await prisma.issue.findUnique({
      where: { id: issueId },
      select: { id: true, key: true },
    });
    if (!source) throw new NotFoundError("This issue no longer exists.");
    await assertIssueAccess(user, source.id);

    /*
     * The target is looked up *within the caller's scope*. An issue they cannot
     * read is simply not found — linking must not become a way to confirm that
     * a key exists in a project they have no access to.
     */
    const target = await prisma.issue.findFirst({
      where: { key: targetKey.toUpperCase(), ...issueScope(user) },
      select: { id: true, key: true },
    });

    if (!target) {
      return {
        ok: false,
        error: "No issue with that key is available to you.",
        fieldErrors: { targetKey: "No such issue." },
      };
    }

    if (target.id === source.id) {
      return {
        ok: false,
        error: "An issue cannot be linked to itself.",
        fieldErrors: { targetKey: "Choose a different issue." },
      };
    }

    const existing = await prisma.issueLink.findFirst({
      where: { sourceId: source.id, targetId: target.id, type },
      select: { id: true },
    });
    if (existing) {
      return {
        ok: false,
        error: `${source.key} already ${LINK_LABEL[type]} ${target.key}.`,
      };
    }

    await prisma.$transaction([
      prisma.issueLink.create({
        data: {
          sourceId: source.id,
          targetId: target.id,
          type,
          createdById: user.id,
        },
      }),
      // The mirror. `skipDuplicates` is not available on `create`, so the pair
      // is written with an upsert-shaped guard instead.
      prisma.issueLink.upsert({
        where: {
          sourceId_targetId_type: {
            sourceId: target.id,
            targetId: source.id,
            type: INVERSE[type],
          },
        },
        update: {},
        create: {
          sourceId: target.id,
          targetId: source.id,
          type: INVERSE[type],
          createdById: user.id,
        },
      }),
      prisma.activityLogEntry.create({
        data: {
          issueId: source.id,
          actorId: user.id,
          action: "link.added",
          field: type,
          newValue: target.key,
        },
      }),
      prisma.activityLogEntry.create({
        data: {
          issueId: target.id,
          actorId: user.id,
          action: "link.added",
          field: INVERSE[type],
          newValue: source.key,
        },
      }),
    ]);

    revalidatePath(`/issues/${source.key.toLowerCase()}`);
    revalidatePath(`/issues/${target.key.toLowerCase()}`);

    return { ok: true, data: { targetKey: target.key } };
  } catch (error) {
    return failure(error);
  }
}

export async function removeIssueLink(
  linkId: string,
): Promise<LinkResult<{ removed: number }>> {
  try {
    const user = await requireUser();

    const link = await prisma.issueLink.findUnique({
      where: { id: linkId },
      select: {
        id: true,
        type: true,
        source: { select: { id: true, key: true } },
        target: { select: { id: true, key: true } },
      },
    });

    if (!link) throw new NotFoundError("That link no longer exists.");

    // Reading either end is enough to unlink: the relationship belongs to both.
    await assertIssueAccess(user, link.source.id);

    const result = await prisma.$transaction(async (tx) => {
      const forward = await tx.issueLink.deleteMany({
        where: {
          sourceId: link.source.id,
          targetId: link.target.id,
          type: link.type,
        },
      });
      const backward = await tx.issueLink.deleteMany({
        where: {
          sourceId: link.target.id,
          targetId: link.source.id,
          type: INVERSE[link.type],
        },
      });

      await tx.activityLogEntry.create({
        data: {
          issueId: link.source.id,
          actorId: user.id,
          action: "link.removed",
          field: link.type,
          oldValue: link.target.key,
        },
      });

      return forward.count + backward.count;
    });

    revalidatePath(`/issues/${link.source.key.toLowerCase()}`);
    revalidatePath(`/issues/${link.target.key.toLowerCase()}`);

    return { ok: true, data: { removed: result } };
  } catch (error) {
    return failure(error);
  }
}

/** Issues the caller may link to, for the picker's search box. */
export async function searchLinkableIssues(
  issueId: string,
  query: string,
): Promise<LinkResult<{ id: string; key: string; title: string; type: string }[]>> {
  try {
    const user = await requireUser();
    await assertIssueAccess(user, issueId);

    const term = query.trim();
    if (term.length === 0) return { ok: true, data: [] };

    const matches = await prisma.issue.findMany({
      where: {
        ...issueScope(user),
        id: { not: issueId },
        OR: [
          { key: { contains: term, mode: "insensitive" } },
          { title: { contains: term, mode: "insensitive" } },
        ],
      },
      orderBy: { updatedAt: "desc" },
      take: 8,
      select: { id: true, key: true, title: true, type: true },
    });

    return { ok: true, data: matches };
  } catch (error) {
    return failure(error);
  }
}
