import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createIssue } from "@/server/issues";
import { filterOptions, listIssues } from "@/server/queries/issues";
import { parseIssueParams } from "@/server/queries/params";
import {
  addIssuesToSprint,
  completeSprint,
  createSprint,
  startSprint,
} from "@/server/sprints";
import type { CurrentUser } from "@/lib/session";
import { actAs, deleteIssues } from "./helpers";

/**
 * Filtering the issue list by sprint, and by the backlog.
 *
 * Two rules are under test, and the second is the one worth having:
 *
 *  - picking a sprint shows that sprint's work and nothing else;
 *  - **the backlog is a choice, not the absence of one.** "In no sprint" is a
 *    real thing to ask for, so it is the `"none"` value rather than an empty
 *    filter — the same sentinel the assignee filter already uses for
 *    unassigned work — and it composes with named sprints rather than
 *    cancelling them.
 *
 * Written against `listIssues`, which is what every issue surface queries
 * with, so this tests the filter itself rather than one page's use of it. The
 * fixture is a project of its own so the counts are exact.
 */

const ADMIN = "admin@symbiosystech.com";

const createdIssues: string[] = [];
const createdProjects: string[] = [];

let admin: CurrentUser;
let projectId = "";
let sprintA = "";
let sprintB = "";
let inSprintA = "";
let inSprintB = "";
let inBacklog = "";

/** A sprint's dates, offset in whole weeks so they never overlap by accident. */
function dates(weekOffset: number) {
  const start = new Date();
  start.setDate(start.getDate() + weekOffset * 7);
  const end = new Date(start);
  end.setDate(end.getDate() + 5);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

async function makeIssue(title: string): Promise<string> {
  const result = await createIssue({ projectId, type: "TASK", title });
  if (!result.ok) throw new Error(`createIssue failed: ${result.error}`);
  createdIssues.push(result.data.id);
  return result.data.id;
}

beforeAll(async () => {
  admin = await prisma.user.findUniqueOrThrow({
    where: { email: ADMIN },
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

  const project = await prisma.project.create({
    data: {
      key: `SF${Date.now().toString(36).toUpperCase()}`.slice(0, 10),
      name: "Sprint filter fixture",
      createdById: admin.id,
      members: { create: { userId: admin.id } },
    },
    select: { id: true },
  });
  projectId = project.id;
  createdProjects.push(project.id);

  await actAs(ADMIN);

  const a = await createSprint({
    projectId,
    name: "Filter sprint A",
    goal: "",
    ...dates(0),
  });
  const b = await createSprint({
    projectId,
    name: "Filter sprint B",
    goal: "",
    ...dates(2),
  });
  if (!a.ok || !b.ok) throw new Error("sprint fixtures failed");
  sprintA = a.data.id;
  sprintB = b.data.id;

  inSprintA = await makeIssue("Work in sprint A");
  inSprintB = await makeIssue("Work in sprint B");
  inBacklog = await makeIssue("Work in no sprint at all");

  const intoA = await addIssuesToSprint({ sprintId: sprintA, issueIds: [inSprintA] });
  const intoB = await addIssuesToSprint({ sprintId: sprintB, issueIds: [inSprintB] });
  if (!intoA.ok || !intoB.ok) throw new Error("sprint membership fixtures failed");
});

afterAll(async () => {
  await deleteIssues(createdIssues);
  if (createdProjects.length > 0) {
    await prisma.project.deleteMany({ where: { id: { in: createdProjects } } });
  }
  await prisma.$disconnect();
});

/** The ids this filter returns, within the fixture's own project. */
async function idsFor(sprintIds: string[]): Promise<Set<string>> {
  const result = await listIssues(admin, {
    projectIds: [projectId],
    sprintIds,
    pageSize: 100,
  });
  return new Set(result.rows.map((row) => row.id));
}

describe("the sprint filter", () => {
  it("shows one sprint's work and no other sprint's", async () => {
    const ids = await idsFor([sprintA]);

    expect(ids.has(inSprintA)).toBe(true);
    expect(ids.has(inSprintB)).toBe(false);
    expect(ids.has(inBacklog)).toBe(false);
  });

  it("shows the backlog — work in no sprint — for the `none` value", async () => {
    const ids = await idsFor(["none"]);

    expect(ids.has(inBacklog)).toBe(true);
    expect(ids.has(inSprintA)).toBe(false);
    expect(ids.has(inSprintB)).toBe(false);
  });

  it("adds the backlog to a chosen sprint rather than cancelling it", async () => {
    /* The composition rule: picking Sprint A and Backlog is a request for
       both, which is how the multi-select assignee filter behaves for
       "unassigned" plus a named person. */
    const ids = await idsFor([sprintA, "none"]);

    expect(ids.has(inSprintA)).toBe(true);
    expect(ids.has(inBacklog)).toBe(true);
    expect(ids.has(inSprintB)).toBe(false);
  });

  it("shows several chosen sprints together", async () => {
    const ids = await idsFor([sprintA, sprintB]);

    expect(ids.has(inSprintA)).toBe(true);
    expect(ids.has(inSprintB)).toBe(true);
    expect(ids.has(inBacklog)).toBe(false);
  });

  it("filters nothing when no sprint is chosen", async () => {
    const ids = await idsFor([]);

    expect(ids.has(inSprintA)).toBe(true);
    expect(ids.has(inSprintB)).toBe(true);
    expect(ids.has(inBacklog)).toBe(true);
  });

  it("is read from the URL as `?sprint=`, repeatable", () => {
    /* The filter has to survive a link being shared, so the URL is the state
       — the same contract every other filter on the bar holds to. */
    expect(parseIssueParams({ sprint: "abc" }).sprintIds).toEqual(["abc"]);
    expect(parseIssueParams({ sprint: ["abc", "none"] }).sprintIds).toEqual([
      "abc",
      "none",
    ]);
    expect(parseIssueParams({}).sprintIds).toEqual([]);
  });
});

/**
 * A completed sprint, picked in the Iteration filter.
 *
 * Completing a sprint carries its unfinished work out of it — here, into
 * sprint B — so `sprintId` alone would list a completed sprint as only its
 * finished half. The filter reads the sprint's own record of what it held when
 * it closed as well, and shows exactly that work: no other sprint's, and not
 * the backlog. A sprint that is not completed matches as it always did.
 */
describe("the sprint filter on a completed sprint", () => {
  let sprintC = "";
  let finishedInC = "";
  let carriedOutOfC = "";

  beforeAll(async () => {
    await actAs(ADMIN);

    const c = await createSprint({
      projectId,
      name: "Filter sprint C",
      goal: "",
      ...dates(4),
    });
    if (!c.ok) throw new Error("sprint C fixture failed");
    sprintC = c.data.id;

    finishedInC = await makeIssue("Finished in sprint C");
    carriedOutOfC = await makeIssue("Unfinished when sprint C closed");
    const into = await addIssuesToSprint({
      sprintId: sprintC,
      issueIds: [finishedInC, carriedOutOfC],
    });
    if (!into.ok) throw new Error(`addIssuesToSprint failed: ${into.error}`);

    // Fixture state: one of the two is finished before the sprint closes.
    await prisma.issue.update({
      where: { id: finishedInC },
      data: { status: "DONE" },
    });

    const started = await startSprint({ sprintId: sprintC });
    if (!started.ok) throw new Error(`startSprint failed: ${started.error}`);
    const closed = await completeSprint({
      sprintId: sprintC,
      moveIncompleteTo: "NEXT_SPRINT",
      nextSprintId: sprintB,
    });
    if (!closed.ok) throw new Error(`completeSprint failed: ${closed.error}`);
  });

  it("shows every issue the sprint held when it closed, finished or carried out", async () => {
    const ids = await idsFor([sprintC]);

    expect(ids.has(finishedInC)).toBe(true);
    expect(ids.has(carriedOutOfC)).toBe(true);
  });

  it("shows only that sprint's work — no other sprint's, and not the backlog", async () => {
    const ids = await idsFor([sprintC]);

    expect(ids.size).toBe(2);
    expect(ids.has(inSprintA)).toBe(false);
    expect(ids.has(inSprintB)).toBe(false);
    expect(ids.has(inBacklog)).toBe(false);
  });

  it("leaves a sprint that is not completed matching on what is in it now", async () => {
    /* Sprint B received C's unfinished work, so it lists it; it never held
       C's finished issue and does not list that. */
    const ids = await idsFor([sprintB]);

    expect(ids.has(inSprintB)).toBe(true);
    expect(ids.has(carriedOutOfC)).toBe(true);
    expect(ids.has(finishedInC)).toBe(false);
    expect(ids.has(inSprintA)).toBe(false);
  });

  it("offers each sprint with its real status, so the dropdown can mark the completed one", async () => {
    const options = await filterOptions(admin);
    const mine = options.sprints.filter((sprint) => sprint.projectId === projectId);
    const byId = new Map(mine.map((sprint) => [sprint.id, sprint.status]));

    expect(byId.get(sprintC)).toBe("COMPLETED");
    expect(byId.get(sprintA)).not.toBe("COMPLETED");
    expect(byId.get(sprintB)).not.toBe("COMPLETED");
  });
});
