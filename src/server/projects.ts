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
  cloneProjectSchema,
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
 * Clone a project.
 *
 * The clone is a genuinely new project: its own id, its own key, its own issue
 * sequence, created by whoever asked for it. The source is only ever read.
 *
 * What always travels is the project's *structure* — name, description, labels
 * and membership — so the same team can start working in it without being
 * re-invited by hand. Its issues travel too, as new issues with fresh keys
 * from the clone's own sequence: without them the two copy choices below would
 * have nothing to act on, because a project owns no relationships of its own,
 * only the ones between the issues inside it.
 *
 * What never travels is history: no activity, no comments, no notifications,
 * no watchers, no created/updated timestamps and no keys. A cloned board is a
 * board to work in, not a fabricated record of work that was done.
 *
 * The two choices, both off by default:
 *
 *   - **links** — parent/child hierarchy and `IssueLink` relationships,
 *     re-pointed at the cloned counterparts. Relationships are re-pointed and
 *     never re-used: nothing in the clone links back into the original, and a
 *     link whose other end was not copied is dropped rather than left dangling.
 *   - **attachments** — the project's own files and its issues' files, copied
 *     byte for byte into new storage objects.
 *
 * Gated the same way `createProject` is — creating a project, in whatever
 * form, is an administrator action.
 */
export async function duplicateProject(
  raw: unknown,
): Promise<
  ProjectActionResult<{
    id: string;
    key: string;
    copiedIssues: number;
    copiedLinks: number;
    copiedAttachments: number;
  }>
> {
  try {
    const user = await requireUser();
    assertAdmin(user);

    const parsed = cloneProjectSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, error: "Choose a project to duplicate." };
    }
    const { projectId, copyLinks, copyAttachments } = parsed.data;

    const source = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        name: true,
        description: true,
        members: { select: { userId: true } },
        labels: { select: { name: true, color: true } },
        attachments: {
          orderBy: { createdAt: "asc" },
          select: {
            filename: true,
            storageKey: true,
            mimeType: true,
            width: true,
            height: true,
          },
        },
      },
    });
    if (!source) {
      return { ok: false, error: "This project no longer exists." };
    }

    const key = await deriveCopyKey(source.name, projectId);
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
          createMany: {
            data: source.labels.map((l) => ({ name: l.name, color: l.color })),
          },
        },
      },
      select: { id: true, key: true },
    });

    const copied = await copyProjectIssues(project.id, project.key, projectId, {
      copyLinks,
      memberIds,
    });

    let copiedAttachments = 0;
    if (copyAttachments) {
      copiedAttachments =
        (await copyProjectFiles(source.attachments, project.id, user.id)) +
        (await copyIssueFiles(copied.idByOldId, user.id));
    }

    revalidatePath("/projects");
    revalidatePath("/");

    return {
      ok: true,
      data: {
        id: project.id,
        key: project.key,
        copiedIssues: copied.count,
        copiedLinks: copied.links,
        copiedAttachments,
      },
    };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Re-creates one project's issues inside another, and reports the mapping.
 *
 * Keys come from the destination project's own `issueSequence`, taken in one
 * increment so the numbers are contiguous and no other create can interleave
 * with them. Nothing here reuses a source key: `INT-4` cloned into `INTCOPY`
 * becomes `INTCOPY-4` because it is the fourth issue *there*, not because it
 * was the fourth issue anywhere else.
 *
 * The old-id → new-id map is what makes relationships copyable at all, and is
 * returned so attachments can be copied against it afterwards.
 */
async function copyProjectIssues(
  targetProjectId: string,
  targetProjectKey: string,
  sourceProjectId: string,
  options: { copyLinks: boolean; memberIds: Set<string> },
): Promise<{ count: number; links: number; idByOldId: Map<string, string> }> {
  const issues = await prisma.issue.findMany({
    where: { projectId: sourceProjectId },
    orderBy: { number: "asc" },
    select: {
      id: true,
      type: true,
      title: true,
      description: true,
      status: true,
      priority: true,
      severity: true,
      assigneeId: true,
      reporterId: true,
      dueDate: true,
      sortIndex: true,
      completedAt: true,
      parentId: true,
      environment: true,
      browser: true,
      operatingSystem: true,
      versionBuild: true,
      affectedModule: true,
      labels: { select: { label: { select: { name: true } } } },
    },
  });

  const idByOldId = new Map<string, string>();
  if (issues.length === 0) return { count: 0, links: 0, idByOldId };

  const sequence = await prisma.project.update({
    where: { id: targetProjectId },
    data: { issueSequence: { increment: issues.length } },
    select: { issueSequence: true },
  });
  const firstNumber = sequence.issueSequence - issues.length + 1;

  await prisma.issue.createMany({
    data: issues.map((issue, index) => ({
      key: `${targetProjectKey}-${firstNumber + index}`,
      number: firstNumber + index,
      projectId: targetProjectId,
      type: issue.type,
      title: issue.title,
      description: issue.description,
      status: issue.status,
      priority: issue.priority,
      severity: issue.severity,
      /* Only if they can still be assigned here. Membership is copied, so in
         practice they can — but an assignee who is not a member of the project
         they are assigned in is precisely what `createIssue` refuses, and a
         clone must not create one by the back door. */
      assigneeId:
        issue.assigneeId && options.memberIds.has(issue.assigneeId)
          ? issue.assigneeId
          : null,
      reporterId: issue.reporterId,
      dueDate: issue.dueDate,
      sortIndex: issue.sortIndex,
      completedAt: issue.completedAt,
      environment: issue.environment,
      browser: issue.browser,
      operatingSystem: issue.operatingSystem,
      versionBuild: issue.versionBuild,
      affectedModule: issue.affectedModule,
    })),
  });

  const created = await prisma.issue.findMany({
    where: { projectId: targetProjectId },
    orderBy: { number: "asc" },
    select: { id: true, number: true },
  });
  const idByNumber = new Map(created.map((row) => [row.number, row.id]));
  issues.forEach((issue, index) => {
    const id = idByNumber.get(firstNumber + index);
    if (id) idByOldId.set(issue.id, id);
  });

  // Labels, matched by name — the clone has its own label rows.
  const labels = await prisma.label.findMany({
    where: { projectId: targetProjectId },
    select: { id: true, name: true },
  });
  const labelIdByName = new Map(labels.map((label) => [label.name, label.id]));

  const issueLabels = issues.flatMap((issue) => {
    const newIssueId = idByOldId.get(issue.id);
    if (!newIssueId) return [];
    return issue.labels.flatMap((entry) => {
      const labelId = labelIdByName.get(entry.label.name);
      return labelId ? [{ issueId: newIssueId, labelId }] : [];
    });
  });
  if (issueLabels.length > 0) {
    await prisma.issueLabel.createMany({
      data: issueLabels,
      skipDuplicates: true,
    });
  }

  let links = 0;
  if (options.copyLinks) {
    // Hierarchy, re-pointed at the cloned parent — never at the original's.
    for (const issue of issues) {
      const child = idByOldId.get(issue.id);
      const parent = issue.parentId ? idByOldId.get(issue.parentId) : undefined;
      if (child && parent) {
        await prisma.issue.update({
          where: { id: child },
          data: { parentId: parent },
        });
        links += 1;
      }
    }

    /*
     * Relationships, both directions of each pair. Only links whose *other*
     * end was copied too: a relationship reaching outside this project has no
     * counterpart here, and pointing the clone back at the original's issues
     * would tie the two projects together — the opposite of a clone.
     */
    const sourceLinks = await prisma.issueLink.findMany({
      where: {
        source: { projectId: sourceProjectId },
        target: { projectId: sourceProjectId },
      },
      select: { sourceId: true, targetId: true, type: true, createdById: true },
    });

    const mapped = sourceLinks.flatMap((link) => {
      const sourceId = idByOldId.get(link.sourceId);
      const targetId = idByOldId.get(link.targetId);
      if (!sourceId || !targetId || sourceId === targetId) return [];
      return [
        { sourceId, targetId, type: link.type, createdById: link.createdById },
      ];
    });

    if (mapped.length > 0) {
      const written = await prisma.issueLink.createMany({
        data: mapped,
        skipDuplicates: true,
      });
      links += written.count;
    }
  }

  return { count: issues.length, links, idByOldId };
}

/** The project's own files, copied onto the clone. */
async function copyProjectFiles(
  sources: {
    filename: string;
    storageKey: string;
    mimeType: string;
    width: number | null;
    height: number | null;
  }[],
  projectId: string,
  uploadedById: string,
): Promise<number> {
  if (sources.length === 0) return 0;

  const { storage } = await import("@/server/storage");
  const provider = storage();
  let copied = 0;

  for (const source of sources) {
    try {
      if ((await provider.size(source.storageKey)) === null) continue;
      const extension = /\.[A-Za-z0-9]{1,8}$/.exec(source.filename)?.[0] ?? "";
      const stored = await provider.put(await provider.read(source.storageKey), {
        extension,
      });
      await prisma.attachment.create({
        data: {
          projectId,
          uploadedById,
          filename: source.filename,
          storageKey: stored.key,
          mimeType: source.mimeType,
          byteSize: stored.byteSize,
          width: source.width,
          height: source.height,
        },
      });
      copied += 1;
    } catch (error) {
      console.error("[prio] could not copy a project attachment:", error);
    }
  }

  return copied;
}

/**
 * Each copied issue's own files.
 *
 * Comment attachments are deliberately left behind: comments are not cloned,
 * so a comment's file would arrive with nothing to belong to.
 */
async function copyIssueFiles(
  idByOldId: Map<string, string>,
  uploadedById: string,
): Promise<number> {
  if (idByOldId.size === 0) return 0;

  const attachments = await prisma.attachment.findMany({
    where: { issueId: { in: [...idByOldId.keys()] }, commentId: null },
    orderBy: { createdAt: "asc" },
    select: {
      issueId: true,
      filename: true,
      storageKey: true,
      mimeType: true,
      width: true,
      height: true,
    },
  });
  if (attachments.length === 0) return 0;

  const { storage } = await import("@/server/storage");
  const provider = storage();
  let copied = 0;

  for (const source of attachments) {
    const issueId = source.issueId ? idByOldId.get(source.issueId) : undefined;
    if (!issueId) continue;

    try {
      if ((await provider.size(source.storageKey)) === null) continue;
      const extension = /\.[A-Za-z0-9]{1,8}$/.exec(source.filename)?.[0] ?? "";
      const stored = await provider.put(await provider.read(source.storageKey), {
        extension,
      });
      await prisma.attachment.create({
        data: {
          issueId,
          uploadedById,
          filename: source.filename,
          storageKey: stored.key,
          mimeType: source.mimeType,
          byteSize: stored.byteSize,
          width: source.width,
          height: source.height,
        },
      });
      copied += 1;
    } catch (error) {
      console.error("[prio] could not copy an issue attachment:", error);
    }
  }

  return copied;
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
