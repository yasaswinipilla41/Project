import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { issueScope } from "@/lib/authz";
import type { CurrentUser } from "@/lib/session";
import { createIssue, updateIssue } from "@/server/issues";
import { completedByFilter } from "@/server/queries/completedWork";
import { listIssues } from "@/server/queries/issues";
import { parseIssueParams } from "@/server/queries/params";
import { actAs, joinTestingTeam, projectByKey } from "./helpers";

/**
 * My Work → Completed.
 *
 * The tile that replaced Bugs. It is one person's finished work, and the list
 * it opens is the same set. What these pin is who a piece of finished work
 * belongs to in the workflow that actually runs:
 *
 *   tester raises it → developer builds it and hands it to QA → it returns to
 *   the tester → the tester closes it
 *
 * Both the developer and the tester completed their half, so it is on both
 * pages. Nobody else's — not a colleague's on the same project, not the
 * administrator's for being able to see it, and not an open issue.
 */

const ADMIN = "admin@symbiosystech.com";
const TESTER = "priya.nair@symbiosystech.com";
const DEVELOPER = "kiran.das@symbiosystech.com";
const BYSTANDER = "vikram.shetty@symbiosystech.com";

const created: string[] = [];
let leaveTestingTeam: () => Promise<void> = async () => {};
let projectId = "";

async function userByEmail(email: string): Promise<CurrentUser> {
  return prisma.user.findUniqueOrThrow({
    where: { email },
    select: {
      id: true,
      name: true,
      email: true,
      image: true,
      role: true,
      jobTitle: true,
      isActive: true,
    },
  });
}

/** What My Work counts, and what the list behind the tile holds. */
async function completedFor(email: string) {
  const user = await userByEmail(email);
  const [count, list] = await Promise.all([
    prisma.issue.findMany({
      where: { ...issueScope(user), ...completedByFilter([user.id]) },
      select: { id: true },
    }),
    listIssues(
      user,
      parseIssueParams({ completedBy: user.id, pageSize: "100" }),
    ),
  ]);
  return {
    counted: count.map((row) => row.id),
    listed: list.rows.map((row) => row.id),
  };
}

beforeAll(async () => {
  ({ leave: leaveTestingTeam } = await joinTestingTeam(TESTER));
  projectId = (await projectByKey("ENG")).id;
  for (const email of [TESTER, DEVELOPER, BYSTANDER]) {
    const person = await userByEmail(email);
    await prisma.projectMember.upsert({
      where: { projectId_userId: { projectId, userId: person.id } },
      update: {},
      create: { projectId, userId: person.id },
    });
  }
});

afterAll(async () => {
  if (created.length > 0) {
    await prisma.notification.deleteMany({ where: { issueId: { in: created } } });
    await prisma.activityLogEntry.deleteMany({
      where: { issueId: { in: created } },
    });
    await prisma.issue.deleteMany({ where: { id: { in: created } } });
  }
  await leaveTestingTeam();
  await prisma.$disconnect();
});

/** The whole round trip, ending in Done. */
async function roundTrip(title: string): Promise<string> {
  const developer = await userByEmail(DEVELOPER);

  await actAs(TESTER);
  const raised = await createIssue({
    projectId,
    type: "BUG",
    title,
    description: "fixture",
    priority: "MEDIUM",
    assigneeId: developer.id,
  });
  if (!raised.ok) throw new Error(raised.error);
  created.push(raised.data.id);

  await actAs(DEVELOPER);
  for (const status of ["IN_PROGRESS", "IN_REVIEW"] as const) {
    const moved = await updateIssue({ issueId: raised.data.id, status });
    if (!moved.ok) throw new Error(moved.error);
  }

  await actAs(TESTER);
  for (const status of ["IN_QA", "DONE"] as const) {
    const moved = await updateIssue({ issueId: raised.data.id, status });
    if (!moved.ok) throw new Error(moved.error);
  }

  return raised.data.id;
}

describe("My Work → Completed", () => {
  it("is the developer's and the tester's, and nobody else's", async () => {
    const done = await roundTrip(`Completed round trip ${Date.now()}`);

    const developer = await completedFor(DEVELOPER);
    const tester = await completedFor(TESTER);
    const bystander = await completedFor(BYSTANDER);

    expect(developer.counted, "the developer handed it to QA").toContain(done);
    expect(tester.counted, "the tester closed it").toContain(done);
    expect(bystander.counted, "same project, did none of it").not.toContain(done);
  });

  it("does not count work that is not finished", async () => {
    const developer = await userByEmail(DEVELOPER);
    await actAs(TESTER);
    const raised = await createIssue({
      projectId,
      type: "BUG",
      title: `Completed still open ${Date.now()}`,
      description: "fixture",
      priority: "MEDIUM",
      assigneeId: developer.id,
    });
    if (!raised.ok) throw new Error(raised.error);
    created.push(raised.data.id);

    await actAs(DEVELOPER);
    await updateIssue({ issueId: raised.data.id, status: "IN_REVIEW" });

    expect((await completedFor(DEVELOPER)).counted).not.toContain(raised.data.id);
    expect((await completedFor(TESTER)).counted).not.toContain(raised.data.id);
  });

  it("does not count work somebody merely raised", async () => {
    /* Raised by the tester, finished by an administrator on the developer's
       behalf. The tester raised it and did nothing else with it. */
    const developer = await userByEmail(DEVELOPER);
    await actAs(TESTER);
    const raised = await createIssue({
      projectId,
      type: "TASK",
      title: `Completed raised only ${Date.now()}`,
      description: "fixture",
      priority: "MEDIUM",
      assigneeId: developer.id,
    });
    if (!raised.ok) throw new Error(raised.error);
    created.push(raised.data.id);

    await actAs(ADMIN);
    const closed = await updateIssue({ issueId: raised.data.id, status: "DONE" });
    expect(closed.ok).toBe(true);

    expect((await completedFor(TESTER)).counted).not.toContain(raised.data.id);
    // Still the developer's: it is assigned to them and it is done.
    expect((await completedFor(DEVELOPER)).counted).toContain(raised.data.id);
    // And the administrator's, who is the one who closed it.
    expect((await completedFor(ADMIN)).counted).toContain(raised.data.id);
  });

  it("opens a list that holds exactly what the tile counts", async () => {
    await roundTrip(`Completed list agrees ${Date.now()}`);

    for (const email of [DEVELOPER, TESTER, BYSTANDER]) {
      const { counted, listed } = await completedFor(email);
      expect(new Set(listed), email).toEqual(new Set(counted));
    }
  });

  it("leaves Home's own Completed figure on its own definition", async () => {
    /* Home counts `assigned to me AND Done`, unchanged. The developer's
       handed-over work has returned to the tester, so it is on My Work's tile
       and — correctly — not on Home's, which is about what they hold. */
    const done = await roundTrip(`Completed vs Home ${Date.now()}`);
    const developer = await userByEmail(DEVELOPER);

    const home = await prisma.issue.count({
      where: {
        ...issueScope(developer),
        assigneeId: developer.id,
        status: "DONE",
        id: done,
      },
    });
    expect(home).toBe(0);
    expect((await completedFor(DEVELOPER)).counted).toContain(done);
  });
});
