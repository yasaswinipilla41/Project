import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { updateProject } from "@/server/projects";
import { actAs } from "./helpers";

/**
 * `isDefaultProject` enrols every future self-registered account into the
 * project, so switching it is an administrator's decision alone, not the
 * creator's. A member who duplicates a project they can read becomes its
 * "creator", and must not be able to publish its contents to every newcomer.
 */

const ADMIN = "admin@symbiosystech.com";
const CREATOR = "priya.nair@symbiosystech.com";
const started = Date.now().toString(36).slice(-4).toUpperCase();
const scratch: string[] = [];
let sequence = 0;

async function projectCreatedBy(email: string, isDefaultProject = false) {
  const owner = await prisma.user.findUniqueOrThrow({ where: { email } });
  const key = `DF${started}${(sequence += 1)}`.slice(0, 10);
  const project = await prisma.project.create({
    data: {
      name: `Default flag fixture ${key}`,
      key,
      createdById: owner.id,
      isDefaultProject,
      members: { create: { userId: owner.id } },
    },
    select: { id: true, name: true },
  });
  scratch.push(project.id);
  return project;
}

const flagOf = async (id: string) =>
  (await prisma.project.findUniqueOrThrow({ where: { id }, select: { isDefaultProject: true } }))
    .isDefaultProject;

afterAll(async () => {
  await prisma.project.deleteMany({ where: { id: { in: scratch } } });
  await prisma.$disconnect();
});

describe("turning a project into a default project", () => {
  it("is refused for its creator, and the flag stays off", async () => {
    const project = await projectCreatedBy(CREATOR);
    await actAs(CREATOR);

    const result = await updateProject({
      projectId: project.id,
      name: project.name,
      description: null,
      isDefaultProject: true,
    });

    expect(result.ok).toBe(false);
    expect(await flagOf(project.id)).toBe(false);
  });

  it("is refused for turning it back off, too", async () => {
    const project = await projectCreatedBy(CREATOR, true);
    await actAs(CREATOR);

    const result = await updateProject({
      projectId: project.id,
      name: project.name,
      description: null,
      isDefaultProject: false,
    });

    expect(result.ok).toBe(false);
    expect(await flagOf(project.id)).toBe(true);
  });

  it("does not stop a creator saving other settings with the flag as it is", async () => {
    const project = await projectCreatedBy(CREATOR);
    await actAs(CREATOR);

    for (const isDefaultProject of [false, undefined]) {
      const result = await updateProject({
        projectId: project.id,
        name: `${project.name} (renamed)`,
        description: "Still theirs.",
        ...(isDefaultProject === undefined ? {} : { isDefaultProject }),
      });
      expect(result.ok, result.ok ? "" : result.error).toBe(true);
    }
    expect(await flagOf(project.id)).toBe(false);
  });

  it("is allowed for an administrator, in both directions", async () => {
    const project = await projectCreatedBy(CREATOR);
    await actAs(ADMIN);

    const on = await updateProject({
      projectId: project.id,
      name: project.name,
      description: null,
      isDefaultProject: true,
    });
    expect(on.ok, on.ok ? "" : on.error).toBe(true);
    expect(await flagOf(project.id)).toBe(true);

    const off = await updateProject({
      projectId: project.id,
      name: project.name,
      description: null,
      isDefaultProject: false,
    });
    expect(off.ok).toBe(true);
    expect(await flagOf(project.id)).toBe(false);
  });
});
