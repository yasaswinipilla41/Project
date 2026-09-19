import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  displayRoleOf,
  projectDisplayRoleOf,
  projectDisplayRolesByKey,
} from "@/lib/authz";
import { requireUser } from "@/lib/session";
import { actAs, projectByKey } from "./helpers";

/**
 * What each project calls somebody, which is what the header reads to decide
 * whether to offer Create.
 *
 * The rule being pinned is that a designation belongs to one membership: being
 * the developer on one project says nothing about the next one. The header
 * resolves the active project from the path and looks it up in this map, so a
 * leak here would be a leak on screen.
 *
 * Nothing about permission is asserted, because a designation grants none —
 * `workRoleOf` remains the authority and is untouched by any of this.
 */

const ADMIN = "admin@symbiosystech.com";
const MEMBER = "priya.nair@symbiosystech.com";

let memberId = "";
let engId = "";
let webId = "";
const restore: (() => Promise<void>)[] = [];

/** Makes sure somebody is on a project, and hands back the undo. */
async function ensureMember(projectId: string, userId: string) {
  const existing = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
    select: { id: true, designation: true },
  });

  if (!existing) {
    await prisma.projectMember.create({ data: { projectId, userId } });
    return async () => {
      await prisma.projectMember.deleteMany({ where: { projectId, userId } });
    };
  }

  const had = existing.designation;
  return async () => {
    await prisma.projectMember.update({
      where: { projectId_userId: { projectId, userId } },
      data: { designation: had },
    });
  };
}

beforeAll(async () => {
  memberId = (
    await prisma.user.findUniqueOrThrow({
      where: { email: MEMBER },
      select: { id: true },
    })
  ).id;

  engId = (await projectByKey("ENG")).id;
  webId = (await projectByKey("WEB")).id;

  restore.push(await ensureMember(engId, memberId));
  restore.push(await ensureMember(webId, memberId));
});

afterAll(async () => {
  for (const undo of restore) await undo();
  await prisma.$disconnect();
});

describe("a designation belongs to one project", () => {
  it("answers differently for two projects held by the same person", async () => {
    await prisma.projectMember.update({
      where: { projectId_userId: { projectId: engId, userId: memberId } },
      data: { designation: "DEVELOPER" },
    });
    await prisma.projectMember.update({
      where: { projectId_userId: { projectId: webId, userId: memberId } },
      data: { designation: "QA" },
    });

    await actAs(MEMBER);
    const user = await requireUser();
    const byKey = await projectDisplayRolesByKey(user);

    expect(byKey.eng).toBe("DEVELOPER");
    expect(byKey.web).toBe("QA");

    /* And the single-project resolver, which the Welcome screen already used,
       agrees with the map the header reads. */
    expect(await projectDisplayRoleOf(user, engId)).toBe("DEVELOPER");
    expect(await projectDisplayRoleOf(user, webId)).toBe("QA");
  });

  it("falls back to the organisation-wide badge where a project says nothing",
    async () => {
      await prisma.projectMember.update({
        where: { projectId_userId: { projectId: engId, userId: memberId } },
        data: { designation: "DEVELOPER" },
      });
      await prisma.projectMember.update({
        where: { projectId_userId: { projectId: webId, userId: memberId } },
        data: { designation: null },
      });

      await actAs(MEMBER);
    const user = await requireUser();
      const byKey = await projectDisplayRolesByKey(user);

      expect(byKey.eng).toBe("DEVELOPER");
      /* Whatever Prio calls them everywhere — never the other project's answer. */
      expect(byKey.web).not.toBe("DEVELOPER");
      expect(byKey.web).toBe(await projectDisplayRoleOf(user, webId));
    });

  it("answers the same whether or not the badge is handed to it", async () => {
    /* The chrome resolves the organisation-wide badge for the avatar and hands
       it in rather than paying for the same query twice. The two forms have to
       agree, or that saving would change what the header says. */
    await prisma.projectMember.update({
      where: { projectId_userId: { projectId: engId, userId: memberId } },
      data: { designation: "DEVELOPER" },
    });
    await prisma.projectMember.update({
      where: { projectId_userId: { projectId: webId, userId: memberId } },
      data: { designation: null },
    });

    await actAs(MEMBER);
    const user = await requireUser();

    const resolved = await projectDisplayRolesByKey(user);
    const handed = await projectDisplayRolesByKey(user, await displayRoleOf(user));

    expect(handed).toEqual(resolved);
    /* And the handed-in value is what an unnamed membership falls back to. */
    expect(handed.web).toBe(await displayRoleOf(user));
  });

  it("gives an administrator nothing to look up", async () => {
    await actAs(ADMIN);
    const admin = await requireUser();
    /* They are an administrator on every project, so there is no per-project
       answer to carry and the caller's own role stands. */
    expect(await projectDisplayRolesByKey(admin)).toEqual({});
    expect(await projectDisplayRoleOf(admin, engId)).toBe("ADMIN");
  });

  it("says nothing about a project somebody does not belong to", async () => {
    await actAs(MEMBER);
    const user = await requireUser();
    const intId = (await projectByKey("INT")).id;
    const member = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId: intId, userId: memberId } },
      select: { id: true },
    });

    const byKey = await projectDisplayRolesByKey(user);
    if (member) {
      expect(Object.keys(byKey)).toContain("int");
    } else {
      expect(byKey.int).toBeUndefined();
    }
  });
});
