import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createIssue, updateIssue } from "@/server/issues";
import { loadBurndown } from "@/server/queries/sprints";
import { addIssuesToSprint, createSprint } from "@/server/sprints";
import { actAs, deleteIssues } from "./helpers";

/**
 * The burndown a sprint page actually draws.
 *
 * `tests/burndown.test.ts` pins the arithmetic; this pins the wiring — that
 * the estimates, the statuses and the trail the chart is read from are the
 * ones Prio really writes when somebody estimates a piece of work and then
 * finishes it. The two together are what stop the chart from being decoration:
 * nothing here sets up a reading by hand, it all goes through the same actions
 * the application uses.
 */

const ADMIN = "admin@symbiosystech.com";

const createdIssues: string[] = [];
const createdProjects: string[] = [];
const createdSprints: string[] = [];

let projectId = "";
let sprintId = "";

function dates() {
  const start = new Date();
  const end = new Date(start);
  end.setDate(end.getDate() + 13);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

async function makeIssue(title: string, effortHours: number) {
  const created = await createIssue({ projectId, type: "TASK", title });
  if (!created.ok) throw new Error(`createIssue failed: ${created.error}`);
  const issue = await prisma.issue.findUniqueOrThrow({
    where: { key: created.data.key },
    select: { id: true },
  });
  createdIssues.push(issue.id);

  /* Through the real action, so the estimate — and the remainder it seeds —
     are written exactly as a person estimating the work would write them. */
  const estimated = await updateIssue({ issueId: issue.id, effortHours });
  if (!estimated.ok) throw new Error(`estimate failed: ${estimated.error}`);
  return issue.id;
}

beforeAll(async () => {
  const admin = await prisma.user.findUniqueOrThrow({
    where: { email: ADMIN },
    select: { id: true },
  });
  const project = await prisma.project.create({
    data: {
      key: `BD${Date.now().toString(36).toUpperCase()}`.slice(0, 10),
      name: "Burndown fixture",
      createdById: admin.id,
      members: { create: { userId: admin.id } },
    },
    select: { id: true },
  });
  projectId = project.id;
  createdProjects.push(project.id);

  await actAs(ADMIN);
  const sprint = await createSprint({
    projectId,
    name: `Burndown sprint ${Date.now()}`,
    goal: "",
    ...dates(),
  });
  if (!sprint.ok) throw new Error(`createSprint failed: ${sprint.error}`);
  sprintId = sprint.data.id;
  createdSprints.push(sprintId);
});

afterAll(async () => {
  if (createdSprints.length > 0) {
    await prisma.sprint.deleteMany({ where: { id: { in: createdSprints } } });
  }
  await deleteIssues(createdIssues);
  if (createdProjects.length > 0) {
    await prisma.project.deleteMany({ where: { id: { in: createdProjects } } });
  }
  await prisma.$disconnect();
});

describe("the burndown a sprint page draws", () => {
  it("starts at the estimated total and falls as the work is finished", async () => {
    await actAs(ADMIN);
    const big = await makeIssue("Burndown big piece", 24);
    const small = await makeIssue("Burndown small piece", 16);
    await addIssuesToSprint({ sprintId, issueIds: [big, small] });

    const before = await loadBurndown(sprintId);
    /* 40 hours committed, 40 outstanding: nothing has been finished, and the
       figures are read from the estimates rather than from anything stored. */
    expect(before).toMatchObject({
      totalEffort: 40,
      remaining: 40,
      unestimated: 0,
    });

    /* Finishing the work is the only thing this test does to it. Nobody edits
       "remaining hours" — which is exactly the case that used to leave the
       chart flat. */
    const done = await updateIssue({ issueId: big, status: "DONE" });
    expect(done.ok).toBe(true);

    const after = await loadBurndown(sprintId);
    expect(after).toMatchObject({ totalEffort: 40, remaining: 16 });

    /* Today's point is the same figure the caption quotes, so the line and
       the words under it cannot disagree. */
    const today = after!.points.filter((point) => point.actual !== null).at(-1);
    expect(today?.actual).toBe(16);
  });

  it("gives the work back when it is reopened, without touching its status twice", async () => {
    await actAs(ADMIN);
    const issue = await makeIssue("Burndown reopened piece", 8);
    await addIssuesToSprint({ sprintId, issueIds: [issue] });

    await updateIssue({ issueId: issue, status: "DONE" });
    const finished = await loadBurndown(sprintId);
    const restored = await updateIssue({ issueId: issue, status: "REOPENED" });
    expect(restored.ok).toBe(true);
    const reopened = await loadBurndown(sprintId);

    /* Eight hours left the chart when it was finished and came back when it
       was reopened. The commitment never moved. */
    expect(reopened!.totalEffort).toBe(finished!.totalEffort);
    expect(reopened!.remaining).toBe(finished!.remaining + 8);
  });

  it("counts Reject / Not an Issue and Cancelled as finished work", async () => {
    await actAs(ADMIN);
    const rejected = await makeIssue("Burndown rejected piece", 5);
    const cancelled = await makeIssue("Burndown cancelled piece", 7);
    await addIssuesToSprint({ sprintId, issueIds: [rejected, cancelled] });

    const before = await loadBurndown(sprintId);
    await updateIssue({ issueId: rejected, status: "REJECTED" });
    await updateIssue({ issueId: cancelled, status: "CANCELLED" });
    const after = await loadBurndown(sprintId);

    /* Neither is work the sprint still has to do, so both leave the
       remainder — and both stay in the commitment, because they were
       committed to. */
    expect(after!.remaining).toBe(before!.remaining - 12);
    expect(after!.totalEffort).toBe(before!.totalEffort);
  });

  it("names who holds the work that is left, and what was handed to testing", async () => {
    /*
     * The two answers a day's detail gives beyond the hours, both read from
     * the real query rather than assembled here: who holds each open issue,
     * and what went to testing that day.
     *
     * Moving work to Ready for QA burns nothing — testing is open work, and
     * the sprint still owes those hours — so it would otherwise be invisible
     * on a day whose line did not move, which is exactly the day a reader is
     * asking about.
     */
    await actAs(ADMIN);
    const issue = await makeIssue("Burndown handed to testing", 6);
    await addIssuesToSprint({ sprintId, issueIds: [issue] });

    const admin = await prisma.user.findUniqueOrThrow({
      where: { email: ADMIN },
      select: { id: true, name: true },
    });
    const assigned = await updateIssue({
      issueId: issue,
      assigneeId: admin.id,
    });
    expect(assigned.ok).toBe(true);

    /* Through the workflow, so the trail is the one the app writes. */
    for (const status of ["IN_PROGRESS", "IN_REVIEW", "IN_QA"] as const) {
      const moved = await updateIssue({ issueId: issue, status });
      expect(moved.ok, status).toBe(true);
    }

    const chart = await loadBurndown(sprintId);
    const today = chart!.points
      .filter((point) => point.actual !== null)
      .at(-1)!;

    const row = today.remainingIssues.find((entry) => entry.effortHours === 6);
    expect(row?.assignee, "who holds it").toBe(admin.name);
    expect(row?.status, "testing is open work").toBe("IN_QA");

    expect(
      today.movedToQa.map((entry) => entry.title),
      "handed to testing today",
    ).toContain("Burndown handed to testing");
    expect(today.tally.toQa).toBeGreaterThanOrEqual(1);
  });

  it("reports the day's own movement, and the scope it opened with", async () => {
    /* One sprint-level pair and one per-day pair, both from the real query:
       what the sprint committed to on its first day against what it holds
       now, and what today did to the line. */
    const chart = await loadBurndown(sprintId);
    expect(chart).not.toBeNull();

    /*
     * What the sprint opened with, plus everything that arrived, less
     * everything that left, is what it holds now.
     *
     * The identity the summary above the chart rests on — "Initial" beside
     * "Total" only means anything if the difference between them is accounted
     * for. It holds whenever the work arrived: this fixture's sprint starts
     * today and was filled today, so its opening commitment already includes
     * that work and the scope figures are nought; a sprint filled before it
     * started, or added to on its third day, moves the same figures the same
     * way.
     */
    expect(chart!.scopeAdded).toBeGreaterThanOrEqual(0);
    expect(chart!.scopeRemoved).toBeLessThanOrEqual(0);
    expect(
      Math.round(
        (chart!.initialEffort + chart!.scopeAdded + chart!.scopeRemoved) * 100,
      ) / 100,
    ).toBe(chart!.totalEffort);

    /* And the decomposition holds on every day the sprint has reached. */
    for (const [index, day] of chart!.points.entries()) {
      if (day.change === null) continue;
      expect(day.change, `day ${index}`).toBe(
        Math.round((day.scopeToday - day.completedToday) * 100) / 100,
      );
    }

    /* Progress is the one definition both the summary and the marker for
       today read. */
    expect(chart!.progress).toBe(
      chart!.totalEffort === 0
        ? 0
        : Math.round(
            ((chart!.totalEffort - chart!.remaining) / chart!.totalEffort) *
              100,
          ),
    );
  });

  it("says nothing has been estimated when nothing has, rather than drawing a flat line", async () => {
    await actAs(ADMIN);
    const project = await prisma.project.create({
      data: {
        key: `BE${Date.now().toString(36).toUpperCase()}`.slice(0, 10),
        name: "Burndown empty fixture",
        createdById: (
          await prisma.user.findUniqueOrThrow({
            where: { email: ADMIN },
            select: { id: true },
          })
        ).id,
        members: {
          create: {
            userId: (
              await prisma.user.findUniqueOrThrow({
                where: { email: ADMIN },
                select: { id: true },
              })
            ).id,
          },
        },
      },
      select: { id: true },
    });
    createdProjects.push(project.id);

    const sprint = await createSprint({
      projectId: project.id,
      name: `Burndown unestimated ${Date.now()}`,
      goal: "",
      ...dates(),
    });
    if (!sprint.ok) throw new Error("sprint fixture failed");
    createdSprints.push(sprint.data.id);

    const created = await createIssue({
      projectId: project.id,
      type: "TASK",
      title: "Unestimated work",
    });
    if (!created.ok) throw new Error("issue fixture failed");
    const issue = await prisma.issue.findUniqueOrThrow({
      where: { key: created.data.key },
      select: { id: true },
    });
    createdIssues.push(issue.id);
    await addIssuesToSprint({ sprintId: sprint.data.id, issueIds: [issue.id] });

    const chart = await loadBurndown(sprint.data.id);

    /* Nothing estimated: a total of nothing, and the item counted as
       unestimated. The chart component reads this as "nothing to burn down"
       and keeps its empty-state message rather than drawing an empty plot. */
    expect(chart).toMatchObject({ totalEffort: 0, unestimated: 1 });
  });
});
