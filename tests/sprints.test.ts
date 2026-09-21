import { afterAll, afterEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createIssue, updateIssue } from "@/server/issues";
import { loadSprintBacklog, loadSprints } from "@/server/queries/sprints";
import {
  addIssuesToSprint,
  completeSprint,
  createSprint,
  moveIssueToSprint,
  removeIssueFromSprint,
  startSprint,
  updateSprint,
} from "@/server/sprints";
import { actAs, deleteIssues, projectByKey } from "./helpers";

/**
 * Sprints: the lifecycle, and the two rules that must not bend.
 *
 *   1. **A sprint can only ever hold its own project's work.** Everything
 *      below that involves an issue from another project asserts that it is
 *      refused — not hidden in the picker, refused by the action, because the
 *      picker is a convenience and the action is the boundary.
 *   2. **A completed sprint keeps its record.** Completing one moves the
 *      unfinished work out of it, so the test that matters is what the sprint
 *      still says about that work afterwards.
 *
 * The lifecycle itself is pinned in order: planned → active → completed, with
 * every invalid step in between asserted to fail rather than silently pass.
 */

const ADMIN = "admin@symbiosystech.com";
/** In Engineering, not in Testing — the same "outsider" the clone tests use. */
const MEMBER = "priya.nair@symbiosystech.com";

const createdIssues: string[] = [];
const createdSprints: string[] = [];
const createdProjects: string[] = [];

/** A sprint next week, so its dates are always valid whenever this runs. */
function dates(offsetDays = 0) {
  const start = new Date();
  start.setDate(start.getDate() + offsetDays);
  const end = new Date(start);
  end.setDate(end.getDate() + 13);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

async function makeSprint(projectId: string, name: string) {
  const result = await createSprint({ projectId, name, goal: "", ...dates() });
  if (!result.ok) throw new Error(`createSprint failed: ${result.error}`);
  createdSprints.push(result.data.id);
  return result.data.id;
}

/**
 * A sprint on dates of the test's choosing, so "which sprint comes next" can
 * be set up deliberately — `makeSprint` puts every sprint on the same dates,
 * which is itself worth testing but cannot express "the one after this".
 */
async function makeSprintOn(
  projectId: string,
  name: string,
  offsetDays: number,
) {
  const result = await createSprint({
    projectId,
    name,
    goal: "",
    ...dates(offsetDays),
  });
  if (!result.ok) throw new Error(`createSprint failed: ${result.error}`);
  createdSprints.push(result.data.id);
  return result.data.id;
}

/** A fresh issue in a project, so no test depends on the seeded backlog. */
async function makeIssue(projectId: string, title: string) {
  const result = await createIssue({ projectId, type: "TASK", title });
  if (!result.ok) throw new Error(`createIssue failed: ${result.error}`);
  const issue = await prisma.issue.findUniqueOrThrow({
    where: { key: result.data.key },
    select: { id: true, key: true },
  });
  createdIssues.push(issue.id);
  return issue;
}

/*
 * Only one sprint runs at a time in a project, which is a rule the tests have
 * to live under too: a test that starts one and leaves it running would stop
 * the next test in that project from starting its own. Anything still active
 * is closed out here, so each test below begins from the same state whatever
 * the one before it did.
 */
afterEach(async () => {
  if (createdSprints.length === 0) return;

  const running = await prisma.sprint.findMany({
    where: { id: { in: createdSprints }, status: "ACTIVE" },
    select: { id: true },
  });
  if (running.length === 0) return;

  await actAs(ADMIN);
  for (const sprint of running) {
    await completeSprint({ sprintId: sprint.id, moveIncompleteTo: "BACKLOG" });
  }
});

afterAll(async () => {
  if (createdSprints.length > 0) {
    await prisma.sprint.deleteMany({ where: { id: { in: createdSprints } } });
  }
  await deleteIssues(createdIssues);
  if (createdProjects.length > 0) {
    await prisma.project.deleteMany({ where: { id: { in: createdProjects } } });
  }
});

/** Distinguishes two fixtures made in the same millisecond. */
let fixtureCount = 0;

/**
 * A project of its own, with only the administrator in it.
 *
 * Every case below that has to *successfully start or complete* a sprint uses
 * one, because "one sprint runs at a time in a project" is a real rule and a
 * shared seeded project like ENG may already have a sprint running in it —
 * left by another suite running concurrently against the same database, or by
 * somebody actually using the application. Those tests were asserting the
 * rule against whatever state they inherited rather than against state they
 * established, which is why they failed depending on what else existed.
 *
 * Only the administrator is a member, which also makes it the right fixture
 * for the opposite question: a project some other person demonstrably cannot
 * open.
 */
async function makeIsolatedProject(): Promise<{ id: string }> {
  const admin = await prisma.user.findUniqueOrThrow({
    where: { email: ADMIN },
    select: { id: true },
  });
  fixtureCount += 1;
  const key = `SP${fixtureCount}${Date.now().toString(36).toUpperCase()}`.slice(
    0,
    10,
  );
  const project = await prisma.project.create({
    data: {
      key,
      name: `Sprint fixture ${key}`,
      createdById: admin.id,
      members: { create: { userId: admin.id } },
    },
    select: { id: true },
  });
  createdProjects.push(project.id);
  return project;
}

describe("Creating a sprint", () => {
  it("records name, goal and dates against the project", async () => {
    await actAs(ADMIN);
    const project = await projectByKey("ENG");
    const { startDate, endDate } = dates(1);

    const result = await createSprint({
      projectId: project.id,
      name: "Sprint alpha",
      goal: "Complete notification module",
      startDate,
      endDate,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdSprints.push(result.data.id);

    const stored = await prisma.sprint.findUniqueOrThrow({
      where: { id: result.data.id },
      select: {
        name: true,
        goal: true,
        status: true,
        projectId: true,
        startDate: true,
        endDate: true,
      },
    });

    expect(stored).toMatchObject({
      name: "Sprint alpha",
      goal: "Complete notification module",
      status: "PLANNED",
      projectId: project.id,
    });
    expect(stored.startDate.getTime()).toBeLessThanOrEqual(
      stored.endDate.getTime(),
    );
  });

  it("refuses an end date before the start date", async () => {
    await actAs(ADMIN);
    const project = await projectByKey("ENG");

    const result = await createSprint({
      projectId: project.id,
      name: "Backwards",
      goal: "",
      startDate: "2026-09-20",
      endDate: "2026-09-07",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fieldErrors?.endDate).toBeTruthy();
    expect(await prisma.sprint.count({ where: { name: "Backwards" } })).toBe(0);
  });

  it("refuses a sprint with no name", async () => {
    await actAs(ADMIN);
    const project = await projectByKey("ENG");

    const result = await createSprint({
      projectId: project.id,
      name: "  ",
      goal: "",
      ...dates(),
    });

    expect(result.ok).toBe(false);
  });

  it("refuses someone with no access to the project", async () => {
    /*
     * A project only the administrator is in, so "no access" is established
     * by this test rather than assumed of a seeded project. This used to name
     * a `TES` project that the seed does not create, so the lookup threw and
     * the assertion below never ran at all.
     */
    await actAs(ADMIN);
    const theirs = await makeIsolatedProject();

    await actAs(MEMBER);
    const before = await prisma.sprint.count();
    const result = await createSprint({
      projectId: theirs.id,
      name: "Not theirs",
      goal: "",
      ...dates(),
    });

    expect(result.ok).toBe(false);
    expect(await prisma.sprint.count()).toBe(before);
  });

  it("keeps the sprint lifecycle with an administrator or the project's creator", async () => {
    /* A member of Engineering can work in it, but did not create it — the same
       `assertProjectManage` rule that governs renaming and deleting a project
       governs starting and completing its sprints. */
    await actAs(ADMIN);
    const project = await projectByKey("ENG");
    const sprintId = await makeSprint(project.id, "Members may not start");
    const issue = await makeIssue(project.id, "Sprint permission fixture");
    await addIssuesToSprint({ sprintId, issueIds: [issue.id] });

    await actAs(MEMBER);
    const start = await startSprint({ sprintId });

    expect(start.ok).toBe(false);
    expect(
      await prisma.sprint.findUniqueOrThrow({
        where: { id: sprintId },
        select: { status: true },
      }),
    ).toMatchObject({ status: "PLANNED" });
  });
});

describe("Adding issues to a sprint", () => {
  it("takes issues from the sprint's own project", async () => {
    await actAs(ADMIN);
    const project = await projectByKey("ENG");
    const sprintId = await makeSprint(project.id, "Sprint with work");
    const first = await makeIssue(project.id, "Sprint work one");
    const second = await makeIssue(project.id, "Sprint work two");

    const result = await addIssuesToSprint({
      sprintId,
      issueIds: [first.id, second.id],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.added).toBe(2);

    expect(await prisma.issue.count({ where: { sprintId } })).toBe(2);
  });

  it("refuses an issue from another project", async () => {
    /*
     * The rule the whole feature turns on. `WEB-…` cannot enter an `ENG`
     * sprint, and the refusal is the server's — the picker never offering it
     * is not what makes this safe.
     */
    await actAs(ADMIN);
    const engineering = await projectByKey("ENG");
    const website = await projectByKey("WEB");

    const sprintId = await makeSprint(engineering.id, "Scoped sprint");
    const outsider = await makeIssue(website.id, "Belongs to Website");

    const result = await addIssuesToSprint({
      sprintId,
      issueIds: [outsider.id],
    });

    // Refused outright, not quietly skipped.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/only issues in this project/i);

    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: outsider.id },
        select: { sprintId: true },
      }),
    ).toMatchObject({ sprintId: null });
  });

  it("refuses the whole batch when one issue is from another project", async () => {
    /*
     * The case a per-id skip would get wrong: two of this project's issues and
     * one outsider. Adding the two and silently dropping the third would
     * report a success that is not the one the caller asked for, so nothing is
     * written at all.
     */
    await actAs(ADMIN);
    const engineering = await projectByKey("ENG");
    const website = await projectByKey("WEB");

    const sprintId = await makeSprint(engineering.id, "All or nothing");
    const ours = await makeIssue(engineering.id, "Ours, and stays in backlog");
    const alsoOurs = await makeIssue(engineering.id, "Also ours");
    const outsider = await makeIssue(website.id, "Not ours at all");

    const result = await addIssuesToSprint({
      sprintId,
      issueIds: [ours.id, alsoOurs.id, outsider.id],
    });

    expect(result.ok).toBe(false);
    // Not one of them moved.
    expect(await prisma.issue.count({ where: { sprintId } })).toBe(0);
  });

  it("refuses an issue id that does not exist", async () => {
    await actAs(ADMIN);
    const project = await projectByKey("ENG");
    const sprintId = await makeSprint(project.id, "No such issue");

    const result = await addIssuesToSprint({
      sprintId,
      issueIds: ["does-not-exist"],
    });

    expect(result.ok).toBe(false);
    expect(await prisma.issue.count({ where: { sprintId } })).toBe(0);
  });

  it("only offers this project's unsprinted open work in the backlog", async () => {
    await actAs(ADMIN);
    const engineering = await projectByKey("ENG");
    const website = await projectByKey("WEB");

    const sprintId = await makeSprint(engineering.id, "Backlog scoping");
    const inSprint = await makeIssue(engineering.id, "Already sprinted");
    const free = await makeIssue(engineering.id, "Still in the backlog");
    const elsewhere = await makeIssue(website.id, "Another project's work");

    await addIssuesToSprint({ sprintId, issueIds: [inSprint.id] });

    const backlog = await loadSprintBacklog(engineering.id);
    const ids = backlog.map((issue) => issue.id);

    expect(ids).toContain(free.id);
    // Already in a sprint, so not backlog any more.
    expect(ids).not.toContain(inSprint.id);
    // Another project's, so never in this list.
    expect(ids).not.toContain(elsewhere.id);
  });

  it("lets a project member fill a sprint, and lets an administrator too", async () => {
    /*
     * Filling a sprint is ordinary work in a project you belong to — every
     * working role may. This used to refuse a plain member outright with
     * "This action requires an administrator.", which was the bug: a
     * Developer, Tester or Full Stack Developer adding work to a sprint they
     * could already see and plan into was turned away by a rule meant for
     * the sprint's own lifecycle, not its contents.
     */
    await actAs(ADMIN);
    const project = await projectByKey("ENG");
    const sprintId = await makeSprint(project.id, "Member fills this");
    const issue = await makeIssue(project.id, "Member's own work");

    await actAs(MEMBER);
    const allowed = await addIssuesToSprint({ sprintId, issueIds: [issue.id] });
    expect(allowed.ok).toBe(true);
    expect(await prisma.issue.count({ where: { sprintId } })).toBe(1);

    const other = await makeIssue(project.id, "Admin's own work");
    await actAs(ADMIN);
    const allowedForAdmin = await addIssuesToSprint({
      sprintId,
      issueIds: [other.id],
    });
    expect(allowedForAdmin.ok).toBe(true);
    expect(await prisma.issue.count({ where: { sprintId } })).toBe(2);
  });

  it("refuses somebody who cannot open the sprint's project at all", async () => {
    /*
     * Filling a sprint is every working role's now, which is exactly why
     * project access still has to be checked here rather than assumed: an
     * administrator sees every project by construction, but a Developer,
     * Tester or Full Stack Developer does not, and nothing about being
     * signed in lets them reach into a project they were never added to.
     */
    await actAs(ADMIN);
    const project = await projectByKey("ENG");
    const sprintId = await makeSprint(project.id, "Not this outsider's to fill");
    const issue = await makeIssue(project.id, "Outsider cannot touch this");

    // Every seeded account is a member of every seeded project, so MEMBER is
    // taken off ENG for the duration of this test and put back afterwards.
    const membership = await prisma.projectMember.findFirstOrThrow({
      where: { projectId: project.id, user: { email: MEMBER } },
    });
    await prisma.projectMember.delete({ where: { id: membership.id } });

    try {
      await actAs(MEMBER);
      const result = await addIssuesToSprint({ sprintId, issueIds: [issue.id] });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/access/i);
      expect(await prisma.issue.count({ where: { sprintId } })).toBe(0);
    } finally {
      await prisma.projectMember.create({
        data: { projectId: project.id, userId: membership.userId },
      });
    }
  });

  it("returns an issue to the backlog when it is removed", async () => {
    await actAs(ADMIN);
    const project = await projectByKey("ENG");
    const sprintId = await makeSprint(project.id, "Remove from me");
    const issue = await makeIssue(project.id, "Taken back out");
    await addIssuesToSprint({ sprintId, issueIds: [issue.id] });

    const result = await removeIssueFromSprint({ sprintId, issueId: issue.id });

    expect(result.ok).toBe(true);
    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: issue.id },
        select: { sprintId: true },
      }),
    ).toMatchObject({ sprintId: null });
  });
});

describe("Starting a sprint", () => {
  it("moves it to ACTIVE once it holds work", async () => {
    await actAs(ADMIN);
    const project = await makeIsolatedProject();
    const sprintId = await makeSprint(project.id, "Ready to start");
    const issue = await makeIssue(project.id, "Something to do");
    await addIssuesToSprint({ sprintId, issueIds: [issue.id] });

    const result = await startSprint({ sprintId });

    expect(result.ok).toBe(true);
    const stored = await prisma.sprint.findUniqueOrThrow({
      where: { id: sprintId },
      select: { status: true, startedAt: true },
    });
    expect(stored.status).toBe("ACTIVE");
    expect(stored.startedAt).not.toBeNull();
  });

  it("refuses an empty sprint", async () => {
    await actAs(ADMIN);
    const project = await projectByKey("ENG");
    const sprintId = await makeSprint(project.id, "Nothing in it");

    const result = await startSprint({ sprintId });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/at least one issue/i);
  });

  it("refuses a second running sprint in the same project", async () => {
    await actAs(ADMIN);
    const project = await makeIsolatedProject();

    const first = await makeSprint(project.id, "First running");
    const firstIssue = await makeIssue(project.id, "Work for the first");
    await addIssuesToSprint({ sprintId: first, issueIds: [firstIssue.id] });
    expect((await startSprint({ sprintId: first })).ok).toBe(true);

    const second = await makeSprint(project.id, "Second running");
    const secondIssue = await makeIssue(project.id, "Work for the second");
    await addIssuesToSprint({ sprintId: second, issueIds: [secondIssue.id] });

    const result = await startSprint({ sprintId: second });

    expect(result.ok).toBe(false);
    expect(
      await prisma.sprint.findUniqueOrThrow({
        where: { id: second },
        select: { status: true },
      }),
    ).toMatchObject({ status: "PLANNED" });

    // Leave the project without a running sprint for the tests after this one.
    await completeSprint({ sprintId: first, moveIncompleteTo: "BACKLOG" });
  });

  it("refuses to start a sprint twice", async () => {
    await actAs(ADMIN);
    const project = await makeIsolatedProject();
    const sprintId = await makeSprint(project.id, "Start me once");
    const issue = await makeIssue(project.id, "Only work");
    await addIssuesToSprint({ sprintId, issueIds: [issue.id] });

    expect((await startSprint({ sprintId })).ok).toBe(true);
    const again = await startSprint({ sprintId });
    expect(again.ok).toBe(false);

    await completeSprint({ sprintId, moveIncompleteTo: "BACKLOG" });
  });
});

describe("An active sprint's figures", () => {
  it("follow the issues' own statuses", async () => {
    await actAs(ADMIN);
    const project = await makeIsolatedProject();
    const sprintId = await makeSprint(project.id, "Progress follows status");

    const issues = await Promise.all([
      makeIssue(project.id, "Progress one"),
      makeIssue(project.id, "Progress two"),
    ]);
    await addIssuesToSprint({
      sprintId,
      issueIds: issues.map((issue) => issue.id),
    });
    await startSprint({ sprintId });

    const before = (await loadSprints(project.id)).find((s) => s.id === sprintId);
    expect(before?.stats).toMatchObject({ total: 2, completed: 0, progress: 0 });

    /* Nothing sprint-specific is written here — the issue is moved through the
       ordinary workflow, and the sprint's figures follow because they are
       counted from `Issue.status` rather than stored. */
    for (const status of ["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"] as const) {
      const update = await updateIssue({ issueId: issues[0]!.id, status });
      expect(update.ok).toBe(true);
    }

    const after = (await loadSprints(project.id)).find((s) => s.id === sprintId);
    expect(after?.stats).toMatchObject({
      total: 2,
      completed: 1,
      remaining: 1,
      progress: 50,
    });

    await completeSprint({ sprintId, moveIncompleteTo: "BACKLOG" });
  });
});

describe("Completing a sprint", () => {
  it("sends unfinished work to the backlog and keeps the finished work", async () => {
    await actAs(ADMIN);
    const project = await makeIsolatedProject();
    const sprintId = await makeSprint(project.id, "Closing to backlog");

    const finished = await makeIssue(project.id, "Will be finished");
    const unfinished = await makeIssue(project.id, "Will not be finished");
    await addIssuesToSprint({
      sprintId,
      issueIds: [finished.id, unfinished.id],
    });
    await startSprint({ sprintId });

    for (const status of ["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"] as const) {
      await updateIssue({ issueId: finished.id, status });
    }

    const result = await completeSprint({
      sprintId,
      moveIncompleteTo: "BACKLOG",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toMatchObject({ completed: 1, moved: 1 });
    }

    // The finished issue stays where it was done; the other returns to the backlog.
    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: finished.id },
        select: { sprintId: true },
      }),
    ).toMatchObject({ sprintId });
    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: unfinished.id },
        select: { sprintId: true },
      }),
    ).toMatchObject({ sprintId: null });

    expect(
      await prisma.sprint.findUniqueOrThrow({
        where: { id: sprintId },
        select: { status: true, completedAt: true },
      }),
    ).toMatchObject({ status: "COMPLETED" });
  });

  it("carries unfinished work into another sprint in the same project", async () => {
    await actAs(ADMIN);
    const project = await makeIsolatedProject();

    const current = await makeSprint(project.id, "Carry from here");
    const next = await makeSprint(project.id, "Carry into here");
    const unfinished = await makeIssue(project.id, "Carried over");

    await addIssuesToSprint({ sprintId: current, issueIds: [unfinished.id] });
    await startSprint({ sprintId: current });

    const result = await completeSprint({
      sprintId: current,
      moveIncompleteTo: "NEXT_SPRINT",
      nextSprintId: next,
    });

    expect(result.ok).toBe(true);
    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: unfinished.id },
        select: { sprintId: true, projectId: true },
      }),
    ).toMatchObject({ sprintId: next, projectId: project.id });
  });

  it("records the carry-over on the issue's own history", async () => {
    /*
     * Being carried out of a sprint is a sprint change on the issue, so it
     * leaves the same trail adding, removing and moving one do. This was the
     * one way an issue's sprint could change silently: the bulk re-pointing
     * at completion wrote no activity, so an issue's history skipped the
     * sprint it had been carried out of.
     */
    await actAs(ADMIN);
    const project = await makeIsolatedProject();

    const current = await makeSprint(project.id, "Carried out of here");
    const next = await makeSprint(project.id, "Carried into here");
    const unfinished = await makeIssue(project.id, "Its history is kept");

    await addIssuesToSprint({ sprintId: current, issueIds: [unfinished.id] });
    await startSprint({ sprintId: current });
    const result = await completeSprint({
      sprintId: current,
      moveIncompleteTo: "NEXT_SPRINT",
      nextSprintId: next,
    });
    expect(result.ok).toBe(true);

    const entry = await prisma.activityLogEntry.findFirst({
      where: { issueId: unfinished.id, field: "sprintId" },
      orderBy: { createdAt: "desc" },
      select: { oldValue: true, newValue: true },
    });

    expect(entry).toMatchObject({
      oldValue: "Carried out of here",
      newValue: "Carried into here",
    });
  });

  it("names the backlog in that history when the work goes nowhere", async () => {
    await actAs(ADMIN);
    const project = await makeIsolatedProject();

    const sprintId = await makeSprint(project.id, "Closed to the backlog");
    const unfinished = await makeIssue(project.id, "Back to the backlog");

    await addIssuesToSprint({ sprintId, issueIds: [unfinished.id] });
    await startSprint({ sprintId });
    expect(
      (await completeSprint({ sprintId, moveIncompleteTo: "BACKLOG" })).ok,
    ).toBe(true);

    const entry = await prisma.activityLogEntry.findFirst({
      where: { issueId: unfinished.id, field: "sprintId" },
      orderBy: { createdAt: "desc" },
      select: { oldValue: true, newValue: true },
    });

    expect(entry).toMatchObject({
      oldValue: "Closed to the backlog",
      newValue: "Backlog",
    });
  });

  it("refuses to carry work into another project's sprint", async () => {
    await actAs(ADMIN);
    /* Two projects of this test's own: the source has to be startable, and
       the destination has to genuinely be somewhere else. */
    const engineering = await makeIsolatedProject();
    const website = await makeIsolatedProject();

    const source = await makeSprint(engineering.id, "Cannot leave its project");
    const foreign = await makeSprint(website.id, "The other project's sprint");
    const unfinished = await makeIssue(engineering.id, "Must stay put");

    await addIssuesToSprint({ sprintId: source, issueIds: [unfinished.id] });
    await startSprint({ sprintId: source });

    const result = await completeSprint({
      sprintId: source,
      moveIncompleteTo: "NEXT_SPRINT",
      nextSprintId: foreign,
    });

    expect(result.ok).toBe(false);
    // Nothing moved, and the sprint is still running.
    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: unfinished.id },
        select: { sprintId: true },
      }),
    ).toMatchObject({ sprintId: source });
    expect(
      await prisma.sprint.findUniqueOrThrow({
        where: { id: source },
        select: { status: true },
      }),
    ).toMatchObject({ status: "ACTIVE" });

    await completeSprint({ sprintId: source, moveIncompleteTo: "BACKLOG" });
  });

  it("keeps its record after the unfinished work has moved on", async () => {
    /*
     * The point of `SprintIssueOutcome`. Once the sprint closes, the issue it
     * did not finish is no longer in it — so if the sprint's report were read
     * from `Issue.sprintId`, the incomplete half of it would vanish. It does
     * not: both issues are still named, and still on the right side.
     */
    await actAs(ADMIN);
    const project = await makeIsolatedProject();
    const sprintId = await makeSprint(project.id, "History keeper");

    const finished = await makeIssue(project.id, "Finished, remembered");
    const unfinished = await makeIssue(project.id, "Unfinished, remembered");
    await addIssuesToSprint({
      sprintId,
      issueIds: [finished.id, unfinished.id],
    });
    await startSprint({ sprintId });

    for (const status of ["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"] as const) {
      await updateIssue({ issueId: finished.id, status });
    }
    await completeSprint({ sprintId, moveIncompleteTo: "BACKLOG" });

    const sprint = (await loadSprints(project.id)).find((s) => s.id === sprintId);
    expect(sprint?.status).toBe("COMPLETED");
    expect(sprint?.outcome?.completed.map((i) => i.id)).toEqual([finished.id]);
    expect(sprint?.outcome?.incomplete.map((i) => i.id)).toEqual([unfinished.id]);
    expect(sprint?.stats).toMatchObject({
      total: 2,
      completed: 1,
      remaining: 1,
      progress: 50,
    });

    // And it stays true when the issue is later finished somewhere else.
    for (const status of ["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"] as const) {
      await updateIssue({ issueId: unfinished.id, status });
    }

    const later = (await loadSprints(project.id)).find((s) => s.id === sprintId);
    expect(later?.outcome?.incomplete.map((i) => i.id)).toEqual([unfinished.id]);
    expect(later?.stats.completed).toBe(1);
  });

  it("refuses to complete a sprint that was never started", async () => {
    await actAs(ADMIN);
    const project = await projectByKey("ENG");
    const sprintId = await makeSprint(project.id, "Never started");

    const result = await completeSprint({
      sprintId,
      moveIncompleteTo: "BACKLOG",
    });

    expect(result.ok).toBe(false);
  });

  it("refuses to change a completed sprint afterwards", async () => {
    await actAs(ADMIN);
    const project = await makeIsolatedProject();
    const sprintId = await makeSprint(project.id, "Sealed");
    const issue = await makeIssue(project.id, "Sealed work");
    await addIssuesToSprint({ sprintId, issueIds: [issue.id] });
    await startSprint({ sprintId });
    await completeSprint({ sprintId, moveIncompleteTo: "BACKLOG" });

    const edit = await updateSprint({
      sprintId,
      name: "Renamed after the fact",
      goal: "",
      ...dates(),
    });
    expect(edit.ok).toBe(false);

    const another = await makeIssue(project.id, "Too late");
    const add = await addIssuesToSprint({ sprintId, issueIds: [another.id] });
    expect(add.ok).toBe(false);

    expect(
      await prisma.sprint.findUniqueOrThrow({
        where: { id: sprintId },
        select: { name: true },
      }),
    ).toMatchObject({ name: "Sealed" });
  });
});

describe("Moving an issue", () => {
  it("moves it to a named sprint in the same project, and leaves its status alone", async () => {
    await actAs(ADMIN);
    const project = await projectByKey("ENG");
    const from = await makeSprint(project.id, "Move source");
    const to = await makeSprint(project.id, "Move destination");
    const issue = await makeIssue(project.id, "Moved between sprints");
    await addIssuesToSprint({ sprintId: from, issueIds: [issue.id] });
    await updateIssue({ issueId: issue.id, status: "IN_PROGRESS" });

    const result = await moveIssueToSprint({
      issueId: issue.id,
      destination: { type: "SPRINT", sprintId: to },
    });

    expect(result.ok).toBe(true);
    const after = await prisma.issue.findUniqueOrThrow({
      where: { id: issue.id },
      select: { sprintId: true, status: true },
    });
    expect(after).toMatchObject({ sprintId: to, status: "IN_PROGRESS" });

    const entry = await prisma.activityLogEntry.findFirst({
      where: { issueId: issue.id, field: "sprintId" },
      orderBy: { createdAt: "desc" },
    });
    expect(entry).toMatchObject({
      oldValue: "Move source",
      newValue: "Move destination",
    });
  });

  /*
   * The figure the sprint details page's chart shows — "Total Issues: n" — is
   * `stats.total`, and nothing stores it. A move has to be visible in both
   * sprints at once: one short, the other long, with the issue's status the
   * same as it was. Counted through `loadSprints`, which is what that page
   * reads, in a project of its own so the numbers are exact.
   */
  it("changes both sprints' issue totals, and neither issue's status", async () => {
    await actAs(ADMIN);
    const project = await makeIsolatedProject();
    const from = await makeSprint(project.id, "Total source");
    const to = await makeSprint(project.id, "Total destination");

    const staying = await makeIssue(project.id, "Stays behind");
    const moving = await makeIssue(project.id, "Moves across");
    await addIssuesToSprint({
      sprintId: from,
      issueIds: [staying.id, moving.id],
    });
    const alreadyThere = await makeIssue(project.id, "Already in the other");
    await addIssuesToSprint({ sprintId: to, issueIds: [alreadyThere.id] });
    await updateIssue({ issueId: moving.id, status: "IN_PROGRESS" });

    const totals = async () => {
      const sprints = await loadSprints(project.id);
      return {
        from: sprints.find((s) => s.id === from)!.stats.total,
        to: sprints.find((s) => s.id === to)!.stats.total,
      };
    };

    expect(await totals()).toEqual({ from: 2, to: 1 });

    const result = await moveIssueToSprint({
      issueId: moving.id,
      destination: { type: "SPRINT", sprintId: to },
    });
    expect(result.ok).toBe(true);

    /* One out of the source, one into the destination — the two figures move
       together because both are counted from the same membership. */
    expect(await totals()).toEqual({ from: 1, to: 2 });

    /* The move is a move. It is not a status change. */
    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: moving.id },
        select: { status: true, sprintId: true },
      }),
    ).toMatchObject({ status: "IN_PROGRESS", sprintId: to });
  });

  /*
   * "Next sprint", and what counts as next.
   *
   * Two sprints planned for the same dates are ordinary, and the rule used to
   * be a strictly later start date — so every same-day sprint was invisible to
   * it and the move was refused with "No future Sprint is available." while the
   * project's own Sprints page listed the sprint it should have offered.
   */
  it("moves it to the next sprint even when that sprint starts the same day", async () => {
    await actAs(ADMIN);
    const project = await makeIsolatedProject();
    /* `makeSprint` puts both on the same dates, which is exactly the case
       that was broken. */
    const first = await makeSprint(project.id, "Same day source");
    const second = await makeSprint(project.id, "Same day destination");
    const issue = await makeIssue(project.id, "Carried to the next sprint");
    await addIssuesToSprint({ sprintId: first, issueIds: [issue.id] });
    await updateIssue({ issueId: issue.id, status: "IN_PROGRESS" });

    const result = await moveIssueToSprint({
      issueId: issue.id,
      destination: { type: "NEXT_SPRINT" },
    });

    expect(result).toMatchObject({ ok: true });
    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: issue.id },
        select: { sprintId: true, status: true },
      }),
      /* Out of the one, into the other, and still In Progress: a move is not
         a status change. */
    ).toMatchObject({ sprintId: second, status: "IN_PROGRESS" });
  });

  it("takes the soonest later sprint when several are open", async () => {
    await actAs(ADMIN);
    const project = await makeIsolatedProject();
    const current = await makeSprintOn(project.id, "Next-of-three current", 0);
    const soonest = await makeSprintOn(project.id, "Next-of-three soonest", 14);
    await makeSprintOn(project.id, "Next-of-three later", 28);
    const issue = await makeIssue(project.id, "Off to the soonest");
    await addIssuesToSprint({ sprintId: current, issueIds: [issue.id] });

    const result = await moveIssueToSprint({
      issueId: issue.id,
      destination: { type: "NEXT_SPRINT" },
    });

    expect(result).toMatchObject({ ok: true });
    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: issue.id },
        select: { sprintId: true },
      }),
    ).toMatchObject({ sprintId: soonest });
  });

  it("still says there is no next sprint when every other open sprint is earlier", async () => {
    await actAs(ADMIN);
    const project = await makeIsolatedProject();
    await makeSprintOn(project.id, "Only earlier one", 0);
    const latest = await makeSprintOn(project.id, "The last sprint there is", 21);
    const issue = await makeIssue(project.id, "Nowhere left to go");
    await addIssuesToSprint({ sprintId: latest, issueIds: [issue.id] });

    const result = await moveIssueToSprint({
      issueId: issue.id,
      destination: { type: "NEXT_SPRINT" },
    });

    /* The message is still the right answer here, and the issue has not
       moved. */
    expect(result).toMatchObject({
      ok: false,
      error: "No future Sprint is available.",
    });
    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: issue.id },
        select: { sprintId: true },
      }),
    ).toMatchObject({ sprintId: latest });
  });

  it("carries an issue out of the backlog into the soonest open sprint", async () => {
    await actAs(ADMIN);
    const project = await makeIsolatedProject();
    const soonest = await makeSprintOn(project.id, "Backlog pickup soonest", 3);
    await makeSprintOn(project.id, "Backlog pickup later", 30);
    const issue = await makeIssue(project.id, "Straight from the backlog");

    const result = await moveIssueToSprint({
      issueId: issue.id,
      destination: { type: "NEXT_SPRINT" },
    });

    expect(result).toMatchObject({ ok: true });
    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: issue.id },
        select: { sprintId: true },
      }),
    ).toMatchObject({ sprintId: soonest });
  });

  /*
   * Restore: back to the sprint the issue came from.
   *
   * The destination is the issue's own note of its last move, so these tests
   * are about that note being right — after one move, after several, and after
   * a restore, which is itself a move and leaves its own note.
   */
  describe("restoring it to the sprint it came from", () => {
    it("puts it back, and leaves everything about the issue alone", async () => {
      await actAs(ADMIN);
      const project = await makeIsolatedProject();
      const from = await makeSprintOn(project.id, "Restore source", 0);
      const to = await makeSprintOn(project.id, "Restore destination", 14);
      const issue = await makeIssue(project.id, "Work that goes back");

      /* The issue as it is before anything moves: these are the facts a move
         must not touch. */
      await addIssuesToSprint({ sprintId: from, issueIds: [issue.id] });
      await updateIssue({
        issueId: issue.id,
        status: "IN_PROGRESS",
        priority: "HIGH",
      });
      const before = await prisma.issue.findUniqueOrThrow({
        where: { id: issue.id },
        select: {
          status: true,
          priority: true,
          assigneeId: true,
          title: true,
          effortHours: true,
        },
      });

      const moved = await moveIssueToSprint({
        issueId: issue.id,
        destination: { type: "SPRINT", sprintId: to },
      });
      expect(moved.ok).toBe(true);

      const restored = await moveIssueToSprint({
        issueId: issue.id,
        destination: { type: "PREVIOUS" },
      });
      expect(restored).toMatchObject({ ok: true });

      const after = await prisma.issue.findUniqueOrThrow({
        where: { id: issue.id },
        select: {
          sprintId: true,
          previousSprintId: true,
          status: true,
          priority: true,
          assigneeId: true,
          title: true,
          effortHours: true,
        },
      });

      /* Back in the sprint it started in, and able to go forward again:
         restoring is a move, so it leaves its own note. */
      expect(after.sprintId).toBe(from);
      expect(after.previousSprintId).toBe(to);

      /* Nothing else about the issue moved. */
      expect({
        status: after.status,
        priority: after.priority,
        assigneeId: after.assigneeId,
        title: after.title,
        effortHours: after.effortHours,
      }).toEqual(before);
    });

    it("tracks the immediately previous sprint across repeated moves", async () => {
      await actAs(ADMIN);
      const project = await makeIsolatedProject();
      const a = await makeSprintOn(project.id, "Chain A", 0);
      const b = await makeSprintOn(project.id, "Chain B", 14);
      const c = await makeSprintOn(project.id, "Chain C", 28);
      const issue = await makeIssue(project.id, "Work that travels");
      await addIssuesToSprint({ sprintId: a, issueIds: [issue.id] });

      const previous = async () =>
        (
          await prisma.issue.findUniqueOrThrow({
            where: { id: issue.id },
            select: { previousSprintId: true },
          })
        ).previousSprintId;

      await moveIssueToSprint({
        issueId: issue.id,
        destination: { type: "SPRINT", sprintId: b },
      });
      expect(await previous()).toBe(a);

      await moveIssueToSprint({
        issueId: issue.id,
        destination: { type: "SPRINT", sprintId: c },
      });
      /* A → B → C: the note is B, the sprint it was *immediately* in, not the
         one it started in. */
      expect(await previous()).toBe(b);

      const restored = await moveIssueToSprint({
        issueId: issue.id,
        destination: { type: "PREVIOUS" },
      });
      expect(restored).toMatchObject({ ok: true, data: { sprintId: b } });
      expect(
        await prisma.issue.findUniqueOrThrow({
          where: { id: issue.id },
          select: { sprintId: true, previousSprintId: true },
        }),
      ).toMatchObject({ sprintId: b, previousSprintId: c });
    });

    it("refuses when the issue has never been moved out of a sprint", async () => {
      await actAs(ADMIN);
      const project = await makeIsolatedProject();
      const only = await makeSprintOn(project.id, "Nowhere to go back to", 0);
      const issue = await makeIssue(project.id, "Never been anywhere");
      await addIssuesToSprint({ sprintId: only, issueIds: [issue.id] });

      const result = await moveIssueToSprint({
        issueId: issue.id,
        destination: { type: "PREVIOUS" },
      });

      /* Nothing to restore to, and the issue stays where it is — the menu
         does not offer Restore here either. */
      expect(result.ok).toBe(false);
      expect(
        await prisma.issue.findUniqueOrThrow({
          where: { id: issue.id },
          select: { sprintId: true },
        }),
      ).toMatchObject({ sprintId: only });
    });

    it("refuses to restore into a sprint that has been completed", async () => {
      await actAs(ADMIN);
      const project = await makeIsolatedProject();
      const from = await makeSprintOn(project.id, "Closed behind it", 0);
      const to = await makeSprintOn(project.id, "Still open", 14);
      const issue = await makeIssue(project.id, "Work with no way back");
      /* A sprint cannot be started empty, and this one has to be startable to
         be completed — so it keeps a second issue of its own after the first
         one leaves. */
      const stays = await makeIssue(project.id, "Work that stays behind");
      await addIssuesToSprint({ sprintId: from, issueIds: [issue.id, stays.id] });
      await moveIssueToSprint({
        issueId: issue.id,
        destination: { type: "SPRINT", sprintId: to },
      });

      /* The sprint it came from is started and closed out behind it. */
      const started = await startSprint({ sprintId: from });
      expect(started.ok).toBe(true);
      const closed = await completeSprint({
        sprintId: from,
        moveIncompleteTo: "BACKLOG",
      });
      expect(closed.ok).toBe(true);

      const result = await moveIssueToSprint({
        issueId: issue.id,
        destination: { type: "PREVIOUS" },
      });

      expect(result.ok).toBe(false);
      expect(
        await prisma.issue.findUniqueOrThrow({
          where: { id: issue.id },
          select: { sprintId: true },
        }),
      ).toMatchObject({ sprintId: to });
    });

    it("carries the issue's totals with it, in both sprints", async () => {
      await actAs(ADMIN);
      const project = await makeIsolatedProject();
      const from = await makeSprintOn(project.id, "Totals source", 0);
      const to = await makeSprintOn(project.id, "Totals destination", 14);
      const issue = await makeIssue(project.id, "One issue, two sprints");
      await addIssuesToSprint({ sprintId: from, issueIds: [issue.id] });

      const totals = async () => {
        const all = await loadSprints(project.id);
        return {
          from: all.find((one) => one.id === from)!.stats.total,
          to: all.find((one) => one.id === to)!.stats.total,
        };
      };

      await moveIssueToSprint({
        issueId: issue.id,
        destination: { type: "SPRINT", sprintId: to },
      });
      expect(await totals()).toEqual({ from: 0, to: 1 });

      await moveIssueToSprint({
        issueId: issue.id,
        destination: { type: "PREVIOUS" },
      });
      /* The figures the sprint page and its Issues by status chart are drawn
         from follow the restore, because nothing stores them. */
      expect(await totals()).toEqual({ from: 1, to: 0 });
    });
  });

  it("moves it to the backlog, clearing its sprint without touching anything else", async () => {
    await actAs(ADMIN);
    const project = await projectByKey("ENG");
    const sprintId = await makeSprint(project.id, "Move to backlog source");
    const issue = await makeIssue(project.id, "Moved to the backlog");
    await addIssuesToSprint({ sprintId, issueIds: [issue.id] });

    const result = await moveIssueToSprint({
      issueId: issue.id,
      destination: { type: "BACKLOG" },
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data).toMatchObject({ sprintId: null });
    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: issue.id },
        select: { sprintId: true },
      }),
    ).toMatchObject({ sprintId: null });
  });

  it("finds the chronologically next open sprint, skipping later ones", async () => {
    await actAs(ADMIN);
    const project = await makeIsolatedProject();
    const current = await makeSprint(project.id, "Next-sprint current");
    const soon = await createSprint({
      projectId: project.id,
      name: `Next-sprint soon ${Date.now()}`,
      goal: "",
      ...dates(30),
    });
    const later = await createSprint({
      projectId: project.id,
      name: `Next-sprint later ${Date.now()}`,
      goal: "",
      ...dates(60),
    });
    if (!soon.ok || !later.ok) throw new Error("fixture sprints failed");
    createdSprints.push(soon.data.id, later.data.id);

    const issue = await makeIssue(project.id, "Wants the next sprint");
    await addIssuesToSprint({ sprintId: current, issueIds: [issue.id] });

    const result = await moveIssueToSprint({
      issueId: issue.id,
      destination: { type: "NEXT_SPRINT" },
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.sprintId).toBe(soon.data.id);
  });

  it("says plainly when no future sprint exists, and does not create one", async () => {
    await actAs(ADMIN);
    const project = await makeIsolatedProject();
    const sprintId = await makeSprint(project.id, "Only sprint in the project");
    const issue = await makeIssue(project.id, "Nowhere further to go");
    await addIssuesToSprint({ sprintId, issueIds: [issue.id] });

    const before = await prisma.sprint.count({ where: { projectId: project.id } });
    const result = await moveIssueToSprint({
      issueId: issue.id,
      destination: { type: "NEXT_SPRINT" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("No future Sprint is available.");
    expect(await prisma.sprint.count({ where: { projectId: project.id } })).toBe(
      before,
    );
    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: issue.id },
        select: { sprintId: true },
      }),
    ).toMatchObject({ sprintId });
  });

  it("refuses to move an issue into another project's sprint", async () => {
    await actAs(ADMIN);
    const engineering = await projectByKey("ENG");
    const website = await projectByKey("WEB");

    const issue = await makeIssue(engineering.id, "Must stay in ENG");
    const foreign = await makeSprint(website.id, "Website's own sprint");

    const result = await moveIssueToSprint({
      issueId: issue.id,
      destination: { type: "SPRINT", sprintId: foreign },
    });

    expect(result.ok).toBe(false);
    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: issue.id },
        select: { sprintId: true },
      }),
    ).toMatchObject({ sprintId: null });
  });

  it("is open to a project member, not only an administrator", async () => {
    /* The same bug `addIssuesToSprint` had: moving an issue between sprints
       is every working role's, not an administrator's alone. */
    await actAs(ADMIN);
    const project = await projectByKey("ENG");
    const sprintId = await makeSprint(project.id, "Member moves this");
    const issue = await makeIssue(project.id, "Member's own work to move");
    await addIssuesToSprint({ sprintId, issueIds: [issue.id] });

    await actAs(MEMBER);
    const result = await moveIssueToSprint({
      issueId: issue.id,
      destination: { type: "BACKLOG" },
    });

    expect(result.ok).toBe(true);
    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: issue.id },
        select: { sprintId: true },
      }),
    ).toMatchObject({ sprintId: null });
  });
});
