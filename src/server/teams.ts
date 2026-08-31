"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertAdmin } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

/**
 * Team membership management.
 *
 * Who may change it is the existing rule — an administrator, checked with the
 * same `assertAdmin` every other administrative action uses. No new permission
 * was introduced for teams, and none is needed: administering Prio already
 * covers deciding who is on which team.
 *
 * Membership is only ever created by one of these calls. Nothing adds a person
 * to a team as a side effect of signing up, being given a role, or joining a
 * project, so a team's roster is always something somebody chose.
 */

export type TeamActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string };

function failure(error: unknown): { ok: false; error: string } {
  const message =
    error instanceof Error ? error.message : "Something went wrong.";
  return { ok: false, error: message };
}

const membershipSchema = z.object({
  teamId: z.string().min(1),
  userId: z.string().min(1),
});

export async function addTeamMember(
  raw: unknown,
): Promise<TeamActionResult> {
  try {
    const user = await requireUser();
    assertAdmin(user);

    const parsed = membershipSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: "Choose someone to add." };
    }

    const target = await prisma.user.findUnique({
      where: { id: parsed.data.userId },
      select: { id: true, isActive: true },
    });
    if (!target || !target.isActive) {
      return { ok: false, error: "That person is not available." };
    }

    // Upsert, so adding somebody already on the team is a no-op rather than a
    // unique-constraint error surfaced as "something went wrong".
    await prisma.teamMember.upsert({
      where: {
        teamId_userId: { teamId: parsed.data.teamId, userId: parsed.data.userId },
      },
      update: {},
      create: parsed.data,
    });

    revalidatePath("/admin");
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error);
  }
}

export async function removeTeamMember(
  raw: unknown,
): Promise<TeamActionResult> {
  try {
    const user = await requireUser();
    assertAdmin(user);

    const parsed = membershipSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: "Choose someone to remove." };
    }

    /* Leaving a team removes nothing but the membership: the person keeps
       their account, their role, their projects and everything assigned to
       them. Only what a team unlocks goes away. */
    await prisma.teamMember.deleteMany({
      where: { teamId: parsed.data.teamId, userId: parsed.data.userId },
    });

    revalidatePath("/admin");
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error);
  }
}
