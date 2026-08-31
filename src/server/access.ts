"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertAdmin, assertProjectAccess } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

/**
 * Project access requests.
 *
 * Prio's membership model is a single binary — you are on a project or you are
 * not — and only an administrator may change it. That leaves an ordinary member
 * who wants to bring a colleague onto their project with nowhere to go, which
 * is what this closes: they ask, an administrator answers, and access is
 * granted by the same `ProjectMember` row an administrator would have written
 * by hand. Nothing here grants access on its own.
 *
 * Authorization at both ends:
 *  - asking requires access to the project being shared, so this cannot be
 *    used to probe for projects the caller cannot already see;
 *  - answering requires ADMIN, checked on the server, not in the UI.
 */

export type AccessActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string };

function failure(error: unknown): { ok: false; error: string } {
  const message =
    error instanceof Error ? error.message : "Something went wrong.";
  return { ok: false, error: message };
}

const requestSchema = z.object({
  projectId: z.string().min(1),
  subjectId: z.string().min(1),
  message: z.string().max(500).optional(),
});

const decisionSchema = z.object({
  requestId: z.string().min(1),
  approve: z.boolean(),
});

/** A member asking for somebody to be given access to a project they are on. */
export async function requestProjectAccess(
  raw: unknown,
): Promise<AccessActionResult> {
  try {
    const user = await requireUser();

    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: "Choose who needs access." };
    }
    const { projectId, subjectId, message } = parsed.data;

    // You may only ask about a project you can already see.
    await assertProjectAccess(user, projectId);

    const [project, subject] = await Promise.all([
      prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, key: true, name: true },
      }),
      prisma.user.findUnique({
        where: { id: subjectId },
        select: { id: true, name: true, isActive: true },
      }),
    ]);

    if (!project) return { ok: false, error: "That project no longer exists." };
    if (!subject || !subject.isActive) {
      return { ok: false, error: "That person is not available." };
    }

    const alreadyMember = await prisma.projectMember.count({
      where: { projectId, userId: subjectId },
    });
    if (alreadyMember > 0) {
      return {
        ok: false,
        error: `${subject.name} already has access to ${project.name}.`,
      };
    }

    /*
     * One pending request per person per project. Checked rather than enforced
     * by a unique index, because the constraint is only on PENDING rows — a
     * rejected request must not block asking again later, which a plain
     * unique index on (projectId, subjectId) would do forever.
     */
    const pending = await prisma.projectAccessRequest.count({
      where: { projectId, subjectId, status: "PENDING" },
    });
    if (pending > 0) {
      return {
        ok: false,
        error: `A request for ${subject.name} is already waiting for an administrator.`,
      };
    }

    const admins = await prisma.user.findMany({
      where: { role: "ADMIN", isActive: true, id: { not: user.id } },
      select: { id: true },
    });

    await prisma.$transaction(async (tx) => {
      await tx.projectAccessRequest.create({
        data: {
          projectId,
          requesterId: user.id,
          subjectId,
          message: message?.trim() || null,
        },
      });

      if (admins.length > 0) {
        await tx.notification.createMany({
          data: admins.map((admin) => ({
            userId: admin.id,
            type: "PROJECT_ACCESS_REQUEST" as const,
            actorId: user.id,
            projectId,
            /* No name prefix: `NotificationList` already renders the actor's
               name before the message, the same convention `issues.ts` and
               `notifyAdminsOfNewUser` follow. */
            message: `asked for ${subject.name} to be given access to ${project.name}.`,
          })),
        });
      }
    });

    revalidatePath(`/projects/${project.key.toLowerCase()}`);
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error);
  }
}

/** An administrator approving or rejecting one request. */
export async function decideProjectAccess(
  raw: unknown,
): Promise<AccessActionResult> {
  try {
    const user = await requireUser();
    assertAdmin(user);

    const parsed = decisionSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: "That decision could not be read." };
    }
    const { requestId, approve } = parsed.data;

    const request = await prisma.projectAccessRequest.findUnique({
      where: { id: requestId },
      select: {
        id: true,
        status: true,
        projectId: true,
        requesterId: true,
        subjectId: true,
        project: { select: { key: true, name: true } },
        subject: { select: { name: true } },
      },
    });

    if (!request) return { ok: false, error: "That request no longer exists." };
    if (request.status !== "PENDING") {
      return { ok: false, error: "That request has already been answered." };
    }

    await prisma.$transaction(async (tx) => {
      await tx.projectAccessRequest.update({
        where: { id: request.id },
        data: {
          status: approve ? "APPROVED" : "REJECTED",
          decidedById: user.id,
          decidedAt: new Date(),
        },
      });

      /* Access is granted by the same membership row an administrator would
         have created directly — approval is not a second kind of access. A
         rejection writes no membership at all, so what the subject can reach
         is exactly what they could reach before. */
      if (approve) {
        await tx.projectMember.upsert({
          where: {
            projectId_userId: {
              projectId: request.projectId,
              userId: request.subjectId,
            },
          },
          update: {},
          create: { projectId: request.projectId, userId: request.subjectId },
        });
      }

      const recipients = [
        ...new Set([request.requesterId, request.subjectId]),
      ].filter((id) => id !== user.id);

      if (recipients.length > 0) {
        await tx.notification.createMany({
          data: recipients.map((userId) => ({
            userId,
            type: "PROJECT_ACCESS_REQUEST" as const,
            actorId: user.id,
            projectId: request.projectId,
            message: approve
              ? `approved access to ${request.project.name} for ${request.subject.name}.`
              : `declined the request for ${request.subject.name} to access ${request.project.name}.`,
          })),
        });
      }
    });

    revalidatePath(`/projects/${request.project.key.toLowerCase()}`);
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error);
  }
}
