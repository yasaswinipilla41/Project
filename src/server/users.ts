"use server";

import { revalidatePath } from "next/cache";
import { hashPassword } from "@better-auth/utils/password";
import { createLocalAccountIssuer } from "@better-auth/core/db";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { assertAdmin, AuthorizationError } from "@/lib/authz";
import { requireUser } from "@/lib/session";
import { fieldErrors, type FieldErrors } from "@/server/schemas";
import { loadMemberDetail, type MemberDetail } from "@/server/queries/memberDetail";

/**
 * Admin user administration (§18, §23).
 *
 * The administrator-gated way an account comes into existence — the other is
 * public self-registration through `src/server/signup.ts`, which always writes
 * `role: "MEMBER"` and cannot be used to create an ADMIN account. Passwords go
 * through better-auth's own hasher and the account row carries the same
 * synthetic issuer better-auth looks for at sign-in, so a user created here
 * signs in through the normal form.
 */

const CREDENTIAL_ISSUER = createLocalAccountIssuer("credential");

export type UserActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: FieldErrors };

function failure(error: unknown): UserActionResult<never> {
  if (error instanceof AuthorizationError) {
    return { ok: false, error: error.message };
  }
  console.error("[prio] user action failed:", error);
  return { ok: false, error: "Something went wrong. Please try again." };
}

const createUserSchema = z.object({
  name: z.string().trim().min(2, "Enter their full name.").max(80),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Enter a valid email address.")
    .max(200),
  jobTitle: z
    .string()
    .trim()
    .max(80)
    .optional()
    .transform((v) => (v && v.length > 0 ? v : null)),
  role: z.enum(["ADMIN", "MEMBER"]),
  password: z
    .string()
    .min(8, "Use at least 8 characters.")
    .max(128),
  projectIds: z.array(z.string()).default([]),
});

export async function createUser(
  raw: unknown,
): Promise<UserActionResult<{ id: string; email: string }>> {
  try {
    const actor = await requireUser();
    assertAdmin(actor);

    const parsed = createUserSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        error: "Please correct the highlighted fields.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }
    const input = parsed.data;

    const existing = await prisma.user.findUnique({
      where: { email: input.email },
      select: { id: true },
    });
    if (existing) {
      return {
        ok: false,
        error: "An account with that email already exists.",
        fieldErrors: { email: "Already in use." },
      };
    }

    const created = await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name: input.name,
          email: input.email,
          jobTitle: input.jobTitle,
          role: input.role,
          emailVerified: true,
          isActive: true,
        },
        select: { id: true, email: true },
      });

      await tx.account.create({
        data: {
          issuer: CREDENTIAL_ISSUER,
          accountId: user.id,
          providerId: "credential",
          userId: user.id,
          password: await hashPassword(input.password),
        },
      });

      if (input.projectIds.length > 0) {
        await tx.projectMember.createMany({
          data: input.projectIds.map((projectId) => ({
            projectId,
            userId: user.id,
          })),
          skipDuplicates: true,
        });
      }

      return user;
    });

    revalidatePath("/admin");
    return { ok: true, data: created };
  } catch (error) {
    return failure(error);
  }
}

export async function setUserRole(
  userId: string,
  role: "ADMIN" | "MEMBER",
): Promise<UserActionResult> {
  try {
    const actor = await requireUser();
    assertAdmin(actor);

    if (userId === actor.id && role === "MEMBER") {
      return {
        ok: false,
        error: "You cannot remove your own administrator access.",
      };
    }

    // Never leave the organization without an administrator.
    if (role === "MEMBER") {
      const admins = await prisma.user.count({
        where: { role: "ADMIN", isActive: true, NOT: { id: userId } },
      });
      if (admins === 0) {
        return {
          ok: false,
          error: "This is the last active administrator.",
        };
      }
    }

    await prisma.user.update({ where: { id: userId }, data: { role } });

    revalidatePath("/admin");
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error);
  }
}

export async function setUserActive(
  userId: string,
  isActive: boolean,
): Promise<UserActionResult> {
  try {
    const actor = await requireUser();
    assertAdmin(actor);

    if (userId === actor.id && !isActive) {
      return { ok: false, error: "You cannot deactivate your own account." };
    }

    if (!isActive) {
      const admins = await prisma.user.count({
        where: { role: "ADMIN", isActive: true, NOT: { id: userId } },
      });
      const target = await prisma.user.findUnique({
        where: { id: userId },
        select: { role: true },
      });
      if (target?.role === "ADMIN" && admins === 0) {
        return { ok: false, error: "This is the last active administrator." };
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: userId }, data: { isActive } });

      // Deactivation must end existing sessions, or the person keeps working
      // until their cookie happens to expire.
      if (!isActive) {
        await tx.session.deleteMany({ where: { userId } });
      }
    });

    revalidatePath("/admin");
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error);
  }
}

const resetPasswordSchema = z.object({
  userId: z.string().min(1),
  password: z.string().min(8, "Use at least 8 characters.").max(128),
});

export async function resetUserPassword(
  raw: unknown,
): Promise<UserActionResult> {
  try {
    const actor = await requireUser();
    assertAdmin(actor);

    const parsed = resetPasswordSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        error: "Please correct the highlighted fields.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }

    const account = await prisma.account.findFirst({
      where: { userId: parsed.data.userId, providerId: "credential" },
      select: { id: true },
    });

    const hashed = await hashPassword(parsed.data.password);

    if (account) {
      await prisma.account.update({
        where: { id: account.id },
        data: { password: hashed },
      });
    } else {
      await prisma.account.create({
        data: {
          issuer: CREDENTIAL_ISSUER,
          accountId: parsed.data.userId,
          providerId: "credential",
          userId: parsed.data.userId,
          password: hashed,
        },
      });
    }

    // A password change invalidates every existing session for that account.
    await prisma.session.deleteMany({ where: { userId: parsed.data.userId } });

    revalidatePath("/admin");
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error);
  }
}

/* ------------------------------------------------------------- profile */

const profileSchema = z.object({
  name: z.string().trim().min(2, "Enter your name.").max(80),
  jobTitle: z
    .string()
    .trim()
    .max(80)
    .optional()
    .transform((v) => (v && v.length > 0 ? v : null)),
  emailNotificationsEnabled: z.boolean(),
});

/** Self-service profile update. Role, email and active state are not editable. */
export async function updateProfile(
  raw: unknown,
): Promise<UserActionResult> {
  try {
    const actor = await requireUser();

    const parsed = profileSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        error: "Please correct the highlighted fields.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }

    await prisma.user.update({
      where: { id: actor.id },
      data: parsed.data,
    });

    revalidatePath("/profile");
    revalidatePath("/");
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error);
  }
}

/**
 * The Admin Portal's "View details" panel — lazily fetched on click rather
 * than loaded up front for every row in the New Members list, so opening the
 * dashboard never pulls in every member's issues and activity history.
 */
export async function getMemberDetail(
  memberId: string,
): Promise<UserActionResult<MemberDetail>> {
  try {
    const admin = await requireUser();
    const detail = await loadMemberDetail(admin, memberId);
    if (!detail) {
      return { ok: false, error: "That member no longer exists." };
    }
    return { ok: true, data: detail };
  } catch (error) {
    return failure(error);
  }
}
