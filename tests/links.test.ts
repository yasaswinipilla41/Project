import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  createIssueLink,
  removeIssueLink,
  searchLinkableIssues,
} from "@/server/links";
import { LINK_INVERSE } from "@/lib/issue-links";
import { actAs, actAsAnonymous, projectByKey } from "./helpers";

/**
 * Relationships between issues.
 *
 * The invariant these protect is that a link is always a matched pair. If one
 * direction were written without the other, an issue would be blocked by
 * something that did not know it was blocking — which is worse than no link at
 * all, because the page looks complete.
 */

const ADMIN = "admin@symbiosystech.com";
const MEMBER = "priya.nair@symbiosystech.com";
const OUTSIDER = "sneha.iyer@symbiosystech.com";

const createdIssues: string[] = [];
const createdProjects: string[] = [];

afterAll(async () => {
  if (createdIssues.length > 0) {
    await prisma.issue.deleteMany({ where: { id: { in: createdIssues } } });
  }
  if (createdProjects.length > 0) {
    await prisma.project.deleteMany({ where: { id: { in: createdProjects } } });
  }
  await prisma.$disconnect();
});

/** Two fresh issues in ENG, so the tests never disturb the seeded ones. */
async function twoIssues() {
  const project = await projectByKey("ENG");
  const reporter = await prisma.user.findUniqueOrThrow({
    where: { email: MEMBER },
  });

  const made = [];
  for (let index = 0; index < 2; index += 1) {
    const issue = await prisma.$transaction(async (tx) => {
      const updated = await tx.project.update({
        where: { id: project.id },
        data: { issueSequence: { increment: 1 } },
        select: { issueSequence: true, key: true },
      });
      return tx.issue.create({
        data: {
          key: `${updated.key}-${updated.issueSequence}`,
          number: updated.issueSequence,
          projectId: project.id,
          type: "TASK",
          title: `Link fixture ${index + 1}`,
          reporterId: reporter.id,
        },
        select: { id: true, key: true },
      });
    });
    createdIssues.push(issue.id);
    made.push(issue);
  }

  return made as [(typeof made)[0], (typeof made)[0]];
}

describe("creating a link", () => {
  it("writes both directions", async () => {
    await actAs(MEMBER);
    const [a, b] = await twoIssues();

    const result = await createIssueLink({
      issueId: a.id,
      targetKey: b.key,
      type: "BLOCKS",
    });

    expect(result.ok).toBe(true);

    const forward = await prisma.issueLink.findFirst({
      where: { sourceId: a.id, targetId: b.id, type: "BLOCKS" },
    });
    const backward = await prisma.issueLink.findFirst({
      where: { sourceId: b.id, targetId: a.id, type: "IS_BLOCKED_BY" },
    });

    expect(forward).not.toBeNull();
    expect(backward).not.toBeNull();
  });

  it("uses the right inverse for every type", async () => {
    await actAs(MEMBER);

    for (const type of ["BLOCKS", "RELATES_TO", "DUPLICATES"] as const) {
      const [a, b] = await twoIssues();

      const result = await createIssueLink({
        issueId: a.id,
        targetKey: b.key,
        type,
      });
      expect(result.ok).toBe(true);

      const backward = await prisma.issueLink.findFirst({
        where: { sourceId: b.id, targetId: a.id },
        select: { type: true },
      });
      expect(backward?.type).toBe(LINK_INVERSE[type]);
    }
  });

  it("records the change on both issues", async () => {
    await actAs(MEMBER);
    const [a, b] = await twoIssues();

    await createIssueLink({ issueId: a.id, targetKey: b.key, type: "BLOCKS" });

    const entries = await prisma.activityLogEntry.findMany({
      where: { issueId: { in: [a.id, b.id] }, action: "link.added" },
      select: { issueId: true, newValue: true },
    });

    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.newValue).sort()).toEqual([a.key, b.key].sort());
  });

  it("refuses to link an issue to itself", async () => {
    await actAs(MEMBER);
    const [a] = await twoIssues();

    const result = await createIssueLink({
      issueId: a.id,
      targetKey: a.key,
      type: "RELATES_TO",
    });

    expect(result.ok).toBe(false);
    expect(await prisma.issueLink.count({ where: { sourceId: a.id } })).toBe(0);
  });

  it("refuses a duplicate of the same relationship", async () => {
    await actAs(MEMBER);
    const [a, b] = await twoIssues();

    expect(
      (await createIssueLink({ issueId: a.id, targetKey: b.key, type: "BLOCKS" }))
        .ok,
    ).toBe(true);

    const second = await createIssueLink({
      issueId: a.id,
      targetKey: b.key,
      type: "BLOCKS",
    });
    expect(second.ok).toBe(false);

    expect(
      await prisma.issueLink.count({
        where: { sourceId: a.id, targetId: b.id, type: "BLOCKS" },
      }),
    ).toBe(1);
  });

  it("refuses an unauthenticated caller", async () => {
    await actAs(MEMBER);
    const [a, b] = await twoIssues();

    actAsAnonymous();
    const result = await createIssueLink({
      issueId: a.id,
      targetKey: b.key,
      type: "BLOCKS",
    });

    expect(result.ok).toBe(false);
    expect(await prisma.issueLink.count({ where: { sourceId: a.id } })).toBe(0);
  });
});

describe("authorization", () => {
  /** An issue in a project the outsider is not a member of. */
  async function hiddenIssue() {
    const owner = await prisma.user.findUniqueOrThrow({ where: { email: ADMIN } });
    const project = await prisma.project.create({
      data: {
        name: "Link Fixture (closed)",
        key: `LK${Date.now().toString(36).slice(-5).toUpperCase()}`,
        createdById: owner.id,
        members: { create: { userId: owner.id } },
      },
      select: { id: true, key: true },
    });
    createdProjects.push(project.id);

    const issue = await prisma.issue.create({
      data: {
        key: `${project.key}-1`,
        number: 1,
        projectId: project.id,
        type: "TASK",
        title: "Hidden from the outsider",
        reporterId: owner.id,
      },
      select: { id: true, key: true },
    });
    createdIssues.push(issue.id);

    return issue;
  }

  it("will not link to an issue the caller cannot read", async () => {
    const hidden = await hiddenIssue();

    await actAs(OUTSIDER);
    const [a] = await twoIssues();

    const result = await createIssueLink({
      issueId: a.id,
      targetKey: hidden.key,
      type: "RELATES_TO",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Wording says "not available to you" rather than "you may not" — the
      // endpoint must not confirm that the key exists somewhere.
      expect(result.error).toMatch(/no issue with that key/i);
    }
    expect(await prisma.issueLink.count({ where: { sourceId: a.id } })).toBe(0);
  });

  it("does not surface unreachable issues in the search", async () => {
    const hidden = await hiddenIssue();

    await actAs(OUTSIDER);
    const [a] = await twoIssues();

    const result = await searchLinkableIssues(a.id, hidden.key);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.map((i) => i.key)).not.toContain(hidden.key);
  });

  it("never offers the issue itself", async () => {
    await actAs(MEMBER);
    const [a] = await twoIssues();

    const result = await searchLinkableIssues(a.id, a.key);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.map((i) => i.id)).not.toContain(a.id);
  });
});

describe("removing a link", () => {
  it("removes both directions", async () => {
    await actAs(MEMBER);
    const [a, b] = await twoIssues();

    await createIssueLink({ issueId: a.id, targetKey: b.key, type: "BLOCKS" });

    const link = await prisma.issueLink.findFirstOrThrow({
      where: { sourceId: a.id, targetId: b.id },
      select: { id: true },
    });

    const result = await removeIssueLink(link.id);
    expect(result.ok).toBe(true);

    expect(
      await prisma.issueLink.count({
        where: {
          OR: [
            { sourceId: a.id, targetId: b.id },
            { sourceId: b.id, targetId: a.id },
          ],
        },
      }),
    ).toBe(0);
  });

  it("refuses an unauthenticated caller", async () => {
    await actAs(MEMBER);
    const [a, b] = await twoIssues();
    await createIssueLink({ issueId: a.id, targetKey: b.key, type: "BLOCKS" });

    const link = await prisma.issueLink.findFirstOrThrow({
      where: { sourceId: a.id, targetId: b.id },
      select: { id: true },
    });

    actAsAnonymous();
    const result = await removeIssueLink(link.id);

    expect(result.ok).toBe(false);
    expect(await prisma.issueLink.count({ where: { id: link.id } })).toBe(1);
  });
});

describe("the parent/child hierarchy is untouched", () => {
  it("links and parenthood are stored separately", async () => {
    await actAs(MEMBER);
    const [a, b] = await twoIssues();

    await prisma.issue.update({
      where: { id: b.id },
      data: { parentId: a.id },
    });

    await createIssueLink({ issueId: a.id, targetKey: b.key, type: "RELATES_TO" });

    const child = await prisma.issue.findUniqueOrThrow({
      where: { id: b.id },
      select: { parentId: true },
    });

    // Adding a relationship did not disturb the containment relationship.
    expect(child.parentId).toBe(a.id);
    expect(
      await prisma.issueLink.count({ where: { sourceId: a.id, targetId: b.id } }),
    ).toBe(1);
  });
});
