"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import {
  assertAdmin,
  assertProjectAccess,
  assertProjectManage,
  AuthorizationError,
  NotFoundError,
} from "@/lib/authz";
import { requireUser } from "@/lib/session";
import {
  createLabelSchema,
  createProjectSchema,
  deleteProjectSchema,
  fieldErrors,
  projectMemberSchema,
  updateProjectSchema,
  type FieldErrors,
} from "@/server/schemas";

/**
 * Project administration.
 *
 * Two different permissions live here and must not be conflated:
 *
 *   - **Creating** a project, and managing its membership, is an administrator
 *     action. Handing membership control to anyone who happens to belong to a
 *     project would let a member quietly grant themselves company-wide reach.
 *   - **Editing and deleting** a project belongs to an administrator *or* to
 *     the person who created it — see `assertProjectManage`. Other members of
 *     the same project can read and work in it, and nothing more.
 *
 * Members read through the project scope in `authz`.
 */

export type ProjectActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: FieldErrors };

function failure(error: unknown): ProjectActionResult<never> {
  if (error instanceof AuthorizationError || error instanceof NotFoundError) {
    return { ok: false, error: error.message };
  }
  console.error("[prio] project action failed:", error);
  return { ok: false, error: "Something went wrong. Please try again." };
}

export async function createProject(
  raw: unknown,
): Promise<ProjectActionResult<{ id: string; key: string }>> {
  try {
    const user = await requireUser();
    assertAdmin(user);

    const parsed = createProjectSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        error: "Please correct the highlighted fields.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }
    const input = parsed.data;

    const clash = await prisma.project.findUnique({
      where: { key: input.key },
      select: { id: true },
    });
    if (clash) {
      return {
        ok: false,
        error: "That project key is already in use.",
        fieldErrors: { key: "Already used by another project." },
      };
    }

    // The creator is always a member, so an admin never creates a project they
    // cannot then see in their own sidebar.
    const memberIds = [...new Set([user.id, ...input.memberIds])];

    const project = await prisma.project.create({
      data: {
        name: input.name,
        key: input.key,
        description: input.description,
        createdById: user.id,
        members: {
          createMany: { data: memberIds.map((userId) => ({ userId })) },
        },
      },
      select: { id: true, key: true },
    });

    revalidatePath("/projects");
    revalidatePath("/");

    return { ok: true, data: project };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Edit a project.
 *
 * Permitted for an administrator, or for the person who created the project —
 * and for nobody else, including other members of that same project. The check
 * runs here, against `createdById` read from the database, so calling this
 * action directly is no easier than clicking a button that was never rendered.
 */
export async function updateProject(
  raw: unknown,
): Promise<ProjectActionResult<{ key: string }>> {
  try {
    const user = await requireUser();

    const parsed = updateProjectSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        error: "Please correct the highlighted fields.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }

    await assertProjectManage(user, parsed.data.projectId);

    const project = await prisma.project.update({
      where: { id: parsed.data.projectId },
      data: {
        name: parsed.data.name,
        description: parsed.data.description,
        ...(parsed.data.isArchived === undefined
          ? {}
          : { isArchived: parsed.data.isArchived }),
        ...(parsed.data.isDefaultProject === undefined
          ? {}
          : { isDefaultProject: parsed.data.isDefaultProject }),
      },
      select: { key: true },
    });

    revalidatePath("/projects");
    revalidatePath(`/projects/${project.key.toLowerCase()}`);
    revalidatePath("/");

    return { ok: true, data: { key: project.key } };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Delete a project and everything that belonged to it.
 *
 * Three independent gates, in this order:
 *
 *  1. the caller is signed in;
 *  2. the caller is an administrator or the project's creator;
 *  3. the caller typed the project's exact name back.
 *
 * The third is not decoration. The confirmation field is checked here as well
 * as in the dialog, because a direct call to this action never passes through
 * the dialog at all.
 *
 * Removal itself relies on the cascades already declared in the schema —
 * issues, comments, mentions, activity, notifications, labels, memberships and
 * watchers all hang off the project or off its issues — inside a transaction,
 * so a failure part-way leaves the project whole rather than half-erased.
 */
export async function deleteProject(
  raw: unknown,
): Promise<ProjectActionResult<{ key: string; issues: number }>> {
  try {
    const user = await requireUser();

    const parsed = deleteProjectSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        error: "Please correct the highlighted fields.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }

    const project = await assertProjectManage(user, parsed.data.projectId);

    if (parsed.data.confirmName.trim() !== project.name) {
      return {
        ok: false,
        error: "The name you typed does not match this project.",
        fieldErrors: { confirmName: "This does not match the project name." },
      };
    }

    const issues = await prisma.$transaction(async (tx) => {
      const count = await tx.issue.count({ where: { projectId: project.id } });
      await tx.project.delete({ where: { id: project.id } });
      return count;
    });

    revalidatePath("/projects");
    revalidatePath("/issues");
    revalidatePath("/bugs");
    revalidatePath("/");

    return { ok: true, data: { key: project.key, issues } };
  } catch (error) {
    return failure(error);
  }
}

export async function addProjectMember(
  raw: unknown,
): Promise<ProjectActionResult> {
  try {
    const user = await requireUser();
    assertAdmin(user);

    const parsed = projectMemberSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: "Choose someone to add." };
    }

    await prisma.projectMember.upsert({
      where: {
        projectId_userId: {
          projectId: parsed.data.projectId,
          userId: parsed.data.userId,
        },
      },
      update: {},
      create: parsed.data,
    });

    const project = await prisma.project.findUnique({
      where: { id: parsed.data.projectId },
      select: { key: true },
    });
    if (project) {
      revalidatePath(`/projects/${project.key.toLowerCase()}`);
    }

    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error);
  }
}

export async function removeProjectMember(
  raw: unknown,
): Promise<ProjectActionResult> {
  try {
    const user = await requireUser();
    assertAdmin(user);

    const parsed = projectMemberSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: "Choose someone to remove." };
    }

    // Work assigned to a removed member stays assigned; unassigning silently
    // would lose information. Removal only revokes access.
    await prisma.projectMember.deleteMany({
      where: {
        projectId: parsed.data.projectId,
        userId: parsed.data.userId,
      },
    });

    const project = await prisma.project.findUnique({
      where: { id: parsed.data.projectId },
      select: { key: true },
    });
    if (project) {
      revalidatePath(`/projects/${project.key.toLowerCase()}`);
    }

    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error);
  }
}

export async function createLabel(
  raw: unknown,
): Promise<ProjectActionResult<{ id: string; name: string; color: string }>> {
  try {
    const user = await requireUser();

    const parsed = createLabelSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        error: "Please correct the highlighted fields.",
        fieldErrors: fieldErrors(parsed.error),
      };
    }

    // Any project member may add a label (§18 — members manage labels).
    await assertProjectAccess(user, parsed.data.projectId);

    const existing = await prisma.label.findUnique({
      where: {
        projectId_name: {
          projectId: parsed.data.projectId,
          name: parsed.data.name,
        },
      },
      select: { id: true, name: true, color: true },
    });
    if (existing) return { ok: true, data: existing };

    const label = await prisma.label.create({
      data: parsed.data,
      select: { id: true, name: true, color: true },
    });

    const project = await prisma.project.findUnique({
      where: { id: parsed.data.projectId },
      select: { key: true },
    });
    if (project) {
      revalidatePath(`/projects/${project.key.toLowerCase()}`);
    }

    return { ok: true, data: label };
  } catch (error) {
    return failure(error);
  }
}
