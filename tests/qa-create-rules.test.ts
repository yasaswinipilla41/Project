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
 * it into the Backlog and nowhere else. The dialog leaves those fields out and
 * offers the one status; that is the courtesy. This is the rule.
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
    /* Asked of work that is In QA, which is where all five are theirs. Done is
       the verdict and follows testing, so what they are offered elsewhere is
       narrower — see the last cases in this block.

       Ready for QA is absent on purpose: it is the developer's hand-off, and a
       tester who could set it would be handing work to themselves. Sending
       something back is the Backlog, or one of the two verdicts that say it
       was never a defect. */
    expect([...allowedStatusesFor("QA", "IN_QA")]).toEqual([
      "BACKLOG",
      "IN_QA",
      "DONE",
      "REJECTED",
      "CANCELLED",
    ]);
  });

  it("gives a developer the build, and only the build", () => {
    expect([...allowedStatusesFor("DEVELOPER")]).toEqual([
      "TODO",
      "IN_PROGRESS",
      "IN_REVIEW",
    ]);
  });

  it("keeps Reopen to an administrator", () => {
    /* Reopening finished work reverses a completed verdict, which is the
       person who owns the workflow rather than either side of it. */
    for (const role of ["QA", "DEVELOPER", "FULLSTACK"] as const) {
      expect(
        canSetStatus(role, "DONE", "REOPENED"),
        `${role} must not set REOPENED`,
      ).toBe(false);
    }
    expect(canSetStatus("ADMIN", "DONE", "REOPENED")).toBe(true);
  });

  it("keeps the backlog and the two verdicts away from the build", () => {
    /* Deciding what sits in the backlog and writing work off are both things
       testing concludes. A developer does neither. */
    for (const status of ["BACKLOG", "REJECTED", "CANCELLED"] as const) {
      expect(
        canSetStatus("DEVELOPER", "IN_PROGRESS", status),
        `a developer must not set ${status}`,
      ).toBe(false);
      expect(canSetStatus("QA", "IN_PROGRESS", status)).toBe(true);
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
    /* Every status either half owns, and nothing invented for the
       combination: the build's three, and testing's five. */
    for (const status of [
      "TODO",
      "IN_PROGRESS",
      "IN_REVIEW",
      "BACKLOG",
      "IN_QA",
      "DONE",
      "REJECTED",
      "CANCELLED",
    ] as const) {
      expect(both, `${status} is theirs`).toContain(status);
    }
    /* Reopen belongs to neither half, so holding both does not produce it. */
    expect(both).not.toContain("REOPENED");
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
     *   Developer  New, In Progress, Ready for QA
     *   QA         Backlog, In QA, Done, Reject / Not an Issue, Cancelled
     *
     * and Reopen belongs to neither. The two lists are disjoint: Ready for QA
     * is the developer's hand-off and theirs alone, so a tester cannot mark
     * work ready to be tested and then test it.
     */
    const cases = [
      ["DEVELOPER", "TODO", true],
      ["DEVELOPER", "IN_PROGRESS", true],
      ["DEVELOPER", "IN_REVIEW", true],
      ["DEVELOPER", "REOPENED", false],
      ["DEVELOPER", "BACKLOG", false],
      ["DEVELOPER", "IN_QA", false],
      ["DEVELOPER", "DONE", false],
      ["DEVELOPER", "REJECTED", false],
      ["DEVELOPER", "CANCELLED", false],

      ["QA", "BACKLOG", true],
      ["QA", "IN_QA", true],
      ["QA", "REJECTED", true],
      ["QA", "CANCELLED", true],
      ["QA", "IN_REVIEW", false],
      ["QA", "REOPENED", false],
      ["QA", "TODO", false],
      ["QA", "IN_PROGRESS", false],
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

  it("lets a tester file work into the Backlog, and nowhere else", () => {
    /*
     * Filing and moving are separate decisions, and for a pure tester the
     * filing list is narrower than the moving one. A tester raises work into
     * the Backlog: what they file is a request for somebody to pick up, and
     * whether it is next, being built or finished is not theirs to declare at
     * the moment they raise it.
     *
     * One status, so a tester who does not say gets it.
     */
    expect([...filableStatusesFor("QA")]).toEqual(["BACKLOG"]);

    /* Not a way round the verdict rule, round the build, or round the
       hand-off — even though In QA and the two verdicts are statuses this
       person may *set* on work that already exists. */
    for (const status of [
      "TODO",
      "IN_PROGRESS",
      "IN_REVIEW",
      "IN_QA",
      "DONE",
      "REJECTED",
      "CANCELLED",
      "REOPENED",
    ] as const) {
      expect(filableStatusesFor("QA")).not.toContain(status);
    }

    /* Everybody who builds files in whatever their own half may set, which is
       unchanged by the tester's rule above. */
    expect([...filableStatusesFor("FULLSTACK")]).toEqual([
      ...allowedStatusesFor("FULLSTACK", null),
    ]);
    expect([...filableStatusesFor("DEVELOPER")]).toEqual([
      ...allowedStatusesFor("DEVELOPER", null),
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
    if (!result.ok) expect(result.error).toMatch(/raise work as|starts/i);
  });

  it("cannot file it into a status it only gets to by being tested", async () => {
    /* In QA is a status this person may *set* — on work that exists and has
       been handed over. Filing something as already being tested skips the
       build and the hand-off both, so raising and moving are asked
       separately and this is the half that refuses. */
    await actAs(TESTER);
    const project = await projectByKey("ENG");
    const title = `Tester files straight into QA ${Date.now()}`;

    const result = await createIssue({
      projectId: project.id,
      type: "BUG",
      title,
      description: "x",
      status: "IN_QA",
      priority: "MEDIUM",
    });

    expect(result.ok).toBe(false);
    expect(await prisma.issue.count({ where: { title } })).toBe(0);
  });

  it("files into the Backlog when it does not say", async () => {
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
    /* Backlog: raising work is asking for it to be picked up, and where it
       goes from there is somebody else's decision. */
    expect(row.status).toBe("BACKLOG");
  });

  it("files without an assignee or a due date, whatever the request says", async () => {
    await actAs(TESTER);
    const project = await projectByKey("ENG");

    const result = await createIssue({
      projectId: project.id,
      type: "BUG",
      title: `Tester tries to hand work out ${Date.now()}`,
      description: "x",
      status: "BACKLOG",
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
        /* Left unsaid on purpose: each of these three files in a different
           status, and the question here is who the reporter is rather than
           what may be filed. Saying "New" would have refused the tester. */
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
