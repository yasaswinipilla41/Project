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
import { DEFAULT_PROJECT_LABELS } from "@/lib/domain";
import { requireUser } from "@/lib/session";
import {
  createLabelSchema,
  createProjectSchema,
  deleteProjectSchema,
  fieldErrors,
  projectIdSchema,
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
        // Every project starts with the same vocabulary; labels are
        // project-scoped, so each gets its own rows.
        labels: {
          createMany: { data: DEFAULT_PROJECT_LABELS },
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
 * Duplicate a project's structure — name, description and labels — onto a
 * fresh, empty project the caller now owns. Membership carries over too, so
 * the same team keeps working without being re-invited by hand.
 *
 * Deliberately does not copy issues: a "board" here means the structure
 * issues get filed into, not its history, and duplicating hundreds of issues
 * (with fresh keys, reset activity, no comments) would produce something that
 * only looks like a history and misleads anyone reading it later.
 *
 * Gated the same way `createProject` is — creating a project, in whatever
 * form, is an administrator action.
 */
export async function duplicateProject(
  raw: unknown,
): Promise<ProjectActionResult<{ id: string; key: string }>> {
  try {
    const user = await requireUser();
    assertAdmin(user);

    const parsed = projectIdSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: "Choose a project to duplicate." };
    }

    const source = await prisma.project.findUnique({
      where: { id: parsed.data.projectId },
      select: {
        name: true,
        description: true,
        members: { select: { userId: true } },
        labels: { select: { name: true, color: true } },
      },
    });
    if (!source) {
      return { ok: false, error: "This project no longer exists." };
    }

    const key = await deriveCopyKey(source.name, parsed.data.projectId);
    const memberIds = new Set([user.id, ...source.members.map((m) => m.userId)]);

    const project = await prisma.project.create({
      data: {
        name: `${source.name} (Copy)`,
        key,
        description: source.description,
        createdById: user.id,
        members: {
          createMany: { data: [...memberIds].map((userId) => ({ userId })) },
        },
        labels: {
          createMany: { data: source.labels.map((l) => ({ name: l.name, color: l.color })) },
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
 * A project key is at most 10 letters/digits (`projectKeySchema`), so the
 * source name is boiled down to its letters, truncated to leave room for a
 * numbered suffix, and probed until a free key is found.
 */
async function deriveCopyKey(sourceName: string, excludeProjectId: string): Promise<string> {
  const letters = sourceName.replace(/[^A-Za-z0-9]/g, "").toUpperCase() || "PROJECT";

  for (let n = 1; n <= 50; n++) {
    const suffix = n === 1 ? "COPY" : `CP${n}`;
    const candidate = (letters.slice(0, Math.max(1, 10 - suffix.length)) + suffix).slice(0, 10);

    const clash = await prisma.project.findUnique({
      where: { key: candidate },
      select: { id: true },
    });
    if (!clash || clash.id === excludeProjectId) return candidate;
  }

  throw new Error("Could not derive a free project key after 50 attempts.");
}

/**
 * Toggle whether the caller has starred this project's Flow Board.
 *
 * Kept independent of `assertProjectManage` — favoriting is a personal
 * bookmark, not a change to the project, so anyone who can *see* the board
 * (`assertProjectAccess`) may star it, including an admin who is not a member.
 */
export async function toggleProjectFavorite(
  raw: unknown,
): Promise<ProjectActionResult<{ isFavorite: boolean }>> {
  try {
    const user = await requireUser();

    const parsed = projectIdSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: "Choose a project to favorite." };
    }

    await assertProjectAccess(user, parsed.data.projectId);

    const existing = await prisma.projectFavorite.findUnique({
      where: {
        projectId_userId: { projectId: parsed.data.projectId, userId: user.id },
      },
      select: { projectId: true },
    });

    if (existing) {
      await prisma.projectFavorite.delete({
        where: {
          projectId_userId: { projectId: parsed.data.projectId, userId: user.id },
        },
      });
      return { ok: true, data: { isFavorite: false } };
    }

    await prisma.projectFavorite.create({
      data: { projectId: parsed.data.projectId, userId: user.id },
    });
    return { ok: true, data: { isFavorite: true } };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Toggle whether the caller has pinned this project to the top of their
 * sidebar. Same access rule as favoriting — anyone who can see the project
 * may pin it — and a separate table from `ProjectFavorite` because the two
 * are independent states, not two names for the same fact.
 */
export async function toggleProjectPin(
  raw: unknown,
): Promise<ProjectActionResult<{ isPinned: boolean }>> {
  try {
    const user = await requireUser();

    const parsed = projectIdSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: "Choose a project to pin." };
    }

    await assertProjectAccess(user, parsed.data.projectId);

    const existing = await prisma.projectPin.findUnique({
      where: {
        projectId_userId: { projectId: parsed.data.projectId, userId: user.id },
      },
      select: { projectId: true },
    });

    if (existing) {
      await prisma.projectPin.delete({
        where: {
          projectId_userId: { projectId: parsed.data.projectId, userId: user.id },
        },
      });
      return { ok: true, data: { isPinned: false } };
    }

    await prisma.projectPin.create({
      data: { projectId: parsed.data.projectId, userId: user.id },
    });
    return { ok: true, data: { isPinned: true } };
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

    /*
     * Reuse rather than create, and match without regard to case.
     *
     * The unique constraint is on the exact name, so "Accounting" beside
     * "accounting" is two rows to Postgres and one label to a person. Typing a
     * name that already exists in another case now returns the existing label
     * instead of quietly making a second one that filters and reports split
     * their counts between.
     *
     * Only new labels are affected. Any case-variant pairs already in a
     * project keep both rows and every issue keeps the exact label it was
     * given — this refuses to make more, it does not merge what is there.
     */
    const existing = await prisma.label.findFirst({
      where: {
        projectId: parsed.data.projectId,
        name: { equals: parsed.data.name, mode: "insensitive" },
      },
      select: { id: true, name: true, color: true },
      orderBy: { name: "asc" },
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
