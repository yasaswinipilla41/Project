import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  DEVELOPMENT_TEAM_SLUG,
  FULLSTACK_TEAM_SLUG,
  TESTING_TEAM_SLUG,
} from "@/lib/authz";
import { holdWorkRole, joinProject, joinTestingTeam } from "./helpers";

/**
 * The undo contract the hardened suites rest on.
 *
 * `issue-claim-takeover` and `member-detail` are only deterministic because
 * these helpers put the fixture back exactly as they found it. That is a
 * promise about shared state, and when it breaks it does not break loudly —
 * the suite that made the mess still passes, and some later file inherits a
 * role nobody set and fails for a reason its own assertions never mention.
 *
 * So the promise is tested directly, and against whatever this installation
 * happens to hold rather than an assumed starting point.
 */

const PERSON = "vikram.shetty@symbiosystech.com";
const WORK_SLUGS = [TESTING_TEAM_SLUG, DEVELOPMENT_TEAM_SLUG, FULLSTACK_TEAM_SLUG];

afterAll(async () => {
  await prisma.$disconnect();
});

/** The work teams this person is on right now, as a sorted set. */
async function workTeamsOf(email: string): Promise<string[]> {
  const rows = await prisma.teamMember.findMany({
    where: { user: { email }, team: { slug: { in: WORK_SLUGS } } },
    select: { team: { select: { slug: true } } },
  });
  return rows.map((r) => r.team.slug).sort();
}

describe("holdWorkRole", () => {
  it("puts every work team back the way it found them", async () => {
    const before = await workTeamsOf(PERSON);

    const held = await holdWorkRole(PERSON, "FULLSTACK");
    expect(await workTeamsOf(PERSON)).toEqual([FULLSTACK_TEAM_SLUG]);

    await held.leave();
    expect(await workTeamsOf(PERSON)).toEqual(before);
  });

  it("refuses an administrator, who is one whatever teams they hold", async () => {
    const admin = await prisma.user.findFirstOrThrow({
      where: { role: "ADMIN" },
      select: { email: true },
    });

    await expect(holdWorkRole(admin.email, "DEVELOPER")).rejects.toThrow(
      /administrator/i,
    );
  });
});

describe("joinTestingTeam", () => {
  it("composes with holdWorkRole without stranding the row it added", async () => {
    /*
     * Regression. `leave` deleted the membership by its row id, and
     * `holdWorkRole` clears every work team and writes the previous ones back
     * — new rows, new ids. The undo then matched nothing, the Testing row
     * survived, and the next suite to ask for a developer got a QA member.
     */
    const before = await workTeamsOf(PERSON);

    const tester = await joinTestingTeam(PERSON);
    const held = await holdWorkRole(PERSON, "DEVELOPER");

    await held.leave();
    await tester.leave();

    expect(await workTeamsOf(PERSON)).toEqual(before);
  });
});

describe("joinProject", () => {
  it("adds access when it is missing and takes back only what it added", async () => {
    const project = await prisma.project.findUniqueOrThrow({
      where: { key: "ENG" },
      select: { id: true },
    });
    const person = await prisma.user.findUniqueOrThrow({
      where: { email: PERSON },
      select: { id: true },
    });
    const count = () =>
      prisma.projectMember.count({
        where: { projectId: project.id, userId: person.id },
      });

    const before = await count();

    const joined = await joinProject("ENG", PERSON);
    expect(await count()).toBe(1);

    await joined.leave();
    expect(await count()).toBe(before);
  });
});
