"use server";

import { revalidatePath } from "next/cache";
import { hashPassword, verifyPassword } from "@better-auth/utils/password";
import { createLocalAccountIssuer } from "@better-auth/core/db";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { assertAdmin, AuthorizationError } from "@/lib/authz";
import { requireUser } from "@/lib/session";
import { fieldErrors, type FieldErrors } from "@/server/schemas";
import { loadMemberDetail, type MemberDetail } from "@/server/queries/memberDetail";
import { sendWelcomeMail } from "@/server/mailer";
import { ROLE_LABEL } from "@/lib/domain";

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
): Promise<
  UserActionResult<{
    id: string;
    email: string;
    /** Whether the welcome message actually went out. */
    welcomeEmailSent: boolean;
    /** True when this installation has no SMTP configured at all. */
    welcomeEmailSkipped: boolean;
  }>
> {
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
          /* The password below is one an administrator chose, so it is theirs
             to replace at the first sign-in. Only accounts created here are
             marked; every account that already exists keeps its default of
             false and is not stopped at a password screen. */
          mustChangePassword: true,
        },
        select: { id: true, name: true, email: true },
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

    /*
     * Told after the account exists, and never before.
     *
     * The message carries the password the administrator typed, which is why
     * it is sent from here rather than from inside the transaction: a message
     * promising credentials for an account that then failed to commit would be
     * worse than no message. The plaintext lives only in this request — the row
     * holds a hash — and is not logged on any path, including the failure one.
     *
     * A mail failure does not undo the account. It exists, the administrator is
     * told the message did not go, and they can pass the details on themselves;
     * rolling back would leave them with neither.
     */
    const projects =
      input.projectIds.length === 0
        ? []
        : (
            await prisma.project.findMany({
              where: { id: { in: input.projectIds } },
              select: { name: true },
              orderBy: { name: "asc" },
            })
          ).map((project) => project.name);

    const delivery = await sendWelcomeMail({
      name: created.name,
      email: created.email,
      temporaryPassword: input.password,
      roleLabel: ROLE_LABEL[input.role],
      projects,
    });

    revalidatePath("/admin");
    return {
      ok: true,
      data: {
        id: created.id,
        email: created.email,
        welcomeEmailSent: delivery.sent,
        welcomeEmailSkipped: delivery.skipped,
      },
    };
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

/* ------------------------------------------------- change own password */

const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Enter your current password."),
    newPassword: z.string().min(8, "Use at least 8 characters.").max(128),
    confirmPassword: z.string(),
  })
  .superRefine((value, ctx) => {
    if (value.newPassword !== value.confirmPassword) {
      ctx.addIssue({
        code: "custom",
        path: ["confirmPassword"],
        message: "Passwords do not match.",
      });
    }
    if (value.newPassword === value.currentPassword) {
      ctx.addIssue({
        code: "custom",
        path: ["newPassword"],
        message: "Choose a password you are not already using.",
      });
    }
  });

/**
 * Lets someone change their own password.
 *
 * Deliberately not `resetUserPassword` with the caller's own id: that action
 * is an administrator's override and asks for no current password, which is
 * exactly the check a self-service change must not skip. Knowing the existing
 * password is what makes this safe on a session someone left open.
 *
 * Same hashing as every other password this application writes, and neither
 * the old nor the new one is returned, logged, or put in an error message.
 */
export async function changeOwnPassword(
  raw: unknown,
): Promise<UserActionResult> {
  try {
    const user = await requireUser();

    const parsed = changePasswordSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        error: "Please correct the highlighted fields.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }

    const account = await prisma.account.findFirst({
      where: { userId: user.id, providerId: "credential" },
      select: { id: true, password: true },
    });

    if (!account?.password) {
      return {
        ok: false,
        error: "This account does not sign in with a password.",
      };
    }

    const matches = await verifyPassword(
      account.password,
      parsed.data.currentPassword,
    );
    if (!matches) {
      return {
        ok: false,
        error: "That current password is not correct.",
        fieldErrors: { currentPassword: "Incorrect password." },
      };
    }

    /*
     * Both writes together, because the flag is what stands between an
     * administrator-created account and the application: clearing it while the
     * password failed to save would let somebody through on the temporary one.
     *
     * `mustChangePassword` is set unconditionally rather than only when it was
     * true — it is already false for everybody else, so this is a no-op for
     * them, and a conditional would be a second place that has to know the
     * default.
     */
    /*
     * The interactive form: the array/"batch" form hands both writes to the
     * query engine as a plan it interprets without actually awaiting each in
     * turn, which can reach the pg client with the second query before the
     * first has returned and trip its "already executing a query" guard.
     */
    const hashedPassword = await hashPassword(parsed.data.newPassword);
    await prisma.$transaction(async (tx) => {
      await tx.account.update({
        where: { id: account.id },
        data: { password: hashedPassword },
      });
      await tx.user.update({
        where: { id: user.id },
        data: { mustChangePassword: false },
      });
    });

    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error);
  }
}
