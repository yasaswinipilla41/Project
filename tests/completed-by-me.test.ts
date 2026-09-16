import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issueScope } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { createIssue, updateIssue } from "@/server/issues";
import { completedByFilter } from "@/server/queries/completedWork";
import { listIssues } from "@/server/queries/issues";
import { parseIssueParams } from "@/server/queries/params";
import { actAs, joinTestingTeam, projectByKey } from "./helpers";

/**
 * "Completed by me" is mine, whoever asks and whatever they ask for.
 *
 * Two halves, and both are asserted here. The figure on My Work counts finished
 * work the reader actually finished — read from the activity trail, never from
 * who holds the issue — and the list the figure opens is the same query, so the
 * two cannot describe different sets.
 *
 * The part worth being careful about is identity. The tile links to
 * `/issues?completedBy=<id>`, and a URL is something anybody can type; the
 * value is therefore ignored in favour of the session's. An administrator is
 * not an exception: their personal tile is their own work, not the
 * organisation's total.
 */

const ADMIN = "admin@symbiosystech.com";
const USER_A = "priya.nair@symbiosystech.com";
const USER_B = "sneha.iyer@symbiosystech.com";

const created: string[] = [];
const leaves: (() => Promise<void>)[] = [];
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

/** What My Work's tile counts, for this reader. */
async function countedFor(user: CurrentUser): Promise<number> {
  return prisma.issue.count({
    where: { ...issueScope(user), ...completedByFilter([user.id]) },
  });
}

/**
 * What the list behind the tile holds — optionally asked for on somebody
 * else's behalf, which is the manipulation this is here to refuse.
 */
async function listedFor(
  user: CurrentUser,
  askFor: string = user.id,
): Promise<string[]> {
  const result = await listIssues(
    user,
    parseIssueParams({ completedBy: askFor, pageSize: "100" }),
  );
  return result.rows.map((row) => row.id);
}

/** An ENG issue carried to Done by `finisher`, which records them as the actor. */
async function completedBy(finisher: string, title: string): Promise<string> {
  await actAs(ADMIN);
  const raised = await createIssue({
    projectId,
    type: "TASK",
    title: `${title} ${Date.now()}-${Math.random()}`,
    description: "fixture",
    priority: "MEDIUM",
    status: "IN_QA",
  });
  if (!raised.ok) throw new Error(raised.error);
  created.push(raised.data.id);

  await actAs(finisher);
  const done = await updateIssue({ issueId: raised.data.id, status: "DONE" });
  if (!done.ok) throw new Error(done.error);

  return raised.data.id;
}

beforeAll(async () => {
  projectId = (await projectByKey("ENG")).id;

  for (const email of [USER_A, USER_B]) {
    const { leave } = await joinTestingTeam(email);
    leaves.push(leave);

    await prisma.projectMember.upsert({
      where: {
        projectId_userId: { projectId, userId: (await userByEmail(email)).id },
      },
      update: {},
      create: { projectId, userId: (await userByEmail(email)).id },
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
  for (const leave of leaves) await leave();
  await prisma.$disconnect();
});

describe("whose completed work it is", () => {
  it("gives each person their own, and only their own", async () => {
    const a = await userByEmail(USER_A);
    const b = await userByEmail(USER_B);

    const finishedByA = await completedBy(USER_A, "A finished this");
    const finishedByB = await completedBy(USER_B, "B finished this");

    const listA = await listedFor(a);
    const listB = await listedFor(b);

    expect(listA).toContain(finishedByA);
    expect(listA).not.toContain(finishedByB);

    expect(listB).toContain(finishedByB);
    expect(listB).not.toContain(finishedByA);
  });

  it("counts exactly what the list it opens holds", async () => {
    await completedBy(USER_A, "A count agrees");

    for (const email of [USER_A, USER_B, ADMIN]) {
      const user = await userByEmail(email);
      const [counted, listed] = await Promise.all([
        countedFor(user),
        listedFor(user),
      ]);
      expect(listed.length, `${email}: the figure and its rows`).toBe(counted);
    }
  });

  it("gives an administrator their own work rather than the organisation's", async () => {
    const admin = await userByEmail(ADMIN);

    const theirs = await completedBy(ADMIN, "Admin finished this");
    const somebodyElses = await completedBy(USER_A, "Admin did not finish this");

    const listed = await listedFor(admin);
    expect(listed).toContain(theirs);
    expect(
      listed,
      "an administrator can see it, which is not the same as having finished it",
    ).not.toContain(somebodyElses);

    /* And it is a long way short of every finished issue in Prio, which is the
       figure this used to be confused with. */
    const everythingDone = await prisma.issue.count({ where: { status: "DONE" } });
    expect(listed.length).toBeLessThan(everythingDone);
  });
});

describe("what does not count", () => {
  it("leaves out work that is not finished", async () => {
    await actAs(ADMIN);
    const raised = await createIssue({
      projectId,
      type: "TASK",
      title: `Still in QA ${Date.now()}`,
      description: "fixture",
      priority: "MEDIUM",
      status: "IN_QA",
    });
    if (!raised.ok) throw new Error(raised.error);
    created.push(raised.data.id);

    /* Touched by A, and not finished by anybody. */
    const a = await userByEmail(USER_A);
    expect(await listedFor(a)).not.toContain(raised.data.id);
  });

  it("leaves out work in a project the reader cannot open", async () => {
    const a = await userByEmail(USER_A);
    const issueId = await completedBy(USER_A, "Finished then locked out");
    expect(await listedFor(a)).toContain(issueId);

    const membership = await prisma.projectMember.findUniqueOrThrow({
      where: { projectId_userId: { projectId, userId: a.id } },
      select: { id: true },
    });
    await prisma.projectMember.delete({ where: { id: membership.id } });

    try {
      expect(
        await listedFor(a),
        "they finished it, and can no longer see the project",
      ).not.toContain(issueId);
      expect(await countedFor(a)).toBe((await listedFor(a)).length);
    } finally {
      await prisma.projectMember.create({
        data: { projectId, userId: a.id },
      });
    }
  });
});

describe("the identity is the server's", () => {
  it("ignores another person's id in the query string", async () => {
    /*
     * The manipulation the tile's URL invites: asking for somebody else's
     * finished work by editing the address. The parameter still switches the
     * filter on — that is what the tile uses it for — but whose work is
     * answered by the session, so A asking for B gets A.
     */
    const a = await userByEmail(USER_A);
    const b = await userByEmail(USER_B);

    const finishedByA = await completedBy(USER_A, "A finished, B asked for");
    const finishedByB = await completedBy(USER_B, "B finished, A asked for");

    const asA = await listedFor(a, b.id);

    expect(asA).toContain(finishedByA);
    expect(asA, "B's work is not A's to read here").not.toContain(finishedByB);
    expect(asA).toEqual(await listedFor(a));
  });

  it("does not let an administrator read somebody else's tile either", async () => {
    const admin = await userByEmail(ADMIN);
    const finishedByA = await completedBy(USER_A, "A finished, admin asked for");

    const asAdmin = await listedFor(admin, (await userByEmail(USER_A)).id);
    expect(asAdmin).not.toContain(finishedByA);
    expect(asAdmin).toEqual(await listedFor(admin));
  });
});
