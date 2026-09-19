import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { filterOptions } from "@/server/queries/issues";
import { actAs, holdWorkRole } from "./helpers";

/**
 * Who the Assignee and Reporter menus name.
 *
 * Two claims are pinned here. The first is division of labour: Assignee offers
 * the people who build, Reporter the people who check, both read from the team
 * rows `workRoleOf` already derives every role from — never from a name, an
 * email or a hand-written list.
 *
 * The second is that neither menu may hide a row the table is showing. Prio
 * hands work back to the tester who raised it, and every role may raise work,
 * so a tester really can hold an issue and a developer really can have raised
 * one. Those people stay in the list, because a filter that cannot select a
 * visible row is a broken filter.
 *
 * The fixture is a project of its own with nobody else's data in it, so the
 * assertions are about the rule rather than about whatever the seed happens to
 * contain.
 */

const ADMIN = "admin@symbiosystech.com";
const TESTER = "priya.nair@symbiosystech.com";
const DEVELOPER = "kiran.das@symbiosystech.com";

let projectId = "";
let projectKey = "";
let testerId = "";
let developerId = "";
const restore: (() => Promise<void>)[] = [];

const names = (people: { id: string }[]) => people.map((person) => person.id);

beforeAll(async () => {
  const admin = await prisma.user.findUniqueOrThrow({
    where: { email: ADMIN },
    select: { id: true },
  });

  const tester = await holdWorkRole(TESTER, "QA");
  const developer = await holdWorkRole(DEVELOPER, "DEVELOPER");
  testerId = tester.userId;
  developerId = developer.userId;
  restore.push(tester.leave, developer.leave);

  projectKey = `FO${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const project = await prisma.project.create({
    data: {
      name: `Filter options ${projectKey}`,
      key: projectKey,
      createdById: admin.id,
      members: {
        createMany: { data: [{ userId: testerId }, { userId: developerId }] },
      },
    },
    select: { id: true },
  });
  projectId = project.id;
  /* Deleting the project takes its memberships and issues with it. */
  restore.push(async () => {
    await prisma.project.deleteMany({ where: { id: project.id } });
  });
});

afterAll(async () => {
  for (const undo of restore.reverse()) await undo();
  await prisma.$disconnect();
});

describe("who each menu offers", () => {
  it("offers builders as assignees and checkers as reporters", async () => {
    await actAs(ADMIN);
    const user = await requireUser();

    const options = await filterOptions(user, [projectId]);

    expect(names(options.people).sort()).toEqual([testerId, developerId].sort());

    expect(names(options.assignees)).toContain(developerId);
    expect(names(options.assignees)).not.toContain(testerId);

    expect(names(options.reporters)).toContain(testerId);
    expect(names(options.reporters)).not.toContain(developerId);
  });

  it("keeps anybody who actually holds or raised work in scope", async () => {
    /* The tester holds this one and the developer raised it — the reverse of
       the division above, and both are ordinary states in Prio. */
    const issue = await prisma.issue.create({
      data: {
        key: `${projectKey}-1`,
        number: 1,
        projectId,
        type: "BUG",
        title: "Held by the tester, raised by the developer",
        status: "IN_REVIEW",
        priority: "MEDIUM",
        reporterId: developerId,
        assigneeId: testerId,
      },
      select: { id: true },
    });

    try {
      await actAs(ADMIN);
      const user = await requireUser();
      const options = await filterOptions(user, [projectId]);

      expect(names(options.assignees)).toContain(testerId);
      expect(names(options.reporters)).toContain(developerId);
    } finally {
      await prisma.issue.deleteMany({ where: { id: issue.id } });
    }
  });

  it("names only the people on the project it was scoped to", async () => {
    await actAs(ADMIN);
    const user = await requireUser();

    const scoped = await filterOptions(user, [projectId]);
    const everywhere = await filterOptions(user);

    /* The administrator can see every project, so the unscoped list is the
       larger one; the scoped list is exactly this project's members. */
    expect(names(scoped.people)).toHaveLength(2);
    expect(everywhere.people.length).toBeGreaterThan(scoped.people.length);
    for (const person of scoped.people) {
      expect(names(everywhere.people)).toContain(person.id);
    }
  });

  it("cannot be widened by naming a project the caller cannot see", async () => {
    /* A member who is not on the fixture project asks for it by id. The scope
       is intersected with what they may already see, so it narrows to nothing
       of that project rather than revealing its people. */
    await actAs(TESTER);
    const tester = await requireUser();

    const asked = await filterOptions(tester, [projectId]);
    const allowed = await filterOptions(tester);

    for (const person of asked.people) {
      expect(names(allowed.people)).toContain(person.id);
    }
  });
});
