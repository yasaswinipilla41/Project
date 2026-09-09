import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  allowedStatusesFor,
  canSetStatus,
  filableStatusesFor,
} from "@/lib/domain";
import { DEVELOPMENT_TEAM_SLUG, TESTING_TEAM_SLUG } from "@/lib/authz";
import { createIssue } from "@/server/issues";
import { actAs, projectByKey } from "./helpers";

/**
 * What a tester may file, and with what on it.
 *
 * Two rules, both asserted against the server rather than the form: a tester
 * raises work without handing it to anybody and without dating it, and files
 * it in a status their half of the job owns. The dialog leaves those fields
 * out and offers the four statuses; that is the courtesy. This is the rule.
 */

const ADMIN = "admin@symbiosystech.com";
const TESTER = "priya.nair@symbiosystech.com";
const FULLSTACK = "meera.pillai@symbiosystech.com";
const DEVELOPER = "kiran.das@symbiosystech.com";

const created: string[] = [];
const memberships: string[] = [];
/** Rows this file took away to make somebody a pure tester, put back after. */
const suspended: { teamId: string; userId: string }[] = [];

async function join(email: string, slug: string): Promise<void> {
  const [user, team] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } }),
    prisma.team.findUniqueOrThrow({ where: { slug }, select: { id: true } }),
  ]);
  const row = await prisma.teamMember.upsert({
    where: { teamId_userId: { teamId: team.id, userId: user.id } },
    update: {},
    create: { teamId: team.id, userId: user.id },
    select: { id: true },
  });
  memberships.push(row.id);
}

/**
 * Takes somebody off a team for the run, and remembers to put them back.
 *
 * The tester here has to be a *pure* tester, and team rows are shared state
 * that other suites add to. A membership left behind by an interrupted run
 * would quietly make this person full stack, and every rule below would then
 * be asserted against the wrong role and pass or fail for the wrong reason.
 */
async function leaveFor(email: string, slug: string): Promise<void> {
  const [user, team] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } }),
    prisma.team.findUniqueOrThrow({ where: { slug }, select: { id: true } }),
  ]);
  const existing = await prisma.teamMember.findFirst({
    where: { teamId: team.id, userId: user.id },
    select: { id: true },
  });
  if (!existing) return;

  await prisma.teamMember.delete({ where: { id: existing.id } });
  suspended.push({ teamId: team.id, userId: user.id });
}

beforeAll(async () => {
  await leaveFor(TESTER, DEVELOPMENT_TEAM_SLUG);
  await join(TESTER, TESTING_TEAM_SLUG);
  await join(FULLSTACK, TESTING_TEAM_SLUG);
  await join(FULLSTACK, DEVELOPMENT_TEAM_SLUG);
});

afterAll(async () => {
  if (created.length > 0) {
    await prisma.notification.deleteMany({ where: { issueId: { in: created } } });
    await prisma.issue.deleteMany({ where: { id: { in: created } } });
  }
  await prisma.teamMember.deleteMany({ where: { id: { in: memberships } } });
  for (const row of suspended) {
    await prisma.teamMember.upsert({
      where: { teamId_userId: { teamId: row.teamId, userId: row.userId } },
      update: {},
      create: { teamId: row.teamId, userId: row.userId },
    });
  }
  await prisma.$disconnect();
});

async function userId(email: string): Promise<string> {
  const row = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: { id: true },
  });
  return row.id;
}

describe("the statuses each job may set", () => {
  it("gives a tester what testing uses, and nothing of the build", () => {
    /* Asked of work that is In QA, which is where all four are theirs. Done is
       the verdict and follows testing, so what they are offered elsewhere is
       narrower — see the last cases in this block.

       Reject / Not an Issue and Cancelled are absent on purpose: writing work
       off is an administrator's call, not a verdict testing reaches. */
    expect([...allowedStatusesFor("QA", "IN_QA")]).toEqual([
      "IN_REVIEW",
      "IN_QA",
      "DONE",
      "REOPENED",
    ]);
  });

  it("gives a developer the build, and only the build", () => {
    expect([...allowedStatusesFor("DEVELOPER")]).toEqual([
      "TODO",
      "IN_PROGRESS",
      "IN_REVIEW",
      "REOPENED",
    ]);
  });

  it("keeps Backlog, Reject and Cancel to an administrator", () => {
    /* Planning what sits in the backlog, and writing work off, belong to
       neither half of the job. */
    for (const role of ["QA", "DEVELOPER", "FULLSTACK"] as const) {
      for (const status of ["BACKLOG", "REJECTED", "CANCELLED"] as const) {
        expect(
          canSetStatus(role, "IN_PROGRESS", status),
          `${role} must not set ${status}`,
        ).toBe(false);
      }
    }
    for (const status of ["BACKLOG", "REJECTED", "CANCELLED"] as const) {
      expect(canSetStatus("ADMIN", "IN_PROGRESS", status)).toBe(true);
    }
  });

  it("gives an administrator every status", () => {
    expect(allowedStatusesFor("ADMIN")).toHaveLength(9);
    for (const status of ["REJECTED", "CANCELLED", "IN_QA", "DONE"] as const) {
      expect(canSetStatus("ADMIN", "BACKLOG", status)).toBe(true);
    }
  });

  it("gives somebody who does both halves the union of them", () => {
    const both = allowedStatusesFor("FULLSTACK", "IN_QA");
    for (const status of [
      "TODO",
      "IN_PROGRESS",
      "IN_REVIEW",
      "IN_QA",
      "DONE",
    ] as const) {
      expect(both, `${status} is theirs`).toContain(status);
    }
    /* Reopen is in both halves: a developer reopens work that came back, and a
       tester reopens what failed verification. */
    expect(both).toContain("REOPENED");
    /* Writing work off is still neither's, and nor is the backlog. */
    expect(both).not.toContain("REJECTED");
    expect(both).not.toContain("CANCELLED");
    expect(both).not.toContain("BACKLOG");
  });

  it("holds Done back until testing has happened, for a tester alone", () => {
    expect(canSetStatus("QA", "IN_REVIEW", "DONE")).toBe(false);
    expect(canSetStatus("QA", "IN_QA", "DONE")).toBe(true);
    // Somebody who also builds keeps the direct route, as does an admin.
    expect(canSetStatus("FULLSTACK", "IN_REVIEW", "DONE")).toBe(true);
    expect(canSetStatus("ADMIN", "IN_REVIEW", "DONE")).toBe(true);
  });

  it("holds it back at creation too, where nothing has been tested at all", () => {
    /* `current` is null when work is being filed. Filing something as already
       finished is the same skip as moving it there from In QA. */
    expect(canSetStatus("QA", null, "DONE")).toBe(false);

    // Everybody else moves work as they always did.
    expect(canSetStatus("ADMIN", null, "DONE")).toBe(true);
    expect(canSetStatus("FULLSTACK", null, "DONE")).toBe(true);
  });

  it("is exactly the approved matrix, for both halves", () => {
    /*
     * The whole rule in one place, so a change that satisfies one case by
     * breaking another fails here rather than somewhere downstream.
     *
     *   Developer  New, In Progress, Ready for QA, Reopen
     *   QA         Ready for QA, In QA, Done, Reopen
     *
     * and Backlog, Reject / Not an Issue and Cancelled belong to neither.
     */
    const cases = [
      ["DEVELOPER", "TODO", true],
      ["DEVELOPER", "IN_PROGRESS", true],
      ["DEVELOPER", "IN_REVIEW", true],
      ["DEVELOPER", "REOPENED", true],
      ["DEVELOPER", "BACKLOG", false],
      ["DEVELOPER", "IN_QA", false],
      ["DEVELOPER", "DONE", false],
      ["DEVELOPER", "REJECTED", false],
      ["DEVELOPER", "CANCELLED", false],

      ["QA", "IN_REVIEW", true],
      ["QA", "IN_QA", true],
      ["QA", "REOPENED", true],
      ["QA", "BACKLOG", false],
      ["QA", "TODO", false],
      ["QA", "IN_PROGRESS", false],
      ["QA", "REJECTED", false],
      ["QA", "CANCELLED", false],
    ] as const;

    for (const [role, status, allowed] of cases) {
      expect(
        canSetStatus(role, "IN_QA", status),
        `${role} ${allowed ? "may" : "may not"} set ${status}`,
      ).toBe(allowed);
    }

    /* Done is a tester's, once testing has happened — which is the one case
       that depends on where the issue currently is. */
    expect(canSetStatus("QA", "IN_QA", "DONE")).toBe(true);
    expect(canSetStatus("QA", "IN_REVIEW", "DONE")).toBe(false);
  });

  it("lets a tester file work as New, which is what raising work means", () => {
    /*
     * Filing and moving are separate decisions. A tester raises work for
     * somebody to pick up, and in Prio's workflow that arrives as New — so New
     * is filable by anybody who may raise work at all, on top of the statuses
     * their own half may set.
     *
     * New is also the first of them, so a tester who does not say gets it.
     */
    const tester = filableStatusesFor("QA");
    expect(tester[0]).toBe("TODO");
    expect(tester).toContain("TODO");

    /* Still not a way round the verdict rule, or round the build. */
    expect(tester).not.toContain("DONE");
    expect(tester).not.toContain("IN_PROGRESS");
    expect(tester).not.toContain("BACKLOG");

    /* Everybody who builds already had New, so nothing changes for them. */
    expect([...filableStatusesFor("FULLSTACK")]).toEqual([
      ...allowedStatusesFor("FULLSTACK", null),
    ]);
    expect(filableStatusesFor("ADMIN")).toHaveLength(9);
  });
});

describe("a tester filing work", () => {
  it("cannot file it as already finished", async () => {
    await actAs(TESTER);
    const project = await projectByKey("ENG");
    const title = `Tester files work as done ${Date.now()}`;

    const result = await createIssue({
      projectId: project.id,
      type: "BUG",
      title,
      description: "x",
      status: "DONE",
      priority: "MEDIUM",
    });

    expect(result.ok).toBe(false);
    /* The verdict rule answers this one: Done follows testing, so it is
       refused in those terms rather than as an unavailable status. */
    if (!result.ok) expect(result.error).toMatch(/testing concluded|In QA/i);

    // Refused means nothing was written — this run's title, not the prefix,
    // so debris from any other run cannot decide the answer.
    expect(await prisma.issue.count({ where: { title } })).toBe(0);
  });

  it("cannot file it into a status the build owns", async () => {
    await actAs(TESTER);
    const project = await projectByKey("ENG");

    const result = await createIssue({
      projectId: project.id,
      type: "BUG",
      title: `Tester files straight into progress ${Date.now()}`,
      description: "x",
      status: "IN_PROGRESS",
      priority: "MEDIUM",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/move work to|someone else/i);
  });

  it("files as New when it does not say", async () => {
    await actAs(TESTER);
    const project = await projectByKey("ENG");

    const result = await createIssue({
      projectId: project.id,
      type: "BUG",
      title: `Tester files without a status ${Date.now()}`,
      description: "x",
      priority: "MEDIUM",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    created.push(result.data.id);

    const row = await prisma.issue.findUniqueOrThrow({
      where: { id: result.data.id },
      select: { status: true },
    });
    /* New, not Backlog: raising work means somebody has yet to pick it up,
       which is what New says. Deciding what sits in the backlog is planning,
       and that is an administrator's. */
    expect(row.status).toBe("TODO");
  });

  it("files without an assignee or a due date, whatever the request says", async () => {
    await actAs(TESTER);
    const project = await projectByKey("ENG");

    const result = await createIssue({
      projectId: project.id,
      type: "BUG",
      title: `Tester tries to hand work out ${Date.now()}`,
      description: "x",
      status: "TODO",
      priority: "MEDIUM",
      // Exactly what a stale form, or a forged request, would carry.
      assigneeId: await userId(DEVELOPER),
      dueDate: "2099-03-01",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    created.push(result.data.id);

    const row = await prisma.issue.findUniqueOrThrow({
      where: { id: result.data.id },
      select: { assigneeId: true, dueDate: true, reporterId: true },
    });

    expect(row.assigneeId).toBeNull();
    expect(row.dueDate).toBeNull();
    // …and the reporter is the person who filed it.
    expect(row.reporterId).toBe(await userId(TESTER));
  });

  it("keeps both fields for an administrator", async () => {
    await actAs(ADMIN);
    const project = await projectByKey("ENG");
    const assignee = await userId(DEVELOPER);

    const result = await createIssue({
      projectId: project.id,
      type: "TASK",
      title: `Admin files with an assignee ${Date.now()}`,
      description: "x",
      priority: "MEDIUM",
      assigneeId: assignee,
      dueDate: "2099-03-01",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    created.push(result.data.id);

    const row = await prisma.issue.findUniqueOrThrow({
      where: { id: result.data.id },
      select: { assigneeId: true, dueDate: true },
    });
    expect(row.assigneeId).toBe(assignee);
    expect(row.dueDate).not.toBeNull();
  });

  it("keeps both fields for somebody who builds as well as tests", async () => {
    await actAs(FULLSTACK);
    const project = await projectByKey("ENG");
    const assignee = await userId(FULLSTACK);

    const result = await createIssue({
      projectId: project.id,
      type: "TASK",
      title: `Full stack files with an assignee ${Date.now()}`,
      description: "x",
      priority: "MEDIUM",
      assigneeId: assignee,
      dueDate: "2099-03-01",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    created.push(result.data.id);

    const row = await prisma.issue.findUniqueOrThrow({
      where: { id: result.data.id },
      select: { assigneeId: true, dueDate: true },
    });
    expect(row.assigneeId).toBe(assignee);
    expect(row.dueDate).not.toBeNull();
  });
});

describe("the reporter", () => {
  it("is whoever filed the work, for every role that may file", async () => {
    for (const email of [ADMIN, TESTER, FULLSTACK]) {
      await actAs(email);
      const project = await projectByKey("ENG");

      const result = await createIssue({
        projectId: project.id,
        type: "TASK",
        title: `Reporter check ${email} ${Date.now()}`,
        description: "x",
        status: "TODO",
        priority: "MEDIUM",
        /* A payload naming somebody else changes nothing: there is no field
           for it, and the reporter is read from the session. */
        reporterId: await userId(DEVELOPER),
      } as unknown as Parameters<typeof createIssue>[0]);

      expect(result.ok, `${email} may file`).toBe(true);
      if (!result.ok) continue;
      created.push(result.data.id);

      const row = await prisma.issue.findUniqueOrThrow({
        where: { id: result.data.id },
        select: { reporterId: true },
      });
      expect(row.reporterId, `${email} is the reporter`).toBe(
        await userId(email),
      );
    }
  });
});
