import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { projectDisplayRoleOf, workRoleOf } from "@/lib/authz";
import { setProjectMemberDesignation } from "@/server/projects";
import { actAs, projectByKey } from "./helpers";

/**
 * What a project calls somebody, and what that does not change.
 *
 * Prio has three global answers about a person — the account role, the work
 * role derived from their teams, and the badge derived from that — and needs
 * them global, because a guard cannot ask "may they, *here*?" if here is not
 * part of the question. What it lacked was a way for a project to say what
 * somebody does *on it*, so a tester on one project and a developer on another
 * read the same on both.
 *
 * Two claims, and the second is the important one:
 *
 *   1. a designation is per project, and one project's answer does not leak
 *      into another's;
 *   2. it decides nothing. Being called QA here does not make somebody a
 *      tester to any permission check, because no guard reads the column.
 */

const ADMIN = "admin@symbiosystech.com";
const MEMBER = "sneha.iyer@symbiosystech.com";

/** Every membership this file touched, so it can put them all back. */
const touched: { projectId: string; userId: string }[] = [];

afterAll(async () => {
  for (const row of touched) {
    await prisma.projectMember.updateMany({
      where: row,
      data: { designation: null },
    });
  }
  await prisma.$disconnect();
});

async function memberOf(key: string) {
  const project = await projectByKey(key);
  const user = await prisma.user.findUniqueOrThrow({
    where: { email: MEMBER },
    select: { id: true, name: true, email: true, role: true, jobTitle: true },
  });

  /* Only projects this person is already on: a designation is a fact about a
     membership, and the action refuses one that does not exist. */
  const membership = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId: project.id, userId: user.id } },
    select: { id: true },
  });

  return { project, user, isMember: membership !== null };
}

/** The `CurrentUser` shape the resolver takes, for the member under test. */
async function asCurrentUser(email: string) {
  const row = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      image: true,
      jobTitle: true,
      isActive: true,
    },
  });
  return row;
}

describe("a designation on one project", () => {
  it("is what that project calls them, and leaves every other project alone", async () => {
    const here = await memberOf("ENG");
    const there = await memberOf("WEB");
    expect(here.isMember, "fixture: the member is on ENG").toBe(true);
    expect(there.isMember, "fixture: the member is on WEB").toBe(true);

    await actAs(ADMIN);
    const set = await setProjectMemberDesignation({
      projectId: here.project.id,
      userId: here.user.id,
      designation: "QA",
    });
    expect(set.ok, set.ok ? "" : set.error).toBe(true);
    touched.push({ projectId: here.project.id, userId: here.user.id });

    const person = await asCurrentUser(MEMBER);

    expect(await projectDisplayRoleOf(person, here.project.id)).toBe("QA");
    /*
     * The other project never heard about it. Without a per-membership column
     * this could not be true at all — there would be one answer for the person
     * and both projects would read it.
     */
    expect(await projectDisplayRoleOf(person, there.project.id)).not.toBe("QA");
  });

  it("changes nothing about what they may do", async () => {
    /*
     * The claim that keeps this safe. `workRoleOf` is what every guard in Prio
     * consults, and it reads the account role and the work teams — not this
     * column. Somebody called QA on a project is still whatever they were to
     * `canSetStatus`, `allowedStatusesFor` and the rest.
     */
    const here = await memberOf("ENG");
    const person = await asCurrentUser(MEMBER);
    const before = await workRoleOf(person);

    await actAs(ADMIN);
    await setProjectMemberDesignation({
      projectId: here.project.id,
      userId: here.user.id,
      designation: "FULLSTACK",
    });
    touched.push({ projectId: here.project.id, userId: here.user.id });

    expect(await workRoleOf(person)).toBe(before);
    /* And the display answer did move, so this is not a test that nothing
       happened. */
    expect(await projectDisplayRoleOf(person, here.project.id)).toBe("FULLSTACK");
  });

  it("clears back to their organisation-wide badge", async () => {
    const here = await memberOf("ENG");
    const person = await asCurrentUser(MEMBER);

    await actAs(ADMIN);
    await setProjectMemberDesignation({
      projectId: here.project.id,
      userId: here.user.id,
      designation: "QA",
    });
    touched.push({ projectId: here.project.id, userId: here.user.id });

    const cleared = await setProjectMemberDesignation({
      projectId: here.project.id,
      userId: here.user.id,
      designation: null,
    });
    expect(cleared.ok).toBe(true);

    const row = await prisma.projectMember.findUniqueOrThrow({
      where: {
        projectId_userId: { projectId: here.project.id, userId: here.user.id },
      },
      select: { designation: true },
    });
    expect(row.designation).toBeNull();

    /* Which is what every membership read before the column existed: whatever
       they are across Prio. */
    expect(await projectDisplayRoleOf(person, here.project.id)).not.toBe("QA");
  });
});

describe("who may name it", () => {
  it("refuses a member, whatever the browser sent", async () => {
    const here = await memberOf("ENG");

    await actAs(MEMBER);
    const result = await setProjectMemberDesignation({
      projectId: here.project.id,
      userId: here.user.id,
      designation: "FULLSTACK",
    });

    expect(result.ok).toBe(false);

    const row = await prisma.projectMember.findUniqueOrThrow({
      where: {
        projectId_userId: { projectId: here.project.id, userId: here.user.id },
      },
      select: { designation: true },
    });
    expect(row.designation).toBeNull();
  });

  it("refuses to designate somebody who is not on the project", async () => {
    /* A role for a person who cannot open the work would be a label with
       nothing behind it. */
    const testing = await projectByKey("TES");
    const outsider = await prisma.user.findUniqueOrThrow({
      where: { email: MEMBER },
      select: { id: true },
    });

    const membership = await prisma.projectMember.findUnique({
      where: {
        projectId_userId: { projectId: testing.id, userId: outsider.id },
      },
      select: { id: true },
    });
    expect(membership, "fixture: this member is not on Testing").toBeNull();

    await actAs(ADMIN);
    const result = await setProjectMemberDesignation({
      projectId: testing.id,
      userId: outsider.id,
      designation: "QA",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/not a member/i);
  });
});

describe("an administrator", () => {
  it("reads as an administrator on every project, designation or not", async () => {
    /* There is no project an administrator is less than that on, and a screen
       saying otherwise would misdescribe what they can actually do. */
    const admin = await asCurrentUser(ADMIN);
    const engineering = await projectByKey("ENG");
    const website = await projectByKey("WEB");

    expect(await projectDisplayRoleOf(admin, engineering.id)).toBe("ADMIN");
    expect(await projectDisplayRoleOf(admin, website.id)).toBe("ADMIN");
  });
});
