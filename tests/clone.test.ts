import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  cloneIssue,
  createIssue,
  issueCloneDraft,
  updateIssue,
} from "@/server/issues";
import { createIssueLink } from "@/server/links";
import {
  createLabel,
  createProject,
  duplicateProject,
} from "@/server/projects";
import {
  LocalStorageProvider,
  setStorageProvider,
  storage,
} from "@/server/storage";
import { actAs, joinTestingTeam, projectByKey } from "./helpers";

/**
 * Cloning issues and projects.
 *
 * Two properties are worth more than the rest here, and most of what follows
 * exists to pin them:
 *
 *   1. **A clone has no ticket ID until it is saved.** Nothing is written when
 *      the dialog opens or while the draft is edited, so the project's issue
 *      sequence must not move and no row must appear. Cancelling is therefore
 *      free by construction rather than by cleanup.
 *   2. **A clone is independent.** The two copy choices decide what travels;
 *      whatever does travel is a *copy*, never a shared row and never a shared
 *      file. Editing or deleting a clone can never reach the original.
 */

const ADMIN = "admin@symbiosystech.com";
/**
 * A member of Engineering. Everyone seeded except the administrator belongs to
 * Engineering, so "an outsider" has to be expressed the other way round:
 * Testing is the project only the administrator is in, and `MEMBER` is
 * therefore outside *it*.
 */
const MEMBER = "priya.nair@symbiosystech.com";

const createdIssues: string[] = [];
const createdProjects: string[] = [];
const scratch: string[] = [];

beforeAll(async () => {
  /* Storage is pointed at a temporary directory, so the byte-for-byte copy can
     be proved by reading the files back without touching real uploads. */
  const dir = await mkdtemp(path.join(tmpdir(), "prio-clone-"));
  scratch.push(dir);
  setStorageProvider(new LocalStorageProvider(dir));
});

afterAll(async () => {
  setStorageProvider(null);
  if (createdIssues.length > 0) {
    await prisma.issue.deleteMany({ where: { id: { in: createdIssues } } });
  }
  if (createdProjects.length > 0) {
    await prisma.project.deleteMany({ where: { id: { in: createdProjects } } });
  }
  await Promise.all(
    scratch.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  await prisma.$disconnect();
});

/** A fresh issue in ENG, created through the ordinary action. */
async function makeIssue(
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; key: string }> {
  const project = await projectByKey("ENG");
  const result = await createIssue({
    projectId: project.id,
    type: "TASK",
    title: `Clone fixture ${Date.now()}${Math.random().toString(36).slice(2, 7)}`,
    ...overrides,
  });
  if (!result.ok) throw new Error(`fixture failed: ${result.error}`);
  createdIssues.push(result.data.id);
  return { id: result.data.id, key: result.data.key };
}

/** Stores `text` and records it as an attachment on `issueId`. */
async function attach(
  issueId: string,
  uploaderId: string,
  filename: string,
  text: string,
  mimeType = "text/plain",
): Promise<string> {
  const stored = await storage().put(
    Readable.toWeb(
      Readable.from([Buffer.from(text)]),
    ) as ReadableStream<Uint8Array>,
    { extension: path.extname(filename) },
  );

  const row = await prisma.attachment.create({
    data: {
      issueId,
      uploadedById: uploaderId,
      filename,
      storageKey: stored.key,
      mimeType,
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

/* ------------------------------------------------------------- the draft */

describe("opening a clone", () => {
  it("hands back the source's content without reserving a ticket ID", async () => {
    await actAs(ADMIN);
    const source = await makeIssue({
      description: "The original description.",
      priority: "HIGH",
    });

    const before = await projectByKey("ENG");
    const countBefore = await prisma.issue.count({
      where: { projectId: before.id },
    });

    const draft = await issueCloneDraft(source.id);
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;

    expect(draft.data.title.startsWith("Clone of ")).toBe(true);
    expect(draft.data.description).toBe("The original description.");
    expect(draft.data.priority).toBe("HIGH");

    /*
     * The whole of §8 in two assertions: opening the draft moved neither the
     * key counter nor the row count, so there is no ticket ID in existence for
     * this clone and nothing to clean up if the person walks away.
     */
    const after = await projectByKey("ENG");
    expect(after.issueSequence).toBe(before.issueSequence);
    expect(
      await prisma.issue.count({ where: { projectId: before.id } }),
    ).toBe(countBefore);
  });
});

/* -------------------------------------------------------- the four cases */

describe("cloning an issue", () => {
  it("with links off and attachments off, copies content and nothing else", async () => {
    const admin = await actAs(ADMIN);
    const parent = await makeIssue();
    const other = await makeIssue();
    const source = await makeIssue({
      type: "STORY",
      description: "Carried across.",
      priority: "URGENT",
      parentId: parent.id,
    });
    await attach(source.id, admin.id, "evidence.txt", "original bytes");
    const linked = await createIssueLink({
      issueId: source.id,
      targetKey: other.key,
      type: "RELATES_TO",
    });
    expect(linked.ok).toBe(true);

    const project = await projectByKey("ENG");
    const result = await cloneIssue({
      sourceIssueId: source.id,
      projectId: project.id,
      type: "STORY",
      title: "Clone with nothing carried",
      description: "Carried across.",
      priority: "URGENT",
      copyLinks: false,
      copyAttachments: false,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdIssues.push(result.data.id);

    expect(result.data.key).not.toBe(source.key);
    expect(result.data.copiedLinks).toBe(0);
    expect(result.data.copiedAttachments).toBe(0);

    const clone = await prisma.issue.findUniqueOrThrow({
      where: { id: result.data.id },
      select: {
        title: true,
        description: true,
        type: true,
        priority: true,
        parentId: true,
        _count: { select: { linksFrom: true, attachments: true } },
      },
    });

    expect(clone.description).toBe("Carried across.");
    expect(clone.type).toBe("STORY");
    expect(clone.priority).toBe("URGENT");
    expect(clone.parentId).toBeNull();
    expect(clone._count.linksFrom).toBe(0);
    expect(clone._count.attachments).toBe(0);
  });

  it("with links on, copies the relationships and the parent", async () => {
    await actAs(ADMIN);
    const parent = await makeIssue();
    const other = await makeIssue();
    const source = await makeIssue({ parentId: parent.id });
    await createIssueLink({
      issueId: source.id,
      targetKey: other.key,
      type: "BLOCKS",
    });

    const project = await projectByKey("ENG");
    const result = await cloneIssue({
      sourceIssueId: source.id,
      projectId: project.id,
      type: "TASK",
      title: "Clone with links",
      copyLinks: true,
      copyAttachments: false,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdIssues.push(result.data.id);
    expect(result.data.copiedLinks).toBe(1);

    const clone = await prisma.issue.findUniqueOrThrow({
      where: { id: result.data.id },
      select: {
        parentId: true,
        linksFrom: { select: { type: true, targetId: true } },
      },
    });
    expect(clone.parentId).toBe(parent.id);
    expect(clone.linksFrom).toHaveLength(1);
    expect(clone.linksFrom[0]?.type).toBe("BLOCKS");
    expect(clone.linksFrom[0]?.targetId).toBe(other.id);

    // A link is a matched pair, so the other end must see it too.
    const inverse = await prisma.issueLink.findFirst({
      where: {
        sourceId: other.id,
        targetId: result.data.id,
        type: "IS_BLOCKED_BY",
      },
    });
    expect(inverse).not.toBeNull();

    // And the original still has exactly its own one link, not two.
    expect(
      await prisma.issueLink.count({ where: { sourceId: source.id } }),
    ).toBe(1);
  });

  it("with attachments on, copies the bytes rather than the row", async () => {
    const admin = await actAs(ADMIN);
    const source = await makeIssue();
    await attach(source.id, admin.id, "screenshot.txt", "pretend png bytes");
    await attach(source.id, admin.id, "capture.txt", "pretend video bytes");

    const project = await projectByKey("ENG");
    const result = await cloneIssue({
      sourceIssueId: source.id,
      projectId: project.id,
      type: "BUG",
      title: "Clone with files",
      copyLinks: false,
      copyAttachments: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdIssues.push(result.data.id);
    expect(result.data.copiedAttachments).toBe(2);

    const originals = await prisma.attachment.findMany({
      where: { issueId: source.id },
      orderBy: { createdAt: "asc" },
      select: { storageKey: true, filename: true },
    });
    const copies = await prisma.attachment.findMany({
      where: { issueId: result.data.id },
      orderBy: { createdAt: "asc" },
      select: { storageKey: true, filename: true, mimeType: true },
    });

    expect(copies).toHaveLength(2);
    expect(copies.map((c) => c.filename)).toEqual(
      originals.map((o) => o.filename),
    );

    /*
     * The property that matters: separate objects holding identical bytes. A
     * shared `storageKey` would mean deleting either issue destroyed the
     * other's file — which is exactly what §12 forbids.
     */
    for (const [index, copy] of copies.entries()) {
      const original = originals[index]!;
      expect(copy.storageKey).not.toBe(original.storageKey);
      expect(await readStored(copy.storageKey)).toBe(
        await readStored(original.storageKey),
      );
    }

    // Deleting the clone leaves the original's files where they were.
    await prisma.issue.delete({ where: { id: result.data.id } });
    for (const original of originals) {
      expect(await storage().size(original.storageKey)).not.toBeNull();
    }
    expect(
      await prisma.attachment.count({ where: { issueId: source.id } }),
    ).toBe(2);
  });

  it("with both on, carries links and files together", async () => {
    const admin = await actAs(ADMIN);
    const other = await makeIssue();
    const source = await makeIssue();
    await createIssueLink({
      issueId: source.id,
      targetKey: other.key,
      type: "RELATES_TO",
    });
    await attach(source.id, admin.id, "both.txt", "both bytes");

    const project = await projectByKey("ENG");
    const result = await cloneIssue({
      sourceIssueId: source.id,
      projectId: project.id,
      type: "BUG",
      title: "Clone with everything",
      copyLinks: true,
      copyAttachments: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdIssues.push(result.data.id);
    expect(result.data.copiedLinks).toBe(1);
    expect(result.data.copiedAttachments).toBe(1);
  });

  it("carries every supported attachment type, whatever it is", async () => {
    /*
     * The copy is type-agnostic by construction — it re-streams bytes and
     * carries the stored `mimeType` across — so this pins that there is no
     * per-type branch waiting to drop a video or a ZIP.
     */
    const admin = await actAs(ADMIN);
    const source = await makeIssue();

    const files: [string, string, string][] = [
      ["screenshot.png", "image/png", "PNG-ish bytes"],
      ["recording.mp4", "video/mp4", "MP4-ish bytes"],
      ["logs.zip", "application/zip", "ZIP-ish bytes"],
      ["report.pdf", "application/pdf", "PDF-ish bytes"],
    ];
    for (const [filename, mime, body] of files) {
      await attach(source.id, admin.id, filename, body, mime);
    }

    const project = await projectByKey("ENG");
    const result = await cloneIssue({
      sourceIssueId: source.id,
      projectId: project.id,
      type: "BUG",
      title: "Clone with every kind of file",
      copyLinks: false,
      copyAttachments: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdIssues.push(result.data.id);
    expect(result.data.copiedAttachments).toBe(4);

    const copies = await prisma.attachment.findMany({
      where: { issueId: result.data.id },
      orderBy: { createdAt: "asc" },
      select: { filename: true, mimeType: true, storageKey: true, byteSize: true },
    });

    expect(copies.map((c) => [c.filename, c.mimeType])).toEqual(
      files.map(([filename, mime]) => [filename, mime]),
    );
    for (const [index, copy] of copies.entries()) {
      expect(await readStored(copy.storageKey)).toBe(files[index]![2]);
      expect(copy.byteSize).toBe(Buffer.byteLength(files[index]![2]));
    }
  });

  it("leaves the original alone, before and after the clone is edited", async () => {
    await actAs(ADMIN);
    const source = await makeIssue({
      description: "Untouched.",
      priority: "LOW",
    });

    const snapshot = await prisma.issue.findUniqueOrThrow({
      where: { id: source.id },
      select: {
        key: true,
        title: true,
        description: true,
        type: true,
        status: true,
        priority: true,
        assigneeId: true,
        updatedAt: true,
      },
    });

    const project = await projectByKey("ENG");
    const result = await cloneIssue({
      sourceIssueId: source.id,
      projectId: project.id,
      type: "TASK",
      title: "A clone that gets edited",
      description: "Untouched.",
      priority: "LOW",
      copyLinks: false,
      copyAttachments: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdIssues.push(result.data.id);

    const edited = await updateIssue({
      issueId: result.data.id,
      title: "Edited only on the clone",
      description: "Changed here, nowhere else.",
      priority: "URGENT",
    });
    expect(edited.ok).toBe(true);

    const after = await prisma.issue.findUniqueOrThrow({
      where: { id: source.id },
      select: {
        key: true,
        title: true,
        description: true,
        type: true,
        status: true,
        priority: true,
        assigneeId: true,
        updatedAt: true,
      },
    });
    expect(after).toEqual(snapshot);
  });

  it("gives every clone its own unique key", async () => {
    await actAs(ADMIN);
    const source = await makeIssue();
    const project = await projectByKey("ENG");

    const keys: string[] = [];
    for (let n = 0; n < 3; n += 1) {
      const result = await cloneIssue({
        sourceIssueId: source.id,
        projectId: project.id,
        type: "TASK",
        title: `Repeated clone ${n}`,
        copyLinks: false,
        copyAttachments: false,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      createdIssues.push(result.data.id);
      keys.push(result.data.key);
    }

    expect(new Set(keys).size).toBe(3);
    expect(keys).not.toContain(source.key);
  });
});

/* ------------------------------------------------------------- parenthood */

describe("the parent of an issue", () => {
  it("refuses an issue as its own parent", async () => {
    await actAs(ADMIN);
    const issue = await makeIssue();

    const result = await updateIssue({
      issueId: issue.id,
      parentId: issue.id,
    });

    expect(result.ok).toBe(false);
    const stored = await prisma.issue.findUniqueOrThrow({
      where: { id: issue.id },
      select: { parentId: true },
    });
    expect(stored.parentId).toBeNull();
  });

  it("refuses a parent from another project", async () => {
    await actAs(ADMIN);
    const issue = await makeIssue();
    const foreign = await prisma.issue.findFirstOrThrow({
      where: { project: { key: "INT" }, parentId: null },
      select: { id: true },
    });

    const result = await updateIssue({
      issueId: issue.id,
      parentId: foreign.id,
    });

    expect(result.ok).toBe(false);
    const stored = await prisma.issue.findUniqueOrThrow({
      where: { id: issue.id },
      select: { parentId: true },
    });
    expect(stored.parentId).toBeNull();
  });

  it("refuses a second level of nesting, from either end", async () => {
    await actAs(ADMIN);
    const grandparent = await makeIssue();
    const parent = await makeIssue({ parentId: grandparent.id });
    const child = await makeIssue();

    // The parent is already a sub-issue, so it cannot take one.
    const downward = await updateIssue({
      issueId: child.id,
      parentId: parent.id,
    });
    expect(downward.ok).toBe(false);

    // And an issue that already has children cannot become one.
    const upward = await updateIssue({
      issueId: grandparent.id,
      parentId: child.id,
    });
    expect(upward.ok).toBe(false);

    const stored = await prisma.issue.findUniqueOrThrow({
      where: { id: grandparent.id },
      select: { parentId: true },
    });
    expect(stored.parentId).toBeNull();
  });

  it("accepts, persists and clears a legitimate parent", async () => {
    await actAs(ADMIN);
    const parent = await makeIssue();
    const child = await makeIssue();

    expect((await updateIssue({ issueId: child.id, parentId: parent.id })).ok).toBe(
      true,
    );
    expect(
      (
        await prisma.issue.findUniqueOrThrow({
          where: { id: child.id },
          select: { parentId: true },
        })
      ).parentId,
    ).toBe(parent.id);

    // The parent knows about the child, and the project link is separate.
    const readBack = await prisma.issue.findUniqueOrThrow({
      where: { id: parent.id },
      select: {
        projectId: true,
        children: { select: { id: true } },
      },
    });
    expect(readBack.children.map((c) => c.id)).toContain(child.id);
    expect(readBack.projectId).toBe(
      (await projectByKey("ENG")).id,
    );

    expect((await updateIssue({ issueId: child.id, parentId: "" })).ok).toBe(true);
    expect(
      (
        await prisma.issue.findUniqueOrThrow({
          where: { id: child.id },
          select: { parentId: true },
        })
      ).parentId,
    ).toBeNull();
  });
});

/* ------------------------------------------------------------ permissions */

describe("who may clone", () => {
  it("lets a tester clone an issue, and refuses a developer", async () => {
    /*
     * Cloning creates an issue, so it is governed by whoever may create one:
     * an administrator or a tester. It is that same permission reached through
     * a different door — no wider — and it is re-checked on the server rather
     * than assumed from the button being visible.
     *
     * Both halves are asserted together because the pair is the rule: the door
     * being open to a tester is only meaningful if it is shut to a developer.
     */
    await actAs(ADMIN);
    const source = await makeIssue({ description: "Member clones this." });
    const project = await projectByKey("ENG");

    const draft = {
      sourceIssueId: source.id,
      projectId: project.id,
      type: "TASK" as const,
      description: "Member clones this.",
      copyLinks: false,
      copyAttachments: false,
    };

    // A developer — a member who is not on the Testing team — may not.
    await actAs(MEMBER);
    const refused = await cloneIssue({ ...draft, title: "Cloned by a developer" });
    expect(refused.ok).toBe(false);

    // The same person, once they are a tester, may.
    const { leave } = await joinTestingTeam(MEMBER);
    try {
      await actAs(MEMBER);
      const allowed = await cloneIssue({ ...draft, title: "Cloned by a tester" });
      expect(allowed.ok).toBe(true);
      if (allowed.ok) createdIssues.push(allowed.data.id);
    } finally {
      await leave();
    }
  });

  it("refuses someone with no access to the source", async () => {
    await actAs(ADMIN);
    const testing = await projectByKey("TES");
    const created = await createIssue({
      projectId: testing.id,
      type: "TASK",
      title: `Out-of-reach fixture ${Date.now()}`,
    });
    if (!created.ok) throw new Error(created.error);
    createdIssues.push(created.data.id);

    await actAs(MEMBER);
    const before = await prisma.issue.count({
      where: { projectId: testing.id },
    });

    // Not readable, so not cloneable — and refused before anything is read.
    expect((await issueCloneDraft(created.data.id)).ok).toBe(false);

    const result = await cloneIssue({
      sourceIssueId: created.data.id,
      projectId: testing.id,
      type: "TASK",
      title: "Should never exist",
      copyLinks: true,
      copyAttachments: true,
    });
    expect(result.ok).toBe(false);

    // And nothing was written on the way to being refused.
    expect(
      await prisma.issue.count({ where: { projectId: testing.id } }),
    ).toBe(before);
    expect(
      await prisma.issue.count({ where: { title: "Should never exist" } }),
    ).toBe(0);
  });

  /*
   * Cloning follows the project's own access rule rather than the caller's
   * role. Copying work you can already read produces a private copy of what
   * you could already see, so it is not an administrator's privilege — but it
   * is still a real server-side check, and the two tests below are the pair
   * that matters: a member of the project may, a stranger to it may not.
   */
  it("lets a member of the project clone it", async () => {
    const member = await actAs(MEMBER);
    const project = await projectByKey("ENG");

    // The fixture only means anything if this person really is a member.
    expect(
      await prisma.projectMember.count({
        where: { projectId: project.id, userId: member.id },
      }),
    ).toBe(1);

    const result = await duplicateProject({
      projectId: project.id,
      copyLinks: false,
      copyAttachments: false,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdProjects.push(result.data.id);

    // A new project of their own, and the original untouched.
    expect(result.data.id).not.toBe(project.id);
    expect(
      await prisma.project.findUniqueOrThrow({
        where: { id: project.id },
        select: { name: true },
      }),
    ).toMatchObject({ name: "Engineering" });
  });

  it("refuses someone with no access to the project", async () => {
    /* `MEMBER` is outside Testing, which is the administrator's own project —
       the same "outsider" the issue-clone tests above use. */
    await actAs(MEMBER);
    const testing = await projectByKey("TES");

    const before = await prisma.project.count();
    const result = await duplicateProject({
      projectId: testing.id,
      copyLinks: false,
      copyAttachments: false,
    });

    expect(result.ok).toBe(false);
    expect(await prisma.project.count()).toBe(before);
  });
});

/* ---------------------------------------------------------- project clone */

describe("cloning a project", () => {
  /** A small project with two linked issues, one of them a child, and a file. */
  async function makeSourceProject(suffix: string) {
    const admin = await actAs(ADMIN);
    const created = await createProject({
      name: `Clone source ${suffix}`,
      key: `CS${suffix}`,
      description: "Cloned in the test suite.",
      memberIds: [],
    });
    if (!created.ok) throw new Error(`fixture failed: ${created.error}`);
    createdProjects.push(created.data.id);

    const parent = await createIssue({
      projectId: created.data.id,
      type: "STORY",
      title: "Parent story",
    });
    if (!parent.ok) throw new Error(parent.error);

    const child = await createIssue({
      projectId: created.data.id,
      type: "BUG",
      title: "Child bug",
      parentId: parent.data.id,
    });
    if (!child.ok) throw new Error(child.error);

    await createIssueLink({
      issueId: parent.data.id,
      targetKey: child.data.key,
      type: "RELATES_TO",
    });
    await attach(parent.data.id, admin.id, "spec.txt", "project file bytes");

    return { id: created.data.id, parentId: parent.data.id };
  }

  it("carries the project's own configuration, and nothing shared", async () => {
    const admin = await actAs(ADMIN);
    const created = await createProject({
      name: "Clone config source",
      key: "CFGSRC",
      description: "Every project-scoped setting should travel.",
      memberIds: [],
    });
    if (!created.ok) throw new Error(created.error);
    createdProjects.push(created.data.id);

    /* A label the project grew, on top of the default vocabulary — the copy
       has to bring both, not just the defaults a new project would get. */
    const grown = await createLabel({
      projectId: created.data.id,
      name: "Regression sweep",
      color: "#AA33CC",
    });
    if (!grown.ok) throw new Error(grown.error);

    const source = await prisma.project.findUniqueOrThrow({
      where: { id: created.data.id },
      select: {
        description: true,
        labels: { select: { id: true, name: true, color: true } },
        members: { select: { userId: true } },
      },
    });

    const result = await duplicateProject({
      projectId: created.data.id,
      copyLinks: false,
      copyAttachments: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdProjects.push(result.data.id);

    const clone = await prisma.project.findUniqueOrThrow({
      where: { id: result.data.id },
      select: {
        id: true,
        key: true,
        name: true,
        description: true,
        issueSequence: true,
        labels: { select: { id: true, name: true, color: true } },
        members: { select: { userId: true } },
      },
    });

    // Its own identity: a different id, a different key, its own sequence.
    expect(clone.id).not.toBe(created.data.id);
    expect(clone.key).not.toBe("CFGSRC");
    expect(clone.name).toBe("Clone config source (Copy)");

    // The configuration itself.
    expect(clone.description).toBe(source.description);
    expect(clone.labels.map((l) => l.name).sort()).toEqual(
      source.labels.map((l) => l.name).sort(),
    );
    expect(clone.labels.map((l) => l.color).sort()).toEqual(
      source.labels.map((l) => l.color).sort(),
    );
    expect(clone.labels.map((l) => l.name)).toContain("Regression sweep");
    expect(new Set(clone.members.map((m) => m.userId))).toEqual(
      new Set([...source.members.map((m) => m.userId), admin.id]),
    );

    /* Copied, never shared. Every label on the clone is a row of its own, so
       renaming one cannot reach the original's vocabulary. */
    const sourceLabelIds = new Set(source.labels.map((l) => l.id));
    for (const label of clone.labels) {
      expect(sourceLabelIds.has(label.id)).toBe(false);
    }

    await prisma.label.update({
      where: { id: clone.labels[0]!.id },
      data: { name: "Renamed on the copy" },
    });

    const original = await prisma.project.findUniqueOrThrow({
      where: { id: created.data.id },
      select: {
        description: true,
        labels: { select: { name: true } },
      },
    });
    expect(original.description).toBe(source.description);
    expect(original.labels.map((l) => l.name).sort()).toEqual(
      source.labels.map((l) => l.name).sort(),
    );
    expect(original.labels.map((l) => l.name)).not.toContain(
      "Renamed on the copy",
    );
  });

  const cases = [
    { links: false, files: false },
    { links: true, files: false },
    { links: false, files: true },
    { links: true, files: true },
  ];

  for (const [index, choice] of cases.entries()) {
    it(`copies links ${choice.links ? "on" : "off"} / attachments ${
      choice.files ? "on" : "off"
    }`, async () => {
      const source = await makeSourceProject(`${index}`);

      const result = await duplicateProject({
        projectId: source.id,
        copyLinks: choice.links,
        copyAttachments: choice.files,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      createdProjects.push(result.data.id);

      expect(result.data.id).not.toBe(source.id);
      expect(result.data.copiedIssues).toBe(2);

      const clone = await prisma.project.findUniqueOrThrow({
        where: { id: result.data.id },
        select: {
          key: true,
          issues: {
            orderBy: { number: "asc" },
            select: {
              key: true,
              title: true,
              type: true,
              parentId: true,
              _count: { select: { linksFrom: true, attachments: true } },
            },
          },
        },
      });

      // New keys from the clone's own sequence, never the source's.
      for (const issue of clone.issues) {
        expect(issue.key.startsWith(`${clone.key}-`)).toBe(true);
      }
      expect(clone.issues.map((i) => i.title)).toEqual([
        "Parent story",
        "Child bug",
      ]);

      const childParent = clone.issues[1]?.parentId ?? null;
      const links = clone.issues.reduce(
        (total, issue) => total + issue._count.linksFrom,
        0,
      );

      if (choice.links) {
        // Re-pointed inside the clone, never back at the original's issues.
        const clonedParentId = (
          await prisma.issue.findUniqueOrThrow({
            where: { key: clone.issues[0]!.key },
            select: { id: true },
          })
        ).id;
        expect(childParent).toBe(clonedParentId);
        expect(childParent).not.toBe(source.parentId);
        expect(links).toBe(2);
      } else {
        expect(childParent).toBeNull();
        expect(links).toBe(0);
      }

      const files = clone.issues.reduce(
        (total, issue) => total + issue._count.attachments,
        0,
      );
      expect(files).toBe(choice.files ? 1 : 0);

      // The original is untouched whichever way the boxes were ticked.
      const original = await prisma.project.findUniqueOrThrow({
        where: { id: source.id },
        select: {
          name: true,
          issues: {
            select: {
              parentId: true,
              _count: { select: { linksFrom: true, attachments: true } },
            },
          },
        },
      });
      expect(original.name).toBe(`Clone source ${index}`);
      expect(original.issues).toHaveLength(2);
      expect(
        original.issues.reduce((t, i) => t + i._count.linksFrom, 0),
      ).toBe(2);
      expect(
        original.issues.reduce((t, i) => t + i._count.attachments, 0),
      ).toBe(1);
    });
  }
});
