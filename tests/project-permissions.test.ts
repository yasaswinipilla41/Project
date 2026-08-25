import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { deleteProject, updateProject } from "@/server/projects";
import { actAs, actAsAnonymous } from "./helpers";

/**
 * Who may edit and delete a project.
 *
 * The rule under test is narrow and easy to get wrong in the permissive
 * direction:
 *
 *     ADMIN            -> any project
 *     project creator  -> their own project
 *     anyone else      -> nothing, including other members of that project
 *
 * These call the server actions directly, with no browser involved, because
 * that is the only check that counts. A hidden button proves nothing.
 */

const ADMIN = "admin@symbiosystech.com";
const OWNER = "priya.nair@symbiosystech.com";
const OTHER = "kiran.das@symbiosystech.com";

/** Projects created by these tests, removed afterwards whatever happens. */
const scratch: string[] = [];

/** Distinguishes this run's fixtures from an earlier one's. */
const started = Date.now().toString(36).slice(-4).toUpperCase();

/**
 * A project owned by `ownerEmail`, with `otherEmail` as a member.
 *
 * Written through Prisma rather than `createProject`, because creating a
 * project is an administrator action: a MEMBER-owned project is a state the
 * application can reach (an administrator's account can be demoted, or a
 * project can be handed over) but not one its create action produces. The
 * permission rule still has to hold for it.
 */
let sequence = 0;

async function makeProject(ownerEmail: string, otherEmail: string) {
  /* Project keys are unique across the organization, so each fixture needs its
     own. Derived from a counter and the run's start time rather than a random
     value, which keeps a failed run's leftovers identifiable. */
  const key = `PT${started}${(sequence += 1)}`.slice(0, 10);

  const [owner, other] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { email: ownerEmail } }),
    prisma.user.findUniqueOrThrow({ where: { email: otherEmail } }),
  ]);

  const project = await prisma.project.create({
    data: {
      name: `Permission Fixture ${key}`,
      key,
      description: "Created by the project-permission tests.",
      createdById: owner.id,
      members: {
        createMany: { data: [{ userId: owner.id }, { userId: other.id }] },
      },
    },
    select: { id: true, name: true, key: true, createdById: true },
  });

  scratch.push(project.id);
  return project;
}

beforeAll(async () => {
  // Clear anything an earlier interrupted run left behind.
  await prisma.project.deleteMany({ where: { key: { startsWith: "PT" } } });
});

afterAll(async () => {
  if (scratch.length > 0) {
    await prisma.project.deleteMany({ where: { id: { in: scratch } } });
  }
  await prisma.project.deleteMany({ where: { key: { startsWith: "PT" } } });
  await prisma.$disconnect();
});

describe("editing a project", () => {
  it("lets the creator edit their own project", async () => {
    const project = await makeProject(OWNER, OTHER);
    await actAs(OWNER);

    const result = await updateProject({
      projectId: project.id,
      name: "Renamed by its creator",
      description: "Still theirs.",
    });

    expect(result.ok).toBe(true);

    const row = await prisma.project.findUniqueOrThrow({
      where: { id: project.id },
      select: { name: true },
    });
    expect(row.name).toBe("Renamed by its creator");
  });

  it("refuses another member of the same project", async () => {
    const project = await makeProject(OWNER, OTHER);
    await actAs(OTHER);

    const result = await updateProject({
      projectId: project.id,
      name: "Renamed by someone else",
      description: null,
    });

    expect(result.ok).toBe(false);

    // Belonging to a project is not owning it: nothing changed.
    const row = await prisma.project.findUniqueOrThrow({
      where: { id: project.id },
      select: { name: true },
    });
    expect(row.name).toBe(project.name);
  });

  it("lets an administrator edit a project they did not create", async () => {
    const project = await makeProject(OWNER, OTHER);
    await actAs(ADMIN);

    const result = await updateProject({
      projectId: project.id,
      name: "Renamed by an administrator",
      description: null,
    });

    expect(result.ok).toBe(true);
  });

  it("leaves isDefaultProject untouched when the field is omitted, and persists it when set", async () => {
    const project = await makeProject(OWNER, OTHER);
    await actAs(ADMIN);

    const untouched = await updateProject({
      projectId: project.id,
      name: project.name,
      description: null,
    });
    expect(untouched.ok).toBe(true);

    const stillOff = await prisma.project.findUniqueOrThrow({
      where: { id: project.id },
      select: { isDefaultProject: true },
    });
    expect(stillOff.isDefaultProject).toBe(false);

    const turnedOn = await updateProject({
      projectId: project.id,
      name: project.name,
      description: null,
      isDefaultProject: true,
    });
    expect(turnedOn.ok).toBe(true);

    const on = await prisma.project.findUniqueOrThrow({
      where: { id: project.id },
      select: { isDefaultProject: true },
    });
    expect(on.isDefaultProject).toBe(true);

    // No other project was touched by turning this one on.
    const others = await prisma.project.findMany({
      where: { id: { not: project.id } },
      select: { key: true, isDefaultProject: true },
    });
    for (const other of others) {
      const seeded = ["WEB", "ENG", "INT", "TES"].includes(other.key);
      if (seeded) expect(other.isDefaultProject).toBe(false);
    }
  });

  it("refuses an unauthenticated caller", async () => {
    const project = await makeProject(OWNER, OTHER);
    actAsAnonymous();

    const result = await updateProject({
      projectId: project.id,
      name: "Renamed by nobody",
      description: null,
    });

    expect(result.ok).toBe(false);

    const row = await prisma.project.findUniqueOrThrow({
      where: { id: project.id },
      select: { name: true },
    });
    expect(row.name).toBe(project.name);
  });
});

describe("deleting a project", () => {
  it("refuses another member, even with the name typed correctly", async () => {
    const project = await makeProject(OWNER, OTHER);
    await actAs(OTHER);

    const result = await deleteProject({
      projectId: project.id,
      confirmName: project.name,
    });

    expect(result.ok).toBe(false);
    expect(
      await prisma.project.count({ where: { id: project.id } }),
    ).toBe(1);
  });

  it("refuses an unauthenticated caller", async () => {
    const project = await makeProject(OWNER, OTHER);
    actAsAnonymous();

    const result = await deleteProject({
      projectId: project.id,
      confirmName: project.name,
    });

    expect(result.ok).toBe(false);
    expect(await prisma.project.count({ where: { id: project.id } })).toBe(1);
  });

  it("refuses the owner when the typed name does not match", async () => {
    const project = await makeProject(OWNER, OTHER);
    await actAs(OWNER);

    const result = await deleteProject({
      projectId: project.id,
      confirmName: "not the right name",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fieldErrors?.confirmName).toBeDefined();
    }
    expect(await prisma.project.count({ where: { id: project.id } })).toBe(1);
  });

  it("lets the creator delete their own project", async () => {
    const project = await makeProject(OWNER, OTHER);
    await actAs(OWNER);

    const result = await deleteProject({
      projectId: project.id,
      confirmName: project.name,
    });

    expect(result.ok).toBe(true);
    expect(await prisma.project.count({ where: { id: project.id } })).toBe(0);
  });

  it("lets an administrator delete a project they did not create", async () => {
    const project = await makeProject(OWNER, OTHER);
    await actAs(ADMIN);

    const result = await deleteProject({
      projectId: project.id,
      confirmName: project.name,
    });

    expect(result.ok).toBe(true);
    expect(await prisma.project.count({ where: { id: project.id } })).toBe(0);
  });

  it("says the project does not exist rather than that it is forbidden", async () => {
    await actAs(OTHER);

    const result = await deleteProject({
      projectId: "clzzzzzzzzzzzzzzzzzzzzzzz",
      confirmName: "anything",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Probing for project ids must not distinguish "not yours" from
      // "not a project", or the endpoint becomes an enumeration oracle.
      expect(result.error).toMatch(/no longer exists/i);
    }
  });
});

describe("deleting a project takes its contents with it", () => {
  it("removes issues, comments, mentions and activity in one transaction", async () => {
    const project = await makeProject(OWNER, OTHER);
    const owner = await prisma.user.findUniqueOrThrow({
      where: { email: OWNER },
    });

    const issue = await prisma.issue.create({
      data: {
        key: `${project.key}-1`,
        number: 1,
        projectId: project.id,
        type: "BUG",
        title: "Fixture bug",
        description: "For the deletion test.",
        reporterId: owner.id,
        severity: "MAJOR",
      },
      select: { id: true },
    });

    const comment = await prisma.comment.create({
      data: {
        issueId: issue.id,
        authorId: owner.id,
        body: "A comment that should not outlive its project.",
        mentions: { create: { userId: owner.id } },
      },
      select: { id: true },
    });

    await prisma.activityLogEntry.create({
      data: { issueId: issue.id, actorId: owner.id, action: "issue.created" },
    });

    await actAs(OWNER);
    const result = await deleteProject({
      projectId: project.id,
      confirmName: project.name,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.issues).toBe(1);

    // Nothing orphaned.
    expect(await prisma.issue.count({ where: { id: issue.id } })).toBe(0);
    expect(await prisma.comment.count({ where: { id: comment.id } })).toBe(0);
    expect(
      await prisma.commentMention.count({ where: { commentId: comment.id } }),
    ).toBe(0);
    expect(
      await prisma.activityLogEntry.count({ where: { issueId: issue.id } }),
    ).toBe(0);
    expect(
      await prisma.projectMember.count({ where: { projectId: project.id } }),
    ).toBe(0);
  });

  it("leaves every other project untouched", async () => {
    const before = await prisma.project.findMany({
      where: { key: { in: ["ENG", "INT", "TES", "WEB"] } },
      select: { id: true, key: true },
    });

    const project = await makeProject(OWNER, OTHER);
    await actAs(ADMIN);
    await deleteProject({ projectId: project.id, confirmName: project.name });

    const after = await prisma.project.findMany({
      where: { key: { in: ["ENG", "INT", "TES", "WEB"] } },
      select: { id: true, key: true },
    });

    expect(after.map((p) => p.key).sort()).toEqual(
      before.map((p) => p.key).sort(),
    );
  });
});
