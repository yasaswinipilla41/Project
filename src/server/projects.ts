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
 * **What travels.** The project's project-scoped configuration — name,
 * description, membership and its label vocabulary — and the work inside it:
 * every issue, with its type, status, priority, assignee, reporter, labels,
 * due date and remaining fields, and every comment on those issues with its
 * thread structure and its reactions. The result is a working copy, not a
 * skeleton: somebody can open it and carry on.
 *
 * **What is copied rather than shared.** Everything. Every row above is a new
 * row with a new primary key, and every attachment is written to a new storage
 * object rather than pointing at the original's bytes. There is no mutable
 * state in common, which is the property the whole feature rests on: editing,
 * or deleting, anything in the clone cannot reach the original.
 *
 * **What deliberately does not travel:**
 *
 *   - keys, ids and timestamps — all fresh, and `createdBy` is whoever asked
 *     for the copy, not whoever created the source;
 *   - `isDefaultProject`, so a copy never silently starts enrolling every new
 *     account that signs up. It is left at its default of `false`;
 *   - the audit trail, notifications and watchers. A clone is a board to work
 *     in, not a fabricated record of work that was already done — and for the
 *     same reason a copied issue arrives with a fresh QA verdict rather than
 *     an inherited claim that somebody tested it;
 *   - the retired `stepsToReproduce` / `expectedResult` / `actualResult`
 *     columns, which no form writes and no page shows;
 *   - personal bookmarks (favourites, pins, recents) and organisation-wide
 *     settings, neither of which is project configuration.
 *
 * Statuses, priorities, issue types and the Flow Board's columns are Prisma
 * enums and module constants, shared by the whole installation rather than
 * configured per project. There is nothing project-scoped to copy for them,
 * and inventing per-project rows would be duplicating global configuration —
 * so the clone inherits them exactly as a project created from scratch does.
 *
 * The two choices, both on by default so an ordinary duplicate is a complete
 * one, and both honoured exactly as ticked:
 *
 *   - **links** — parent/child hierarchy and `IssueLink` relationships,
 *     re-pointed at the cloned counterparts. Relationships are re-pointed and
 *     never re-used: nothing in the clone links back into the original, and a
 *     link whose other end was not copied is dropped rather than left dangling.
 *   - **attachments** — the project's own files, its issues' files and its
 *     comments' files, copied byte for byte into new storage objects.
 *
 * Every row is written inside one transaction, so a clone that fails partway
 * leaves nothing behind to tidy up and nothing that could be mistaken for a
 * finished copy. Files are copied afterwards, because a filesystem cannot be
 * rolled back by a database.
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
    copiedComments: number;
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

    /* Probing for a free key is a read loop, and belongs outside the
       transaction that then holds a write lock on nothing else. */
    const key = await deriveCopyKey(source.name, projectId);
    const memberIds = new Set([user.id, ...source.members.map((m) => m.userId)]);

    /*
     * One transaction for the whole structure. A large project is a lot of
     * rows — the timeout is raised to match, rather than the five seconds a
     * short interactive transaction assumes — and the point of the boundary is
     * that there is no state in between: either the clone exists complete, or
     * it does not exist at all.
     */
    const written = await prisma.$transaction(
      async (tx) => {
        const project = await tx.project.create({
          data: {
            name: `${source.name} (Copy)`,
            key,
            description: source.description,
            createdById: user.id,
            /* `isDefaultProject` is deliberately absent: it defaults to false,
               so a copy of the default project does not quietly become a
               second one and start enrolling every new account. */
            members: {
              createMany: {
                data: [...memberIds].map((userId) => ({ userId })),
              },
            },
            labels: {
              createMany: {
                data: source.labels.map((l) => ({
                  name: l.name,
                  color: l.color,
                })),
              },
            },
          },
          select: { id: true, key: true },
        });

        const copied = await copyProjectIssues(
          tx,
          project.id,
          project.key,
          projectId,
          { copyLinks, memberIds },
        );

        return { project, copied };
      },
      { maxWait: 20_000, timeout: 180_000 },
    );

    const { project, copied } = written;

    /*
     * Files last, and outside the transaction: copying bytes is not something
     * the database can undo, so it must not be able to roll the structure back
     * either. Each file is copied independently and a failure is logged and
     * counted out, so one unreadable object cannot cost the clone its issues.
     */
    let copiedAttachments = 0;
    if (copyAttachments) {
      copiedAttachments =
        (await copyProjectFiles(source.attachments, project.id, user.id)) +
        (await copyIssueFiles(copied.idByOldId, copied.commentIdByOldId, user.id));
    }

    revalidatePath("/projects");
    revalidatePath("/");

    return {
      ok: true,
      data: {
        id: project.id,
        key: project.key,
        copiedIssues: copied.count,
        copiedComments: copied.comments,
        copiedLinks: copied.links,
        copiedAttachments,
      },
    };
  } catch (error) {
    return failure(error);
  }
}

/** The transaction handle `copyProjectIssues` and its helpers write through. */
type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * Re-creates one project's issues — and the conversations on them — inside
 * another, and reports the mappings.
 *
 * Keys come from the destination project's own `issueSequence`, taken in one
 * increment so the numbers are contiguous and no other create can interleave
 * with them. Nothing here reuses a source key: `INT-4` cloned into `INTCOPY`
 * becomes `INTCOPY-4` because it is the fourth issue *there*, not because it
 * was the fourth issue anywhere else.
 *
 * The old-id → new-id maps are what make relationships, threads and files
 * copyable at all, and are returned so attachments can be copied against them
 * afterwards.
 *
 * Everything is written in bulk. A project with several hundred issues is the
 * case this has to survive, so the only per-row work left is re-pointing a
 * parent — and even that is batched by parent rather than issued one row at a
 * time.
 */
async function copyProjectIssues(
  tx: Tx,
  targetProjectId: string,
  targetProjectKey: string,
  sourceProjectId: string,
  options: { copyLinks: boolean; memberIds: Set<string> },
): Promise<{
  count: number;
  comments: number;
  links: number;
  idByOldId: Map<string, string>;
  commentIdByOldId: Map<string, string>;
}> {
  const issues = await tx.issue.findMany({
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
  const commentIdByOldId = new Map<string, string>();
  if (issues.length === 0) {
    return { count: 0, comments: 0, links: 0, idByOldId, commentIdByOldId };
  }

  const sequence = await tx.project.update({
    where: { id: targetProjectId },
    data: { issueSequence: { increment: issues.length } },
    select: { issueSequence: true },
  });
  const firstNumber = sequence.issueSequence - issues.length + 1;

  await tx.issue.createMany({
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

  const created = await tx.issue.findMany({
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
  const labels = await tx.label.findMany({
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
    await tx.issueLabel.createMany({
      data: issueLabels,
      skipDuplicates: true,
    });
  }

  const comments = await copyIssueComments(tx, idByOldId, commentIdByOldId);

  let links = 0;
  if (options.copyLinks) {
    /* Hierarchy, re-pointed at the cloned parent — never at the original's.
       Grouped by parent so a project with hundreds of children costs one
       statement per parent rather than one per child. */
    const childrenByParent = new Map<string, string[]>();
    for (const issue of issues) {
      const child = idByOldId.get(issue.id);
      const parent = issue.parentId ? idByOldId.get(issue.parentId) : undefined;
      if (!child || !parent) continue;
      const siblings = childrenByParent.get(parent);
      if (siblings) siblings.push(child);
      else childrenByParent.set(parent, [child]);
    }

    for (const [parentId, children] of childrenByParent) {
      const updated = await tx.issue.updateMany({
        where: { id: { in: children } },
        data: { parentId },
      });
      links += updated.count;
    }

    /*
     * Relationships, both directions of each pair. Only links whose *other*
     * end was copied too: a relationship reaching outside this project has no
     * counterpart here, and pointing the clone back at the original's issues
     * would tie the two projects together — the opposite of a clone.
     */
    const sourceLinks = await tx.issueLink.findMany({
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
      const written = await tx.issueLink.createMany({
        data: mapped,
        skipDuplicates: true,
      });
      links += written.count;
    }
  }

  return { count: issues.length, comments, links, idByOldId, commentIdByOldId };
}

/**
 * The conversations on the copied issues, with their threads intact.
 *
 * Comments travel because a duplicated project is meant to be a working copy,
 * and a working copy of an issue whose discussion has been deleted is not one.
 * They are copied as *content*: the author is preserved, because who said a
 * thing is part of what was said, while the ids and the timestamps are new.
 *
 * Timestamps are re-stamped one millisecond apart in the source's own
 * chronological order. That serves two purposes: the thread still reads in the
 * order it was written, and — because every copied comment therefore has a
 * distinct `createdAt` — reading the rows back in that order maps each new id
 * onto the comment it came from without needing the database to hand ids back
 * from a bulk insert.
 *
 * Replies are re-pointed at the copied parent in a second pass, batched by
 * parent. A reply whose parent somehow did not travel is promoted to the top
 * level rather than left pointing into the original project, which is the one
 * outcome that would tie the two conversations together.
 */
async function copyIssueComments(
  tx: Tx,
  idByOldId: Map<string, string>,
  commentIdByOldId: Map<string, string>,
): Promise<number> {
  const sources = await tx.comment.findMany({
    where: { issueId: { in: [...idByOldId.keys()] } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      issueId: true,
      authorId: true,
      body: true,
      parentId: true,
      editedAt: true,
      reactions: { select: { userId: true, emoji: true } },
    },
  });
  if (sources.length === 0) return 0;

  /* A fixed base, so the whole clone's comments occupy one contiguous, unique
     range of timestamps that nothing else in the table shares. */
  const base = Date.now();
  const stampFor = (index: number) => new Date(base + index);

  const rows = sources.flatMap((comment, index) => {
    const issueId = idByOldId.get(comment.issueId);
    if (!issueId) return [];
    return [
      {
        issueId,
        authorId: comment.authorId,
        body: comment.body,
        // Parents are re-pointed below, once the new ids are known.
        parentId: null,
        editedAt: comment.editedAt,
        createdAt: stampFor(index),
      },
    ];
  });
  if (rows.length === 0) return 0;

  await tx.comment.createMany({ data: rows });

  /* Read back through the timestamps just written. They are unique and
     strictly increasing, so this order is exactly the order the rows were
     built in — which is the order `sources` is in. */
  const createdRows = await tx.comment.findMany({
    where: {
      issueId: { in: [...idByOldId.values()] },
      createdAt: { gte: stampFor(0), lte: stampFor(sources.length) },
    },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });

  const copyable = sources.filter((comment) => idByOldId.has(comment.issueId));
  copyable.forEach((comment, index) => {
    const created = createdRows[index];
    if (created) commentIdByOldId.set(comment.id, created.id);
  });

  // Threads, re-pointed at the copied parent, batched by parent.
  const repliesByParent = new Map<string, string[]>();
  for (const comment of copyable) {
    if (!comment.parentId) continue;
    const child = commentIdByOldId.get(comment.id);
    const parent = commentIdByOldId.get(comment.parentId);
    if (!child || !parent) continue;
    const siblings = repliesByParent.get(parent);
    if (siblings) siblings.push(child);
    else repliesByParent.set(parent, [child]);
  }

  for (const [parentId, children] of repliesByParent) {
    await tx.comment.updateMany({
      where: { id: { in: children } },
      data: { parentId },
    });
  }

  /* Reactions belong to the copied comment alone: same person, same emoji,
     a new row. Reacting on the copy can never touch the original's count. */
  const reactions = copyable.flatMap((comment) => {
    const commentId = commentIdByOldId.get(comment.id);
    if (!commentId) return [];
    return comment.reactions.map((reaction) => ({
      commentId,
      userId: reaction.userId,
      emoji: reaction.emoji,
    }));
  });
  if (reactions.length > 0) {
    await tx.commentReaction.createMany({
      data: reactions,
      skipDuplicates: true,
    });
  }

  return commentIdByOldId.size;
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
 * Each copied issue's own files, and the files on its copied comments.
 *
 * A comment attachment carries both an `issueId` and a `commentId`, so one
 * query finds every file on the copied issues and the `commentId` decides
 * which of the two it belongs to. A file whose comment did not travel is
 * skipped rather than re-attached to the issue, where it would appear as
 * something nobody attached there.
 *
 * Every copy is a new storage object as well as a new row. Sharing the bytes
 * would be safe while nothing deletes them, and that is exactly the assumption
 * that breaks the first time somebody removes a file from the copy.
 */
async function copyIssueFiles(
  idByOldId: Map<string, string>,
  commentIdByOldId: Map<string, string>,
  uploadedById: string,
): Promise<number> {
  if (idByOldId.size === 0) return 0;

  const attachments = await prisma.attachment.findMany({
    where: { issueId: { in: [...idByOldId.keys()] } },
    orderBy: { createdAt: "asc" },
    select: {
      issueId: true,
      commentId: true,
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

    const commentId = source.commentId
      ? commentIdByOldId.get(source.commentId)
      : null;
    if (source.commentId && !commentId) continue;

    try {
      if ((await provider.size(source.storageKey)) === null) continue;
      const extension = /\.[A-Za-z0-9]{1,8}$/.exec(source.filename)?.[0] ?? "";
      const stored = await provider.put(await provider.read(source.storageKey), {
        extension,
      });
      await prisma.attachment.create({
        data: {
          issueId,
          commentId,
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
