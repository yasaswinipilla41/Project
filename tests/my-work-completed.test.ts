import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { issueScope } from "@/lib/authz";
import type { CurrentUser } from "@/lib/session";
import { createIssue, updateIssue } from "@/server/issues";
import { completedAssignedFilter } from "@/server/queries/completedWork";
import { listIssues } from "@/server/queries/issues";
import { parseIssueParams } from "@/server/queries/params";
import { actAs, joinTestingTeam, projectByKey } from "./helpers";

/**
 * My Work → Completed.
 *
 * The figure a developer reads beside Open, Overdue and Due this week, and it
 * is the same rule as those three with Done as its category:
 *
 *     assigned to me   AND   status is DONE
 *
 * Which is to say it is about the work that is *mine*, not about what I once
 * moved. It used to read the activity trail and count what this person had
 * moved to Done, so a developer holding three finished issues saw a figure
 * that answered a question they had not asked: work a colleague or an
 * administrator closed was missing from it, and work they had handed on and
 * no longer held was counted in it. This file pins the rule that replaced
 * that, in the cases it turns on — who holds the work, what its status is,
 * and both of those changing.
 *
 * The other question is still asked elsewhere and still answered from the
 * trail: the issue list's Completed by filter credits whoever moved the work,
 * and the last test here holds the two apart.
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

/**
 * What My Work's Completed tile counts, and what the list beneath it holds.
 *
 * One clause, asked twice — the page counts it and selects on it, which is
 * why a count and its own rows cannot describe different sets.
 */
async function completedFor(email: string) {
  const user = await userByEmail(email);
  const where = { ...issueScope(user), ...completedAssignedFilter([user.id]) };
  const [counted, rows] = await Promise.all([
    prisma.issue.count({ where }),
    prisma.issue.findMany({ where, select: { id: true } }),
  ]);
  return { counted, ids: rows.map((row) => row.id) };
}

/** What the issue list's Completed by filter holds — the other question. */
async function finishedBy(email: string): Promise<string[]> {
  const user = await userByEmail(email);
  const result = await listIssues(
    user,
    parseIssueParams({ completedBy: user.id, pageSize: "100" }),
  );
  return result.rows.map((row) => row.id);
}

/**
 * An ENG issue assigned to somebody, raised by the administrator.
 *
 * The administrator raises it because these fixtures are about who *holds*
 * finished work rather than about the workflow that finished it — and only a
 * tester or an administrator may put work into QA or mark it done, so anybody
 * else raising it would be a permission test by accident.
 */
async function anIssue(title: string, assigneeId: string): Promise<string> {
  await actAs(ADMIN);
  const raised = await createIssue({
    projectId,
    type: "TASK",
    title: `${title} ${Date.now()}`,
    description: "fixture",
    priority: "MEDIUM",
    status: "TODO",
    assigneeId,
  });
  if (!raised.ok) throw new Error(raised.error);
  created.push(raised.data.id);
  return raised.data.id;
}

/** Who holds an issue now — read, never assumed. */
async function holderOf(issueId: string): Promise<string | null> {
  const row = await prisma.issue.findUniqueOrThrow({
    where: { id: issueId },
    select: { assigneeId: true },
  });
  return row.assigneeId;
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
    await prisma.notification.deleteMany({
      where: { issueId: { in: created } },
    });
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
  it("counts finished work for whoever holds it, and for nobody else", async () => {
    /*
     * The workflow as it runs: a tester raises it, the developer builds it
     * and hands it to QA — which hands the issue over with it, so the tester
     * is holding it by the time they close it.
     *
     * Who that leaves holding the work is read from the row rather than
     * assumed here, because the hand-off is `updateIssue`'s to decide and
     * this test is about the figure, not about the transfer. Whoever it is,
     * the finished work is on their page and on nobody else's.
     */
    const done = await roundTrip(`Completed round trip ${Date.now()}`);
    const holder = await holderOf(done);

    const people = {
      [(await userByEmail(DEVELOPER)).id]: await completedFor(DEVELOPER),
      [(await userByEmail(TESTER)).id]: await completedFor(TESTER),
      [(await userByEmail(BYSTANDER)).id]: await completedFor(BYSTANDER),
    };

    expect(holder, "somebody holds it").not.toBeNull();
    for (const [id, seen] of Object.entries(people)) {
      if (id === holder) {
        expect(seen.ids, "the person holding it").toContain(done);
      } else {
        expect(seen.ids, `${id} does not hold it`).not.toContain(done);
      }
    }
  });

  it("counts their own work whoever finished it", async () => {
    /* Assigned to the developer, closed by an administrator. The developer
       never touched it — and it is still three hours of their work that is
       done, which is what the tile beside Open is asked about. This is the
       case the old rule dropped. */
    const developer = await userByEmail(DEVELOPER);
    const id = await anIssue("Completed by somebody else", developer.id);

    await actAs(ADMIN);
    expect((await updateIssue({ issueId: id, status: "DONE" })).ok).toBe(true);

    expect((await completedFor(DEVELOPER)).ids).toContain(id);
    expect(
      (await completedFor(ADMIN)).ids,
      "the administrator finished it; it is not theirs to show",
    ).not.toContain(id);
  });

  it("does not count work that is not finished", async () => {
    const developer = await userByEmail(DEVELOPER);
    const id = await anIssue("Completed still open", developer.id);

    await actAs(DEVELOPER);
    await updateIssue({ issueId: id, status: "IN_REVIEW" });

    expect((await completedFor(DEVELOPER)).ids).not.toContain(id);
  });

  it("does not count work that was closed without being finished", async () => {
    /* Rejected is "not an issue" and cancelled is work abandoned. Both close
       an issue and neither finished it, which is the rule every other
       completed figure in Prio keeps. */
    const developer = await userByEmail(DEVELOPER);

    for (const status of ["REJECTED", "CANCELLED"] as const) {
      const id = await anIssue(`Completed ${status}`, developer.id);
      await actAs(ADMIN);
      expect((await updateIssue({ issueId: id, status })).ok).toBe(true);
      expect((await completedFor(DEVELOPER)).ids, status).not.toContain(id);
    }
  });

  it("follows the work when it is reassigned", async () => {
    /* Finished, then handed to somebody else. It leaves the figure of the
       person who no longer holds it and joins the figure of the person who
       does — with nothing stored and nothing to recount, because the tile is
       this clause asked again. */
    const developer = await userByEmail(DEVELOPER);
    const bystander = await userByEmail(BYSTANDER);
    const id = await anIssue("Completed then reassigned", developer.id);

    await actAs(ADMIN);
    await updateIssue({ issueId: id, status: "DONE" });
    expect((await completedFor(DEVELOPER)).ids).toContain(id);

    await updateIssue({ issueId: id, assigneeId: bystander.id });

    expect((await completedFor(DEVELOPER)).ids).not.toContain(id);
    expect((await completedFor(BYSTANDER)).ids).toContain(id);
  });

  it("follows the status when finished work is reopened", async () => {
    const developer = await userByEmail(DEVELOPER);
    const id = await anIssue("Completed then reopened", developer.id);

    await actAs(ADMIN);
    await updateIssue({ issueId: id, status: "DONE" });
    const before = await completedFor(DEVELOPER);
    expect(before.ids).toContain(id);

    await updateIssue({ issueId: id, status: "REOPENED" });
    const after = await completedFor(DEVELOPER);
    expect(after.ids).not.toContain(id);
    /* And the figure moved with it: the count is the clause, not a stored
       number. */
    expect(after.counted).toBe(before.counted - 1);

    /* Finished again, and it is back. */
    await updateIssue({ issueId: id, status: "DONE" });
    expect((await completedFor(DEVELOPER)).ids).toContain(id);
  });

  it("counts exactly what the list beneath it holds", async () => {
    await roundTrip(`Completed list agrees ${Date.now()}`);

    for (const email of [DEVELOPER, TESTER, BYSTANDER]) {
      const { counted, ids } = await completedFor(email);
      expect(ids.length, `${email}: the figure and its rows`).toBe(counted);
    }
  });

  it("agrees with Home's own Completed figure, which asks the same thing", async () => {
    /* The two pages used to answer one word differently — Home counted the
       work somebody holds that is done, My Work counted what they had moved.
       They read one fragment now, so they cannot drift again. */
    const developer = await userByEmail(DEVELOPER);
    const id = await anIssue("Completed vs Home", developer.id);
    await actAs(ADMIN);
    await updateIssue({ issueId: id, status: "DONE" });

    /* Home's clause, written out here rather than imported, so this compares
       two independently expressed answers rather than one fragment with
       itself. */
    const home = await prisma.issue.findMany({
      where: {
        ...issueScope(developer),
        assigneeId: developer.id,
        status: "DONE",
      },
      select: { id: true },
    });
    const mine = await completedFor(DEVELOPER);

    expect(mine.counted).toBe(home.length);
    expect(new Set(mine.ids)).toEqual(new Set(home.map((row) => row.id)));
    expect(mine.ids, "the issue this test finished").toContain(id);
  });

  it("leaves the issue list's Completed by filter on its own definition", async () => {
    /* "What is mine and done" and "what did I finish" are two questions, and
       Prio still asks both. An issue held by the developer and closed by an
       administrator is on the developer's tile and in the administrator's
       Completed by list — each answering the question it was asked. */
    const developer = await userByEmail(DEVELOPER);
    const id = await anIssue("Completed two questions", developer.id);

    await actAs(ADMIN);
    await updateIssue({ issueId: id, status: "DONE" });

    expect((await completedFor(DEVELOPER)).ids).toContain(id);
    expect(await finishedBy(ADMIN)).toContain(id);
    expect(await finishedBy(DEVELOPER)).not.toContain(id);
  });
});
