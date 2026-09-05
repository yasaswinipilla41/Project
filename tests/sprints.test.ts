import { afterAll, afterEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createIssue, updateIssue } from "@/server/issues";
import { loadSprintBacklog, loadSprints } from "@/server/queries/sprints";
import {
  addIssuesToSprint,
  completeSprint,
  createSprint,
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
});

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
    /* Testing is the administrator's own project; `MEMBER` is not in it. A
       stranger to a project cannot plan work in it. */
    await actAs(MEMBER);
    const testing = await projectByKey("TES");

    const before = await prisma.sprint.count();
    const result = await createSprint({
      projectId: testing.id,
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

  it("lets a member of the project put their work into a sprint", async () => {
    /* Filling a sprint is ordinary work in a project you belong to — the same
       access `updateIssue` asks for — unlike starting or completing one. */
    await actAs(ADMIN);
    const project = await projectByKey("ENG");
    const sprintId = await makeSprint(project.id, "Member fills this");

    await actAs(MEMBER);
    const issue = await makeIssue(project.id, "Member's own work");
    const result = await addIssuesToSprint({ sprintId, issueIds: [issue.id] });

    expect(result.ok).toBe(true);
    expect(await prisma.issue.count({ where: { sprintId } })).toBe(1);
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
    const project = await projectByKey("ENG");
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
    const project = await projectByKey("WEB");

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
    const project = await projectByKey("ENG");
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
    const project = await projectByKey("ENG");
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
    const project = await projectByKey("ENG");
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
    const project = await projectByKey("INT");

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

  it("refuses to carry work into another project's sprint", async () => {
    await actAs(ADMIN);
    const engineering = await projectByKey("ENG");
    const website = await projectByKey("WEB");

    const source = await makeSprint(engineering.id, "Cannot leave Engineering");
    const foreign = await makeSprint(website.id, "Website's own sprint");
    const unfinished = await makeIssue(engineering.id, "Must stay in ENG");

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
    const project = await projectByKey("ENG");
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
    const project = await projectByKey("ENG");
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
