"use server";

import { randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";
import {
  assertAdmin,
  AuthorizationError,
  NotFoundError,
} from "@/lib/authz";
import { getEnv } from "@/lib/env";
import { requireUser, type CurrentUser } from "@/lib/session";
import {
  fieldErrors,
  removeShareMemberSchema,
  shareMemberSchema,
  type FieldErrors,
} from "@/server/schemas";

/**
 * Sharing the Issues Sheet (§ Share Issue Sheet).
 *
 * One share exists for the whole organization — not one per person, not one
 * per filter combination. "Share" grants a specific person a standing invite
 * to the live /issues data through a link; it is not a snapshot and it is
 * not a new access path around normal project membership. The shared page
 * still runs the caller's own `listIssues` scoped by their own role and
 * project memberships (see the shared route), so granting VIEW access never
 * shows someone a project they could not otherwise open.
 *
 * Only an administrator may create the share or manage its members —
 * mirroring how project membership is administered elsewhere in this file's
 * sibling, `projects.ts`.
 */

export type ShareActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: FieldErrors };

function failure(error: unknown): ShareActionResult<never> {
  if (error instanceof AuthorizationError || error instanceof NotFoundError) {
    return { ok: false, error: error.message };
  }
  console.error("[prio] share action failed:", error);
  return { ok: false, error: "Something went wrong. Please try again." };
}

function shareUrl(token: string): string {
  const base = getEnv().BASE_URL.replace(/\/+$/, "");
  return `${base}/shared/issues/${token}`;
}

async function getOrCreateShare(
  createdById: string,
): Promise<{ id: string; token: string }> {
  const existing = await prisma.issueSheetShare.findFirst({
    orderBy: { createdAt: "asc" },
    select: { id: true, token: true },
  });
  if (existing) return existing;

  const token = randomBytes(24).toString("base64url");
  return prisma.issueSheetShare.create({
    data: { token, createdById },
    select: { id: true, token: true },
  });
}

export interface ShareMemberInfo {
  id: string;
  userId: string;
  name: string;
  email: string;
  image: string | null;
  jobTitle: string | null;
  permission: "VIEW";
}

export interface ShareCandidate {
  id: string;
  name: string;
  email: string;
  image: string | null;
  jobTitle: string | null;
}

export interface ShareInfo {
  exists: boolean;
  isAdmin: boolean;
  url: string | null;
  members: ShareMemberInfo[];
  /** Active org members not already granted access. Only sent to admins. */
  candidates: ShareCandidate[];
}

/**
 * Everything the Share dialog needs, for the user who opened it. Any
 * authenticated user may see who has access and copy the link; only an
 * administrator gets the candidate list needed to add or remove people.
 */
export async function getShareInfo(): Promise<ShareActionResult<ShareInfo>> {
  try {
    const user = await requireUser();
    const isAdmin = user.role === "ADMIN";

    let share = await prisma.issueSheetShare.findFirst({
      orderBy: { createdAt: "asc" },
      select: { id: true, token: true },
    });

    if (!share) {
      if (!isAdmin) {
        return {
          ok: true,
          data: { exists: false, isAdmin, url: null, members: [], candidates: [] },
        };
      }
      share = await getOrCreateShare(user.id);
    }

    const members = await prisma.issueSheetShareMember.findMany({
      where: { shareId: share.id },
      select: {
        id: true,
        userId: true,
        permission: true,
        user: {
          select: { name: true, email: true, image: true, jobTitle: true },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    const memberInfos: ShareMemberInfo[] = members.map((m) => ({
      id: m.id,
      userId: m.userId,
      name: m.user.name,
      email: m.user.email,
      image: m.user.image,
      jobTitle: m.user.jobTitle,
      permission: m.permission,
    }));

    let candidates: ShareCandidate[] = [];
    if (isAdmin) {
      const memberIds = new Set(members.map((m) => m.userId));
      const active = await prisma.user.findMany({
        where: { isActive: true, id: { not: user.id } },
        select: { id: true, name: true, email: true, image: true, jobTitle: true },
        orderBy: { name: "asc" },
      });
      candidates = active.filter((u) => !memberIds.has(u.id));
    }

    return {
      ok: true,
      data: {
        exists: true,
        isAdmin,
        url: shareUrl(share.token),
        members: memberInfos,
        candidates,
      },
    };
  } catch (error) {
    return failure(error);
  }
}

/** Grants one person View access, creating the share on first use. */
export async function addShareMember(
  raw: unknown,
): Promise<ShareActionResult<ShareMemberInfo>> {
  try {
    const user = await requireUser();
    assertAdmin(user);

    const parsed = shareMemberSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        error: "Choose someone to share with.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }

    const target = await prisma.user.findUnique({
      where: { id: parsed.data.userId },
      select: { id: true, name: true, email: true, image: true, jobTitle: true, isActive: true },
    });
    if (!target || !target.isActive) {
      return { ok: false, error: "That person is not available to share with." };
    }

    const share = await getOrCreateShare(user.id);

    const member = await prisma.issueSheetShareMember.upsert({
      where: { shareId_userId: { shareId: share.id, userId: target.id } },
      update: { permission: parsed.data.permission },
      create: {
        shareId: share.id,
        userId: target.id,
        permission: parsed.data.permission,
        addedById: user.id,
      },
      select: { id: true, permission: true },
    });

    return {
      ok: true,
      data: {
        id: member.id,
        userId: target.id,
        name: target.name,
        email: target.email,
        image: target.image,
        jobTitle: target.jobTitle,
        permission: member.permission,
      },
    };
  } catch (error) {
    return failure(error);
  }
}

export async function removeShareMember(
  raw: unknown,
): Promise<ShareActionResult> {
  try {
    const user = await requireUser();
    assertAdmin(user);

    const parsed = removeShareMemberSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: "Choose someone to remove." };
    }

    await prisma.issueSheetShareMember.deleteMany({
      where: { id: parsed.data.memberId },
    });

    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Throws unless `user` may open the shared Issues Sheet at `token` — an
 * administrator, always, or someone explicitly granted access. Used by the
 * `/shared/issues/[token]` route before any issue data is fetched.
 */
export async function assertShareAccess(
  user: CurrentUser,
  token: string,
): Promise<void> {
  const share = await prisma.issueSheetShare.findUnique({
    where: { token },
    select: {
      members: { where: { userId: user.id }, select: { id: true } },
    },
  });

  if (!share) {
    throw new NotFoundError("This shared sheet is no longer available.");
  }
  if (user.role !== "ADMIN" && share.members.length === 0) {
    throw new AuthorizationError(
      "You do not have access to this shared sheet.",
    );
  }
}
