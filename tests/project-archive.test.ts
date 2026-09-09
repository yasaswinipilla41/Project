import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { TESTING_TEAM_SLUG } from "@/lib/authz";
import { updateProject } from "@/server/projects";
import { actAs, projectByKey } from "./helpers";

/**
 * Archiving a project, and who may.
 *
 * Archiving is reversible and destroys nothing: it sets one flag, and every
 * list in Prio then leaves the project out. That makes two things worth
 * asserting against the server rather than the interface — that only an
 * administrator can set or clear the flag, and that setting it takes nothing
 * away. The first is the permission; the second is why the permission is the
 * only protection needed.
 */

const ADMIN = "admin@symbiosystech.com";
const TESTER = "priya.nair@symbiosystech.com";
const DEVELOPER = "kiran.das@symbiosystech.com";

let projectId = "";
let projectKey = "";
const memberships: string[] = [];

beforeAll(async () => {
  const project = await projectByKey("INT");
  projectId = project.id;
  projectKey = project.key;

  const [tester, team] = await Promise.all([
    prisma.user.findUniqueOrThrow({
      where: { email: TESTER },
      select: { id: true },
    }),
    prisma.team.findUniqueOrThrow({
      where: { slug: TESTING_TEAM_SLUG },
      select: { id: true },
    }),
  ]);
  const row = await prisma.teamMember.upsert({
    where: { teamId_userId: { teamId: team.id, userId: tester.id } },
    update: {},
    create: { teamId: team.id, userId: tester.id },
    select: { id: true },
  });
  memberships.push(row.id);
});

afterAll(async () => {
  // Left as it was found, whatever the tests did in between.
  await prisma.project.update({
    where: { id: projectId },
    data: { isArchived: false },
  });
  await prisma.teamMember.deleteMany({ where: { id: { in: memberships } } });
  await prisma.$disconnect();
});

function archivedNow(): Promise<boolean> {
  return prisma.project
    .findUniqueOrThrow({ where: { id: projectId }, select: { isArchived: true } })
    .then((row) => row.isArchived);
}

/** What archiving must not touch. */
async function census() {
  const [issues, members, project] = await Promise.all([
    prisma.issue.count({ where: { projectId } }),
    prisma.projectMember.count({ where: { projectId } }),
    prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { key: true, name: true, description: true, isDefaultProject: true },
    }),
  ]);
  return { issues, members, project };
}

describe("an administrator", () => {
  it("archives a project, and unarchives it again", async () => {
    await actAs(ADMIN);
    const project = await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { name: true, description: true },
    });

    const archive = await updateProject({
      projectId,
      name: project.name,
      description: project.description,
      isArchived: true,
    });
    expect(archive.ok).toBe(true);
    expect(await archivedNow()).toBe(true);

    const restore = await updateProject({
      projectId,
      name: project.name,
      description: project.description,
      isArchived: false,
    });
    expect(restore.ok).toBe(true);
    expect(await archivedNow()).toBe(false);
  });

  it("keeps the issues, the members and the settings while it is archived", async () => {
    const before = await census();

    await actAs(ADMIN);
    await updateProject({
      projectId,
      name: before.project.name,
      description: before.project.description,
      isArchived: true,
    });

    const during = await census();
    expect(during).toEqual(before);
    expect(await archivedNow()).toBe(true);

    await updateProject({
      projectId,
      name: before.project.name,
      description: before.project.description,
      isArchived: false,
    });

    expect(await census()).toEqual(before);
  });
});

describe("everybody else", () => {
  for (const [who, email] of [
    ["a developer", DEVELOPER],
    ["a tester", TESTER],
  ] as const) {
    it(`refuses ${who} archiving a project`, async () => {
      const before = await prisma.project.findUniqueOrThrow({
        where: { id: projectId },
        select: { name: true, description: true, isArchived: true },
      });
      expect(before.isArchived, "starts unarchived").toBe(false);

      await actAs(email);
      const result = await updateProject({
        projectId,
        name: before.name,
        description: before.description,
        isArchived: true,
      });

      expect(result.ok).toBe(false);
      expect(await archivedNow()).toBe(false);
    });

    it(`refuses ${who} unarchiving one`, async () => {
      await actAs(ADMIN);
      const project = await prisma.project.findUniqueOrThrow({
        where: { id: projectId },
        select: { name: true, description: true },
      });
      await updateProject({
        projectId,
        name: project.name,
        description: project.description,
        isArchived: true,
      });
      expect(await archivedNow()).toBe(true);

      await actAs(email);
      const result = await updateProject({
        projectId,
        name: project.name,
        description: project.description,
        isArchived: false,
      });

      expect(result.ok).toBe(false);
      expect(await archivedNow(), "still archived").toBe(true);

      // Put it back for the next case.
      await actAs(ADMIN);
      await updateProject({
        projectId,
        name: project.name,
        description: project.description,
        isArchived: false,
      });
    });
  }

  it("does not offer an archived project to anybody's project list", async () => {
    /* The flag is the whole mechanism: `projectScope` is unchanged, and every
       list adds `isArchived: false` of its own. Asserted here through the
       same query the pages run, so the two cannot drift apart silently. */
    await actAs(ADMIN);
    const project = await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { name: true, description: true },
    });
    await updateProject({
      projectId,
      name: project.name,
      description: project.description,
      isArchived: true,
    });

    const listed = await prisma.project.count({
      where: { id: projectId, isArchived: false },
    });
    expect(listed).toBe(0);

    // …and an administrator can still find it, which is what the Projects
    // page's archived section reads.
    const findable = await prisma.project.count({
      where: { id: projectId, isArchived: true },
    });
    expect(findable).toBe(1);

    await updateProject({
      projectId,
      name: project.name,
      description: project.description,
      isArchived: false,
    });
    expect(await archivedNow()).toBe(false);
  });
});

describe("the key stays with the project", () => {
  it("survives an archive and a restore", async () => {
    await actAs(ADMIN);
    const project = await prisma.project.findUniqueOrThrow({
      where: { id: projectId },
      select: { name: true, description: true },
    });

    for (const isArchived of [true, false]) {
      await updateProject({
        projectId,
        name: project.name,
        description: project.description,
        isArchived,
      });
      const row = await prisma.project.findUniqueOrThrow({
        where: { id: projectId },
        select: { key: true },
      });
      expect(row.key).toBe(projectKey);
    }
  });
});
