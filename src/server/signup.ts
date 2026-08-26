"use server";

import { hashPassword } from "@better-auth/utils/password";
import { createLocalAccountIssuer } from "@better-auth/core/db";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { fieldErrors, type FieldErrors } from "@/server/schemas";

/**
 * Public self-registration.
 *
 * This is the one write path into the `User` table that runs with no
 * authenticated caller at all — every other way an account comes into
 * existence (`createUser`, an accepted invitation) requires an administrator
 * first. That makes the two things this module must never do the whole of its
 * job:
 *
 *  1. **Never accept a role, an id, or any other identity claim from the
 *     caller.** The schema below has no `role` field — there is nothing to
 *     read, so there is nothing to trust. Every account created here is
 *     `role: "MEMBER"`, written as a literal in the `create` call, not
 *     threaded through from input.
 *  2. **Never sign the new account in.** This does not call better-auth's
 *     `signInEmail` or set a session cookie; it returns success and lets the
 *     person type their own credentials into the sign-in form, the same as
 *     every other newly created Prio account.
 *
 * `disableSignUp: true` stays set on `auth.ts` — the better-auth endpoint this
 * would otherwise expose remains closed, and this hand-written action is the
 * only door in, built the same way `createUser` already builds an account
 * (direct `User`/`Account` rows, better-auth's own password hasher and issuer)
 * so a self-registered account signs in through the ordinary form exactly like
 * an admin-created one does.
 */

const CREDENTIAL_ISSUER = createLocalAccountIssuer("credential");

export type SignUpResult =
  | { ok: true }
  | { ok: false; error: string; fieldErrors?: FieldErrors };

/**
 * Distinguishes "the database is unreachable" from every other unexpected
 * failure. Prisma's driver adapters surface a connection refusal as a
 * `PrismaClientKnownRequestError` carrying the underlying driver's error code
 * (`ECONNREFUSED`, `ETIMEDOUT`, ...) rather than one of Prisma's own `P____`
 * codes, and a failure to even establish the connection pool surfaces as
 * `PrismaClientInitializationError`. Either way the person filling in the
 * form did nothing wrong, so they get a message that says so instead of the
 * fully generic fallback.
 */
function isDatabaseUnavailable(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientInitializationError) return true;
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return ["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "ECONNRESET"].includes(
      error.code,
    );
  }
  return false;
}

const signUpSchema = z
  .object({
    name: z.string().trim().min(2, "Enter your full name.").max(80),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .email("Enter a valid email address.")
      .max(200),
    // Deliberately not trimmed — see the note on the sign-in form. A space is
    // technically a valid password character, and silently altering what
    // someone typed here would mean the password they set is not the one
    // sign-in later checks against.
    password: z.string().min(8, "Use at least 8 characters.").max(128),
    confirmPassword: z.string(),
  })
  .superRefine((value, ctx) => {
    if (value.password !== value.confirmPassword) {
      ctx.addIssue({
        code: "custom",
        path: ["confirmPassword"],
        message: "Passwords do not match.",
      });
    }
  });

export async function signUp(raw: unknown): Promise<SignUpResult> {
  try {
    const parsed = signUpSchema.safeParse(raw);
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

    await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name: input.name,
          email: input.email,
          role: "MEMBER",
          emailVerified: true,
          isActive: true,
        },
        select: { id: true },
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

      /*
       * A self-registered account has no admin present to choose a project
       * for it. `Project.isDefaultProject` is how an admin opts a project
       * into that — off for everyone until explicitly turned on, and never
       * for an archived project. `skipDuplicates` costs nothing here (the
       * user id is brand new) but keeps this honestly idempotent rather than
       * merely "happens not to duplicate today".
       */
      const defaultProjects = await tx.project.findMany({
        where: { isDefaultProject: true, isArchived: false },
        select: { id: true },
      });

      if (defaultProjects.length > 0) {
        await tx.projectMember.createMany({
          data: defaultProjects.map((project) => ({
            projectId: project.id,
            userId: user.id,
          })),
          skipDuplicates: true,
        });
      }
    });

    return { ok: true };
  } catch (error) {
    /*
     * The unique constraint on `email` is the backstop for a race between two
     * concurrent sign-ups for the same address — the pre-check above closes
     * the common case, but only the database can make it airtight.
     */
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: string }).code === "P2002"
    ) {
      return {
        ok: false,
        error: "An account with that email already exists.",
        fieldErrors: { email: "Already in use." },
      };
    }

    if (isDatabaseUnavailable(error)) {
      console.error("[prio] sign-up failed: database unreachable:", error);
      return {
        ok: false,
        error: "Unable to create your account right now. Please try again.",
      };
    }

    console.error("[prio] sign-up failed:", error);
    return { ok: false, error: "Something went wrong. Please try again." };
  }
}
