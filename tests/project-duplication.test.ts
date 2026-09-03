import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { createIssue, updateIssue } from "@/server/issues";
import { createIssueLink } from "@/server/links";
import {
  createComment,
  deleteComment,
  toggleCommentReaction,
  updateComment,
} from "@/server/comments";
import { createProject, duplicateProject, updateProject } from "@/server/projects";
import {
  LocalStorageProvider,
  setStorageProvider,
  storage,
} from "@/server/storage";
import { actAs } from "./helpers";

/**
 * Duplicating a whole project.
 *
 * The product rule these tests exist to hold is one sentence: **a duplicated
 * project is a complete, independent working copy.** Complete, so the
 * configuration, the issues, their threads and their files all arrive; and
 * independent, so nothing anyone does in the copy can reach the original.
 *
 * Independence is the half that cannot be established by reading the copy. A
 * clone that shared a row with its source would look perfect until the moment
 * somebody edited it, so almost every test below *changes something in the
 * copy and then re-reads the original* — which is the only evidence that the
 * two are not the same record wearing two names.
 *
 * Email is stubbed: commenting sends notifications, and these tests are about
 * what is written, not about SMTP.
 */

vi.mock("@/server/mailer", () => ({
  sendIssueMail: async () => ({ sent: 0, skipped: true }),
  sendIssueMailInBackground: () => undefined,
  setMailTransport: () => undefined,
}));

const ADMIN = "admin@symbiosystech.com";
const MEMBER = "priya.nair@symbiosystech.com";

const createdProjects: string[] = [];
const scratch: string[] = [];

beforeAll(async () => {
  /* Storage is a temporary directory, so "the bytes were really copied" can be
     proved by reading the files back without touching real uploads. */
  const dir = await mkdtemp(path.join(tmpdir(), "prio-projectdup-"));
  scratch.push(dir);
  setStorageProvider(new LocalStorageProvider(dir));
});

afterAll(async () => {
  setStorageProvider(null);
  if (createdProjects.length > 0) {
    await prisma.project.deleteMany({ where: { id: { in: createdProjects } } });
  }
  /* A copy this file did not expect to exist — the atomicity test's clone, if
     it ever stops failing — would otherwise be left in the database for every
     later run to trip over. Every project made here is named from one of the
     fixtures above, so the sweep cannot reach anything else. */
  await prisma.project.deleteMany({
    where: {
      OR: [
        { name: { contains: " source (Copy)" } },
        { name: { startsWith: "Blocker " } },
        { name: { startsWith: "Renamed copy" } },
        { name: { startsWith: "Large source" } },
      ],
    },
  });
  await Promise.all(
    scratch.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  await prisma.$disconnect();
});

let sequence = 0;
/** Keys are at most 10 characters and must be unique across the database. */
function nextKey(): string {
  sequence += 1;
  return `PD${Date.now().toString(36).slice(-5)}${sequence}`.slice(0, 10).toUpperCase();
}

async function attach(
  target: { issueId?: string; projectId?: string; commentId?: string },
  uploadedById: string,
  filename: string,
  text: string,
): Promise<string> {
  const stored = await storage().put(
    Readable.toWeb(Readable.from([Buffer.from(text)])) as ReadableStream<Uint8Array>,
    { extension: path.extname(filename) },
  );

  const row = await prisma.attachment.create({
    data: {
      ...target,
      uploadedById,
      filename,
      storageKey: stored.key,
      mimeType: "text/plain",
      byteSize: stored.byteSize,
    },
    select: { id: true },
  });
  return row.id;
}

async function readStored(key: string): Promise<string> {
  const chunks: Buffer[] = [];
  const reader = (await storage().read(key)).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * A representative project: two issue types, two statuses, two priorities, two
 * assignees, a grown label, a parent/child pair, a related pair, a comment with
 * a nested reply and a reaction, and files at all three levels.
 *
 * Deliberately built through the ordinary server actions rather than by writing
 * rows, so what is duplicated is what the application actually produces.
 */
async function makeSource(label = "Duplication source") {
  const admin = await actAs(ADMIN);
  const member = await prisma.user.findUniqueOrThrow({
    where: { email: MEMBER },
    select: { id: true },
  });

  const created = await createProject({
    name: label,
    key: nextKey(),
    description: "Everything project-scoped should travel.",
    memberIds: [member.id],
  });
  if (!created.ok) throw new Error(`fixture failed: ${created.error}`);
  createdProjects.push(created.data.id);
  const projectId = created.data.id;

  const grown = await prisma.label.create({
    data: { projectId, name: "Regression sweep", color: "#AA33CC" },
    select: { id: true },
  });

  const parent = await createIssue({
    projectId,
    type: "STORY",
    title: "Fix login issue",
    description: "The parent story.",
    status: "IN_PROGRESS",
    priority: "HIGH",
    assigneeId: admin.id,
    labelIds: [grown.id],
    dueDate: "2026-12-24",
  });
  if (!parent.ok) throw new Error(parent.error);

  const child = await createIssue({
    projectId,
    type: "BUG",
    title: "Child bug",
    status: "TODO",
    priority: "LOW",
    severity: "MAJOR",
    assigneeId: member.id,
    parentId: parent.data.id,
  });
  if (!child.ok) throw new Error(child.error);

  const related = await createIssue({
    projectId,
    type: "TASK",
    title: "Related task",
    status: "BACKLOG",
    priority: "MEDIUM",
  });
  if (!related.ok) throw new Error(related.error);

  await createIssueLink({
    issueId: parent.data.id,
    targetKey: related.data.key,
    type: "RELATES_TO",
  });

  // A thread: a comment, a reply beneath it, and a reaction on the comment.
  const root = await createComment({
    issueId: parent.data.id,
    body: "Newly created video is not displaying in History.",
  });
  if (!root.ok) throw new Error(root.error);

  await actAs(MEMBER);
  const reply = await createComment({
    issueId: parent.data.id,
    body: "yes",
    parentId: root.data.id,
  });
  if (!reply.ok) throw new Error(reply.error);
  await toggleCommentReaction({ commentId: root.data.id, emoji: "\u{1F44D}" });

  await actAs(ADMIN);

  const projectFile = await attach(
    { projectId },
    admin.id,
    "charter.txt",
    "project bytes",
  );
  const issueFile = await attach(
    { issueId: parent.data.id },
    admin.id,
    "spec.txt",
    "issue bytes",
  );
  const commentFile = await attach(
    { issueId: parent.data.id, commentId: root.data.id },
    admin.id,
    "evidence.txt",
    "comment bytes",
  );

  return {
    admin,
    member,
    projectId,
    key: created.data.key,
    name: label,
    labelId: grown.id,
    parentId: parent.data.id,
    childId: child.data.id,
    relatedId: related.data.id,
    rootCommentId: root.data.id,
    replyCommentId: reply.data.id,
    projectFile,
    issueFile,
    commentFile,
  };
}

/** Duplicates `projectId` with both choices on, and registers it for cleanup. */
async function duplicate(
  projectId: string,
  choices: { copyLinks?: boolean; copyAttachments?: boolean } = {},
) {
  await actAs(ADMIN);
  const result = await duplicateProject({
    projectId,
    copyLinks: choices.copyLinks ?? true,
    copyAttachments: choices.copyAttachments ?? true,
  });
  if (!result.ok) throw new Error(`clone failed: ${result.error}`);
  createdProjects.push(result.data.id);
  return result.data;
}

/** The clone's issues, keyed by title — titles are unique in the fixture. */
async function issuesByTitle(projectId: string) {
  const rows = await prisma.issue.findMany({
    where: { projectId },
    select: {
      id: true,
      key: true,
      number: true,
      title: true,
      description: true,
      type: true,
      status: true,
      priority: true,
      severity: true,
      assigneeId: true,
      reporterId: true,
      dueDate: true,
      parentId: true,
      labels: { select: { label: { select: { name: true, color: true } } } },
    },
  });
  return new Map(rows.map((row) => [row.title, row]));
}

/* ------------------------------------------------- project configuration */

describe("the copied project's configuration", () => {
  it("carries every project-scoped setting, and its own identity", async () => {
    const source = await makeSource();
    const clone = await duplicate(source.projectId);

    const [before, after] = await Promise.all([
      prisma.project.findUniqueOrThrow({
        where: { id: source.projectId },
        select: {
          name: true,
          key: true,
          description: true,
          isDefaultProject: true,
          createdById: true,
          labels: { select: { id: true, name: true, color: true } },
          members: { select: { userId: true } },
        },
      }),
      prisma.project.findUniqueOrThrow({
        where: { id: clone.id },
        select: {
          id: true,
          name: true,
          key: true,
          description: true,
          isDefaultProject: true,
          isArchived: true,
          createdById: true,
          createdAt: true,
          labels: { select: { id: true, name: true, color: true } },
          members: { select: { userId: true } },
        },
      }),
    ]);

    // Details and description.
    expect(after.name).toBe(`${before.name} (Copy)`);
    expect(after.description).toBe(before.description);

    // Its own identity: new id, new key, and never the source's.
    expect(after.id).not.toBe(source.projectId);
    expect(after.key).not.toBe(before.key);
    expect(after.isArchived).toBe(false);

    // Membership, plus whoever asked for the copy.
    expect(new Set(after.members.map((m) => m.userId))).toEqual(
      new Set([...before.members.map((m) => m.userId), source.admin.id]),
    );

    /* Labels: the same vocabulary — names and colours, defaults and the one
       this project grew — as its own rows. */
    expect(after.labels.map((l) => l.name).sort()).toEqual(
      before.labels.map((l) => l.name).sort(),
    );
    expect(
      after.labels.find((l) => l.name === "Regression sweep")?.color,
    ).toBe("#AA33CC");
    const sourceLabelIds = new Set(before.labels.map((l) => l.id));
    for (const label of after.labels) {
      expect(sourceLabelIds.has(label.id)).toBe(false);
    }
  });

  it("does not make the copy a default project", async () => {
    const source = await makeSource("Default flag source");

    // Even when the original enrols every new account, the copy must not.
    await prisma.project.update({
      where: { id: source.projectId },
      data: { isDefaultProject: true },
    });

    const clone = await duplicate(source.projectId, {
      copyLinks: false,
      copyAttachments: false,
    });

    const after = await prisma.project.findUniqueOrThrow({
      where: { id: clone.id },
      select: { isDefaultProject: true },
    });
    expect(after.isDefaultProject).toBe(false);

    // And the original keeps the setting it had.
    const before = await prisma.project.findUniqueOrThrow({
      where: { id: source.projectId },
      select: { isDefaultProject: true },
    });
    expect(before.isDefaultProject).toBe(true);
  });

  it("gives the copy its own issue sequence and key space", async () => {
    const source = await makeSource("Sequence source");
    const clone = await duplicate(source.projectId, { copyAttachments: false });

    const after = await prisma.project.findUniqueOrThrow({
      where: { id: clone.id },
      select: { key: true, issueSequence: true, issues: { select: { key: true } } },
    });

    expect(after.issueSequence).toBe(3);
    for (const issue of after.issues) {
      expect(issue.key.startsWith(`${after.key}-`)).toBe(true);
      expect(issue.key.startsWith(`${source.key}-`)).toBe(false);
    }
  });

  it("edits to the copy's configuration leave the original alone", async () => {
    const source = await makeSource("Config independence source");
    const clone = await duplicate(source.projectId, { copyAttachments: false });

    await actAs(ADMIN);
    const renamed = await updateProject({
      projectId: clone.id,
      name: "Renamed copy",
      description: "Rewritten on the copy.",
    });
    expect(renamed.ok).toBe(true);

    // A project-scoped label, edited on the copy.
    const cloneLabel = await prisma.label.findFirstOrThrow({
      where: { projectId: clone.id, name: "Regression sweep" },
      select: { id: true },
    });
    await prisma.label.update({
      where: { id: cloneLabel.id },
      data: { name: "Renamed on the copy", color: "#112233" },
    });

    // Membership, changed on the copy.
    await prisma.projectMember.deleteMany({
      where: { projectId: clone.id, userId: source.member.id },
    });

    const original = await prisma.project.findUniqueOrThrow({
      where: { id: source.projectId },
      select: {
        name: true,
        description: true,
        labels: { select: { name: true, color: true } },
        members: { select: { userId: true } },
      },
    });

    expect(original.name).toBe("Config independence source");
    expect(original.description).toBe("Everything project-scoped should travel.");
    expect(original.labels.map((l) => l.name)).toContain("Regression sweep");
    expect(original.labels.map((l) => l.name)).not.toContain(
      "Renamed on the copy",
    );
    expect(original.members.map((m) => m.userId)).toContain(source.member.id);
  });

  it("keeps statuses, priorities and issue types, which are installation-wide", async () => {
    /* Prio has no per-project workflow, status, priority or issue-type rows —
       they are Prisma enums, shared by every project. There is nothing
       project-scoped to duplicate, so what has to hold is that the copied
       issues still carry the same values, and that the copy answers to the
       same vocabulary a project created from scratch does. */
    const source = await makeSource("Enum source");
    const clone = await duplicate(source.projectId, { copyAttachments: false });

    const before = await issuesByTitle(source.projectId);
    const after = await issuesByTitle(clone.id);

    for (const title of ["Fix login issue", "Child bug", "Related task"]) {
      expect(after.get(title)?.status).toBe(before.get(title)?.status);
      expect(after.get(title)?.priority).toBe(before.get(title)?.priority);
      expect(after.get(title)?.type).toBe(before.get(title)?.type);
      expect(after.get(title)?.severity).toBe(before.get(title)?.severity);
    }
  });
});

/* -------------------------------------------------------- issue contents */

describe("the copied issues", () => {
  it("copy every issue, with new ids and the same field values", async () => {
    const source = await makeSource("Issue field source");
    const clone = await duplicate(source.projectId, { copyAttachments: false });

    expect(clone.copiedIssues).toBe(3);

    const before = await issuesByTitle(source.projectId);
    const after = await issuesByTitle(clone.id);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());

    const originalIds = new Set([...before.values()].map((i) => i.id));
    for (const issue of after.values()) {
      expect(originalIds.has(issue.id)).toBe(false);
    }

    const parentBefore = before.get("Fix login issue")!;
    const parentAfter = after.get("Fix login issue")!;
    expect(parentAfter.description).toBe(parentBefore.description);
    expect(parentAfter.type).toBe("STORY");
    expect(parentAfter.status).toBe("IN_PROGRESS");
    expect(parentAfter.priority).toBe("HIGH");
    expect(parentAfter.assigneeId).toBe(source.admin.id);
    expect(parentAfter.reporterId).toBe(parentBefore.reporterId);
    expect(parentAfter.dueDate?.toISOString()).toBe(
      parentBefore.dueDate?.toISOString(),
    );
    expect(parentAfter.labels.map((l) => l.label.name)).toEqual([
      "Regression sweep",
    ]);

    const childAfter = after.get("Child bug")!;
    expect(childAfter.severity).toBe("MAJOR");
    expect(childAfter.assigneeId).toBe(source.member.id);
  });

  it("edits to a copied issue leave the original untouched", async () => {
    const source = await makeSource("Issue independence source");
    const clone = await duplicate(source.projectId, { copyAttachments: false });

    const copied = (await issuesByTitle(clone.id)).get("Fix login issue")!;

    await actAs(ADMIN);
    const edited = await updateIssue({
      issueId: copied.id,
      title: "Fix payment issue",
      description: "Rewritten on the copy.",
      status: "DONE",
      priority: "LOW",
      assigneeId: source.member.id,
      dueDate: "2027-01-31",
    });
    expect(edited.ok).toBe(true);

    /* Labels are attached at creation in Prio — there is no post-creation
       label action for any issue, copied or not — so the independence that
       matters is tested where it lives: the join row. */
    await prisma.issueLabel.deleteMany({ where: { issueId: copied.id } });

    const original = await prisma.issue.findUniqueOrThrow({
      where: { id: source.parentId },
      select: {
        title: true,
        description: true,
        status: true,
        priority: true,
        assigneeId: true,
        dueDate: true,
        labels: { select: { label: { select: { name: true } } } },
      },
    });

    expect(original.title).toBe("Fix login issue");
    expect(original.description).toBe("The parent story.");
    expect(original.status).toBe("IN_PROGRESS");
    expect(original.priority).toBe("HIGH");
    expect(original.assigneeId).toBe(source.admin.id);
    expect(original.dueDate?.toISOString().slice(0, 10)).toBe("2026-12-24");
    expect(original.labels.map((l) => l.label.name)).toEqual([
      "Regression sweep",
    ]);
  });

  it("lets a copied issue be deleted without touching the original", async () => {
    const source = await makeSource("Issue delete source");
    const clone = await duplicate(source.projectId, { copyAttachments: false });

    const copied = (await issuesByTitle(clone.id)).get("Related task")!;
    await prisma.issue.delete({ where: { id: copied.id } });

    expect(
      await prisma.issue.count({ where: { id: source.relatedId } }),
    ).toBe(1);
    expect(
      await prisma.issue.count({ where: { projectId: source.projectId } }),
    ).toBe(3);
  });
});

/* ------------------------------------------------------- relationships */

describe("relationships in the copy", () => {
  it("re-points parent and related links at the copied issues", async () => {
    const source = await makeSource("Relationship source");
    const clone = await duplicate(source.projectId, { copyAttachments: false });

    const after = await issuesByTitle(clone.id);
    const parent = after.get("Fix login issue")!;
    const child = after.get("Child bug")!;
    const related = after.get("Related task")!;

    // The copied child answers to the copied parent, not the original's.
    expect(child.parentId).toBe(parent.id);
    expect(child.parentId).not.toBe(source.parentId);

    const links = await prisma.issueLink.findMany({
      where: { source: { projectId: clone.id } },
      select: { sourceId: true, targetId: true, type: true },
    });
    expect(links.length).toBeGreaterThan(0);

    const withinClone = new Set([parent.id, child.id, related.id]);
    for (const link of links) {
      expect(withinClone.has(link.sourceId)).toBe(true);
      expect(withinClone.has(link.targetId)).toBe(true);
    }

    // Nothing in the clone reaches back into the source, in either direction.
    expect(
      await prisma.issueLink.count({
        where: {
          source: { projectId: clone.id },
          target: { projectId: source.projectId },
        },
      }),
    ).toBe(0);
    expect(
      await prisma.issueLink.count({
        where: {
          source: { projectId: source.projectId },
          target: { projectId: clone.id },
        },
      }),
    ).toBe(0);
  });

  it("lets a copied issue's relationships be re-edited, in the copy only", async () => {
    const source = await makeSource("Relationship editing source");
    const clone = await duplicate(source.projectId, { copyAttachments: false });

    const after = await issuesByTitle(clone.id);
    const child = after.get("Child bug")!;
    const related = after.get("Related task")!;

    await actAs(ADMIN);

    // Re-parent the copied child onto a different copied issue.
    const reparented = await updateIssue({
      issueId: child.id,
      parentId: related.id,
    });
    expect(reparented.ok).toBe(true);

    // And declare a new relationship between two copied issues.
    const linked = await createIssueLink({
      issueId: child.id,
      targetKey: related.key,
      type: "BLOCKS",
    });
    expect(linked.ok).toBe(true);

    const reread = await prisma.issue.findUniqueOrThrow({
      where: { id: child.id },
      select: { parentId: true },
    });
    expect(reread.parentId).toBe(related.id);

    // Still nothing reaching out of the copy.
    expect(
      await prisma.issueLink.count({
        where: {
          source: { projectId: clone.id },
          target: { projectId: { not: clone.id } },
        },
      }),
    ).toBe(0);

    // The original's own hierarchy is exactly as it was.
    const original = await prisma.issue.findUniqueOrThrow({
      where: { id: source.childId },
      select: { parentId: true },
    });
    expect(original.parentId).toBe(source.parentId);
  });

  it("copies no relationships when the choice is off", async () => {
    const source = await makeSource("No-links source");
    const clone = await duplicate(source.projectId, {
      copyLinks: false,
      copyAttachments: false,
    });

    const after = await issuesByTitle(clone.id);
    expect(after.get("Child bug")?.parentId).toBeNull();
    expect(
      await prisma.issueLink.count({ where: { source: { projectId: clone.id } } }),
    ).toBe(0);

    // And the original's own relationships are still there.
    const original = await prisma.issue.findUniqueOrThrow({
      where: { id: source.childId },
      select: { parentId: true },
    });
    expect(original.parentId).toBe(source.parentId);
  });
});

/* ------------------------------------------------------------- comments */

describe("comments and replies in the copy", () => {
  it("copies the thread, nested, with new ids and its own reactions", async () => {
    const source = await makeSource("Comment source");
    const clone = await duplicate(source.projectId, { copyAttachments: false });

    expect(clone.copiedComments).toBe(2);

    const copiedIssue = (await issuesByTitle(clone.id)).get("Fix login issue")!;
    const comments = await prisma.comment.findMany({
      where: { issueId: copiedIssue.id },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        body: true,
        authorId: true,
        parentId: true,
        reactions: { select: { id: true, userId: true, emoji: true } },
      },
    });

    expect(comments).toHaveLength(2);
    const [root, reply] = comments;

    // New rows, never the originals.
    expect(root!.id).not.toBe(source.rootCommentId);
    expect(reply!.id).not.toBe(source.replyCommentId);

    // Content and authorship survive; the thread survives with them.
    expect(root!.body).toContain("Newly created video");
    expect(root!.parentId).toBeNull();
    expect(reply!.body).toContain("yes");
    expect(reply!.parentId).toBe(root!.id);
    expect(reply!.parentId).not.toBe(source.rootCommentId);
    expect(reply!.authorId).toBe(source.member.id);

    // The reaction is the copy's own row.
    expect(root!.reactions).toHaveLength(1);
    expect(root!.reactions[0]!.emoji).toBe("\u{1F44D}");
    const originalReaction = await prisma.commentReaction.findFirstOrThrow({
      where: { commentId: source.rootCommentId },
      select: { id: true },
    });
    expect(root!.reactions[0]!.id).not.toBe(originalReaction.id);
  });

  it("keeps new comments, replies and reactions on the copy only", async () => {
    const source = await makeSource("Comment independence source");
    const clone = await duplicate(source.projectId, { copyAttachments: false });

    const copiedIssue = (await issuesByTitle(clone.id)).get("Fix login issue")!;
    const copiedRoot = await prisma.comment.findFirstOrThrow({
      where: { issueId: copiedIssue.id, parentId: null },
      select: { id: true },
    });

    await actAs(ADMIN);

    // A brand-new reply to a *copied* comment.
    const added = await createComment({
      issueId: copiedIssue.id,
      body: "Answering the copy.",
      parentId: copiedRoot.id,
    });
    expect(added.ok).toBe(true);

    // An edit and a reaction on copied rows.
    const copiedReply = await prisma.comment.findFirstOrThrow({
      where: { issueId: copiedIssue.id, parentId: copiedRoot.id, body: { contains: "yes" } },
      select: { id: true, authorId: true },
    });
    await actAs(MEMBER);
    const editedReply = await updateComment({
      commentId: copiedReply.id,
      body: "changed on the copy",
    });
    expect(editedReply.ok).toBe(true);
    await toggleCommentReaction({ commentId: copiedRoot.id, emoji: "\u{1F389}" });

    // The original thread is exactly as it was.
    const originalThread = await prisma.comment.findMany({
      where: { issueId: source.parentId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        body: true,
        parentId: true,
        editedAt: true,
        reactions: { select: { emoji: true } },
      },
    });

    expect(originalThread).toHaveLength(2);
    expect(originalThread[0]!.id).toBe(source.rootCommentId);
    expect(originalThread[1]!.body).toContain("yes");
    expect(originalThread[1]!.body).not.toContain("changed on the copy");
    expect(originalThread[1]!.editedAt).toBeNull();
    expect(originalThread[0]!.reactions.map((r) => r.emoji).sort()).toEqual([
      "\u{1F44D}",
    ]);

    // And the copy holds all three of its own: root, copied reply, new reply.
    expect(
      await prisma.comment.count({ where: { issueId: copiedIssue.id } }),
    ).toBe(3);
  });

  it("deleting a copied comment leaves the original thread whole", async () => {
    const source = await makeSource("Comment delete source");
    const clone = await duplicate(source.projectId, { copyAttachments: false });

    const copiedIssue = (await issuesByTitle(clone.id)).get("Fix login issue")!;
    const copiedRoot = await prisma.comment.findFirstOrThrow({
      where: { issueId: copiedIssue.id, parentId: null },
      select: { id: true },
    });

    await actAs(ADMIN);
    const removed = await deleteComment(copiedRoot.id);
    expect(removed.ok).toBe(true);

    // The copy's thread cascaded away; the original's is untouched.
    expect(
      await prisma.comment.count({ where: { issueId: copiedIssue.id } }),
    ).toBe(0);
    expect(
      await prisma.comment.count({ where: { issueId: source.parentId } }),
    ).toBe(2);
    expect(
      await prisma.comment.count({ where: { id: source.rootCommentId } }),
    ).toBe(1);
  });
});

/* ---------------------------------------------------------- attachments */

describe("attachments in the copy", () => {
  it("copies project, issue and comment files as new rows and new objects", async () => {
    const source = await makeSource("Attachment source");
    const clone = await duplicate(source.projectId);

    expect(clone.copiedAttachments).toBe(3);

    const copiedIssue = (await issuesByTitle(clone.id)).get("Fix login issue")!;
    const copiedRoot = await prisma.comment.findFirstOrThrow({
      where: { issueId: copiedIssue.id, parentId: null },
      select: { id: true },
    });

    const [projectFile, issueFile, commentFile] = await Promise.all([
      prisma.attachment.findFirstOrThrow({
        where: { projectId: clone.id },
        select: { id: true, filename: true, storageKey: true, byteSize: true },
      }),
      prisma.attachment.findFirstOrThrow({
        where: { issueId: copiedIssue.id, commentId: null },
        select: { id: true, filename: true, storageKey: true },
      }),
      prisma.attachment.findFirstOrThrow({
        where: { commentId: copiedRoot.id },
        select: { id: true, filename: true, storageKey: true },
      }),
    ]);

    expect(projectFile.filename).toBe("charter.txt");
    expect(issueFile.filename).toBe("spec.txt");
    expect(commentFile.filename).toBe("evidence.txt");

    // New rows.
    expect([projectFile.id, issueFile.id, commentFile.id]).not.toContain(
      source.projectFile,
    );
    expect([projectFile.id, issueFile.id, commentFile.id]).not.toContain(
      source.issueFile,
    );
    expect([projectFile.id, issueFile.id, commentFile.id]).not.toContain(
      source.commentFile,
    );

    // New storage objects, holding the same bytes — not shared keys.
    const originals = await prisma.attachment.findMany({
      where: {
        id: { in: [source.projectFile, source.issueFile, source.commentFile] },
      },
      select: { storageKey: true },
    });
    const originalKeys = new Set(originals.map((a) => a.storageKey));
    for (const key of [
      projectFile.storageKey,
      issueFile.storageKey,
      commentFile.storageKey,
    ]) {
      expect(originalKeys.has(key)).toBe(false);
    }

    expect(await readStored(projectFile.storageKey)).toBe("project bytes");
    expect(await readStored(issueFile.storageKey)).toBe("issue bytes");
    expect(await readStored(commentFile.storageKey)).toBe("comment bytes");
  });

  it("copies no files at all when the choice is off", async () => {
    const source = await makeSource("No-files source");
    const clone = await duplicate(source.projectId, { copyAttachments: false });

    expect(clone.copiedAttachments).toBe(0);
    expect(
      await prisma.attachment.count({
        where: {
          OR: [{ projectId: clone.id }, { issue: { projectId: clone.id } }],
        },
      }),
    ).toBe(0);

    // The original still has all three.
    expect(
      await prisma.attachment.count({
        where: {
          OR: [
            { projectId: source.projectId },
            { issue: { projectId: source.projectId } },
          ],
        },
      }),
    ).toBe(3);
  });

  it("deleting a copied file leaves the original's bytes readable", async () => {
    const source = await makeSource("File delete source");
    const clone = await duplicate(source.projectId);

    const copiedIssue = (await issuesByTitle(clone.id)).get("Fix login issue")!;
    const copy = await prisma.attachment.findFirstOrThrow({
      where: { issueId: copiedIssue.id, commentId: null },
      select: { id: true, storageKey: true },
    });

    await prisma.attachment.delete({ where: { id: copy.id } });
    await storage().remove(copy.storageKey);

    const original = await prisma.attachment.findUniqueOrThrow({
      where: { id: source.issueFile },
      select: { storageKey: true },
    });
    expect(await readStored(original.storageKey)).toBe("issue bytes");
  });

  it("accepts a new attachment on a copied issue", async () => {
    const source = await makeSource("New file source");
    const clone = await duplicate(source.projectId);

    const copiedIssue = (await issuesByTitle(clone.id)).get("Fix login issue")!;
    const added = await attach(
      { issueId: copiedIssue.id },
      source.admin.id,
      "added.txt",
      "added on the copy",
    );

    const row = await prisma.attachment.findUniqueOrThrow({
      where: { id: added },
      select: { issueId: true, storageKey: true },
    });
    expect(row.issueId).toBe(copiedIssue.id);
    expect(await readStored(row.storageKey)).toBe("added on the copy");

    // The original issue still has exactly the two files it had.
    expect(
      await prisma.attachment.count({ where: { issueId: source.parentId } }),
    ).toBe(2);
  });
});

/* ------------------------------------------------------- repeated clones */

describe("cloning the same project more than once", () => {
  it("produces copies that are independent of the original and of each other", async () => {
    const source = await makeSource("Repeat source");

    const a = await duplicate(source.projectId, { copyAttachments: false });
    const b = await duplicate(source.projectId, { copyAttachments: false });
    const c = await duplicate(source.projectId, { copyAttachments: false });

    const ids = [source.projectId, a.id, b.id, c.id];
    expect(new Set(ids).size).toBe(4);

    const keys = await prisma.project.findMany({
      where: { id: { in: ids } },
      select: { key: true },
    });
    expect(new Set(keys.map((k) => k.key)).size).toBe(4);

    // Every issue in every copy is its own row.
    const allIssues = await prisma.issue.findMany({
      where: { projectId: { in: ids } },
      select: { id: true, projectId: true },
    });
    expect(allIssues).toHaveLength(12);
    expect(new Set(allIssues.map((i) => i.id)).size).toBe(12);

    // Each copy's relationships stay inside that copy.
    for (const projectId of [a.id, b.id, c.id]) {
      const outward = await prisma.issue.count({
        where: { projectId, parent: { projectId: { not: projectId } } },
      });
      expect(outward).toBe(0);
    }

    // Editing A moves nothing in B, C or the original.
    const aParent = (await issuesByTitle(a.id)).get("Fix login issue")!;
    await actAs(ADMIN);
    const edited = await updateIssue({
      issueId: aParent.id,
      title: "Only in copy A",
      priority: "URGENT",
    });
    expect(edited.ok).toBe(true);

    for (const projectId of [source.projectId, b.id, c.id]) {
      const titles = await issuesByTitle(projectId);
      expect(titles.has("Fix login issue")).toBe(true);
      expect(titles.has("Only in copy A")).toBe(false);
      expect(titles.get("Fix login issue")!.priority).toBe("HIGH");
    }

    // Deleting a comment in B removes nothing from C or the original.
    const bIssue = (await issuesByTitle(b.id)).get("Fix login issue")!;
    await prisma.comment.deleteMany({ where: { issueId: bIssue.id } });

    const cIssue = (await issuesByTitle(c.id)).get("Fix login issue")!;
    expect(
      await prisma.comment.count({ where: { issueId: cIssue.id } }),
    ).toBe(2);
    expect(
      await prisma.comment.count({ where: { issueId: source.parentId } }),
    ).toBe(2);
  });
});

/* ----------------------------------------------------------- atomicity */

/* ---------------------------------------------------------------- scale */

describe("cloning a large project", () => {
  /*
   * The shape this has to survive in production is hundreds of issues, not
   * three. Rows are written directly here rather than through `createIssue` —
   * the fixture is about volume, and going through the action would spend the
   * test's time on notifications instead of on the thing being measured.
   */
  it("copies 719 issues, their threads, relationships and 315 files", async () => {
    const admin = await actAs(ADMIN);
    const created = await createProject({
      name: "Large source",
      key: nextKey(),
      description: "Several hundred issues.",
      memberIds: [],
    });
    if (!created.ok) throw new Error(created.error);
    createdProjects.push(created.data.id);
    const projectId = created.data.id;

    /* The shape named in the requirement, used literally rather than scaled
       down, so the numbers in the report are measured ones. */
    const COUNT = 719;
    const PARENTS = 10;
    const FILES = 315;

    await prisma.issue.createMany({
      data: Array.from({ length: COUNT }, (_, index) => ({
        projectId,
        number: index + 1,
        key: `${created.data.key}-${index + 1}`,
        type: "TASK" as const,
        title: `Bulk issue ${index + 1}`,
        status: "TODO" as const,
        priority: "MEDIUM" as const,
        reporterId: admin.id,
      })),
    });
    await prisma.project.update({
      where: { id: projectId },
      data: { issueSequence: COUNT },
    });

    const rows = await prisma.issue.findMany({
      where: { projectId },
      orderBy: { number: "asc" },
      select: { id: true },
    });

    /* A realistic hierarchy: a few parents with many children each, which is
       also the shape that decides how many statements the re-pointing pass
       costs. */
    const parents = rows.slice(0, PARENTS);
    for (const [index, parent] of parents.entries()) {
      const children = rows
        .slice(PARENTS + index * 20, PARENTS + index * 20 + 20)
        .map((row) => row.id);
      if (children.length === 0) continue;
      await prisma.issue.updateMany({
        where: { id: { in: children } },
        data: { parentId: parent.id },
      });
    }

    // A hundred related-issue links, and a hundred comments with replies.
    await prisma.issueLink.createMany({
      data: Array.from({ length: 100 }, (_, index) => ({
        sourceId: rows[index]!.id,
        targetId: rows[index + 100]!.id,
        type: "RELATES_TO" as const,
        createdById: admin.id,
      })),
      skipDuplicates: true,
    });

    const commentBase = Date.now() - 1_000_000;
    await prisma.comment.createMany({
      data: Array.from({ length: 100 }, (_, index) => ({
        issueId: rows[index]!.id,
        authorId: admin.id,
        body: `Bulk comment ${index + 1}`,
        createdAt: new Date(commentBase + index),
      })),
    });
    const roots = await prisma.comment.findMany({
      where: { issue: { projectId } },
      orderBy: { createdAt: "asc" },
      select: { id: true, issueId: true },
    });
    await prisma.comment.createMany({
      data: roots.map((root, index) => ({
        issueId: root.issueId,
        authorId: admin.id,
        body: `Bulk reply ${index + 1}`,
        parentId: root.id,
        createdAt: new Date(commentBase + 500_000 + index),
      })),
    });

    /* Files across all three levels: on the project, on issues, and on the
       copied comments — the last being the ones that need the comment map to
       land anywhere at all. */
    let commentFiles = 0;
    for (let index = 0; index < FILES; index += 1) {
      if (index === 0) {
        await attach({ projectId }, admin.id, "charter.txt", "project bytes");
      } else if (index % 5 === 0) {
        const root = roots[index % roots.length]!;
        await attach(
          { issueId: root.issueId, commentId: root.id },
          admin.id,
          `note-${index}.txt`,
          `comment bytes ${index}`,
        );
        commentFiles += 1;
      } else {
        await attach(
          { issueId: rows[index]!.id },
          admin.id,
          `file-${index}.txt`,
          `issue bytes ${index}`,
        );
      }
    }

    const startedAt = Date.now();
    const clone = await duplicate(projectId);
    const elapsed = Date.now() - startedAt;

    expect(clone.copiedIssues).toBe(COUNT);
    expect(clone.copiedComments).toBe(200);
    // 200 re-pointed children plus 100 relationships.
    expect(clone.copiedLinks).toBe(300);
    expect(clone.copiedAttachments).toBe(FILES);

    /* Not a benchmark — a guard that the bulk path is bulk, and that the
       transaction finishes well inside its own timeout. Measured on this
       fixture: the transactional half — 719 issues, 200 comments, 300
       relationships — takes about 1.5s, and the remaining time is the 315
       file copies, which run *outside* the transaction one object at a time
       and are bounded by disk rather than by a lock. A per-row implementation
       of the structural half takes minutes and would time out. */
    expect(elapsed).toBeLessThan(120_000);

    // Integrity, not just counts.
    expect(await prisma.issue.count({ where: { projectId: clone.id } })).toBe(
      COUNT,
    );
    expect(
      await prisma.comment.count({ where: { issue: { projectId: clone.id } } }),
    ).toBe(200);

    // No parent, link or reply escapes into the original project.
    expect(
      await prisma.issue.count({
        where: { projectId: clone.id, parent: { projectId: { not: clone.id } } },
      }),
    ).toBe(0);
    expect(
      await prisma.issueLink.count({
        where: {
          source: { projectId: clone.id },
          target: { projectId: { not: clone.id } },
        },
      }),
    ).toBe(0);
    expect(
      await prisma.comment.count({
        where: {
          issue: { projectId: clone.id },
          parent: { issue: { projectId: { not: clone.id } } },
        },
      }),
    ).toBe(0);

    // Every reply still sits under a parent, and every root still has none.
    expect(
      await prisma.comment.count({
        where: { issue: { projectId: clone.id }, parentId: { not: null } },
      }),
    ).toBe(100);

    /* Every file landed, on the right owner, and none of them shares a
       storage object with the original. */
    expect(
      await prisma.attachment.count({
        where: {
          OR: [{ projectId: clone.id }, { issue: { projectId: clone.id } }],
        },
      }),
    ).toBe(FILES);
    expect(commentFiles).toBeGreaterThan(0);
    expect(
      await prisma.attachment.count({
        where: { issue: { projectId: clone.id }, commentId: { not: null } },
      }),
    ).toBe(commentFiles);

    const sourceKeys = new Set(
      (
        await prisma.attachment.findMany({
          where: {
            OR: [{ projectId }, { issue: { projectId } }],
          },
          select: { storageKey: true },
        })
      ).map((a) => a.storageKey),
    );
    const cloneKeys = await prisma.attachment.findMany({
      where: {
        OR: [{ projectId: clone.id }, { issue: { projectId: clone.id } }],
      },
      select: { storageKey: true },
    });
    for (const row of cloneKeys) {
      expect(sourceKeys.has(row.storageKey)).toBe(false);
    }

    // And each copied reply answers the copy of the comment it answered.
    const cloneRoot = await prisma.comment.findFirstOrThrow({
      where: { issue: { projectId: clone.id }, body: "Bulk comment 1" },
      select: { id: true, issueId: true },
    });
    const cloneReply = await prisma.comment.findFirstOrThrow({
      where: { issue: { projectId: clone.id }, body: "Bulk reply 1" },
      select: { parentId: true, issueId: true },
    });
    expect(cloneReply.parentId).toBe(cloneRoot.id);
    expect(cloneReply.issueId).toBe(cloneRoot.issueId);
  }, 600_000);
});

describe("a duplication that fails", () => {
  it("leaves no project behind and does not touch the original", async () => {
    /*
     * A real failure, not a mocked one: the clone's issue keys are derived
     * from its project key, so an issue elsewhere already holding one of them
     * makes the bulk insert violate `Issue.key`'s unique constraint — after
     * the copy's project row, members and labels have been written. That is
     * precisely the moment a non-transactional copy would leave a half-built
     * project sitting in the sidebar.
     */
    const stamp = Math.random().toString(36).slice(2, 7).toUpperCase();
    const name = `ZQ${stamp}`;
    const source = await makeSource(name);

    // The same derivation `deriveCopyKey` uses for its first candidate.
    const letters = name.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    const derivedKey = (letters.slice(0, 6) + "COPY").slice(0, 10);

    // Somewhere else entirely, an issue already holding the clone's first key.
    const blocker = await createProject({
      name: `Blocker ${stamp}`,
      key: nextKey(),
      description: null,
      memberIds: [],
    });
    if (!blocker.ok) throw new Error(blocker.error);
    createdProjects.push(blocker.data.id);
    await prisma.issue.create({
      data: {
        projectId: blocker.data.id,
        number: 9001,
        key: `${derivedKey}-1`,
        type: "TASK",
        title: "Squatting on the clone's first key",
        reporterId: source.admin.id,
      },
    });

    const before = {
      projects: await prisma.project.count(),
      issues: await prisma.issue.count({ where: { projectId: source.projectId } }),
      comments: await prisma.comment.count({
        where: { issue: { projectId: source.projectId } },
      }),
      name: name,
    };

    await actAs(ADMIN);
    const result = await duplicateProject({
      projectId: source.projectId,
      copyLinks: true,
      copyAttachments: true,
    });

    // Reported as a failure, not as a copy.
    expect(result.ok).toBe(false);

    /* Nothing left behind: no project row, no members, no labels — the whole
       transaction rolled back rather than stopping where it broke. */
    expect(await prisma.project.count()).toBe(before.projects);
    expect(
      await prisma.project.count({ where: { name: `${before.name} (Copy)` } }),
    ).toBe(0);

    // And the original is exactly as it was.
    expect(
      await prisma.issue.count({ where: { projectId: source.projectId } }),
    ).toBe(before.issues);
    expect(
      await prisma.comment.count({
        where: { issue: { projectId: source.projectId } },
      }),
    ).toBe(before.comments);
    const original = await prisma.project.findUniqueOrThrow({
      where: { id: source.projectId },
      select: { name: true, description: true },
    });
    expect(original.name).toBe(name);
    expect(original.description).toBe("Everything project-scoped should travel.");
  });
});
