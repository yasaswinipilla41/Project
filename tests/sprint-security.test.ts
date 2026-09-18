import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createIssue } from "@/server/issues";
import {
  addIssuesToSprint,
  completeSprint,
  createSprint,
  deleteSprint,
  moveIssueToSprint,
  removeIssueFromSprint,
  startSprint,
  updateSprint,
} from "@/server/sprints";
import { actAs, actAsAnonymous, deleteIssues, projectByKey } from "./helpers";

/**
 * Who the server lets near a sprint, asserted at the boundary.
 *
 * Every case here calls the server action directly, which is what a forged
 * request is: no button was hidden, no dialog validated anything, and no
 * client-side check ran. Three claims are under test.
 *
 *  1. **An unauthenticated caller reaches nothing.** Not the lifecycle, not
 *     the contents.
 *  2. **The payload is not evidence.** A caller may put `isAdmin`,
 *     `role: "ADMIN"`, `canEditSprint`, `projectAccess` or somebody else's
 *     `projectId` in the request body; none of it changes the answer, because
 *     authorization is resolved from the session and the sprint's own row.
 *  3. **A sprint id is not a capability.** Holding the id of a sprint in a
 *     project you cannot open gets you nothing — read or write — which is the
 *     scenario a guessed or shared id represents.
 *
 * The fixture is a project only the administrator belongs to, so "cannot open
 * this project" is something this file establishes rather than assumes.
 */

const ADMIN = "admin@symbiosystech.com";
/** A member of Engineering, deliberately not of the fixture project below. */
const OUTSIDER = "priya.nair@symbiosystech.com";

const createdIssues: string[] = [];
const createdProjects: string[] = [];

/** The administrator's own project: a sprint, and an issue in it. */
let closedProjectId = "";
let closedSprintId = "";
let closedIssueId = "";
/** An issue in a project the outsider *can* open, for cross-project cases. */
let outsiderIssueId = "";

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

beforeAll(async () => {
  const admin = await prisma.user.findUniqueOrThrow({
    where: { email: ADMIN },
    select: { id: true },
  });

  const project = await prisma.project.create({
    data: {
      key: `SEC${Date.now().toString(36).toUpperCase()}`.slice(0, 10),
      name: "Sprint security fixture",
      createdById: admin.id,
      members: { create: { userId: admin.id } },
    },
    select: { id: true },
  });
  closedProjectId = project.id;
  createdProjects.push(project.id);

  await actAs(ADMIN);

  const sprint = await createSprint({
    projectId: closedProjectId,
    name: "Out of reach",
    goal: "",
    ...dates(),
  });
  if (!sprint.ok) throw new Error(`sprint fixture failed: ${sprint.error}`);
  closedSprintId = sprint.data.id;

  const issue = await createIssue({
    projectId: closedProjectId,
    type: "TASK",
    title: "Work behind a closed door",
  });
  if (!issue.ok) throw new Error(`issue fixture failed: ${issue.error}`);
  closedIssueId = issue.data.id;
  createdIssues.push(issue.data.id);

  const added = await addIssuesToSprint({
    sprintId: closedSprintId,
    issueIds: [closedIssueId],
  });
  if (!added.ok) throw new Error(`membership fixture failed: ${added.error}`);

  // Something the outsider genuinely owns, for the cross-project attempt.
  const engineering = await projectByKey("ENG");
  const theirs = await createIssue({
    projectId: engineering.id,
    type: "TASK",
    title: "The outsider's own work",
  });
  if (!theirs.ok) throw new Error(`issue fixture failed: ${theirs.error}`);
  outsiderIssueId = theirs.data.id;
  createdIssues.push(theirs.data.id);
});

afterAll(async () => {
  await actAs(ADMIN);
  await deleteIssues(createdIssues);
  if (createdProjects.length > 0) {
    await prisma.project.deleteMany({ where: { id: { in: createdProjects } } });
  }
  await prisma.$disconnect();
});

describe("an unauthenticated caller", () => {
  it("is refused every sprint operation, and changes nothing", async () => {
    actAsAnonymous();

    const attempts: Record<string, { ok: boolean }> = {
      create: await createSprint({
        projectId: closedProjectId,
        name: "Filed by nobody",
        goal: "",
        ...dates(),
      }),
      update: await updateSprint({
        sprintId: closedSprintId,
        name: "Renamed by nobody",
        goal: "",
        ...dates(),
      }),
      addIssues: await addIssuesToSprint({
        sprintId: closedSprintId,
        issueIds: [closedIssueId],
      }),
      removeIssue: await removeIssueFromSprint({
        sprintId: closedSprintId,
        issueId: closedIssueId,
      }),
      moveIssue: await moveIssueToSprint({
        issueId: closedIssueId,
        destination: { type: "BACKLOG" },
      }),
      start: await startSprint({ sprintId: closedSprintId }),
      complete: await completeSprint({
        sprintId: closedSprintId,
        moveIncompleteTo: "BACKLOG",
      }),
      delete: await deleteSprint({ sprintId: closedSprintId }),
    };

    for (const [name, result] of Object.entries(attempts)) {
      expect(result.ok, `${name} must be refused`).toBe(false);
    }

    // The sprint is untouched: still there, still named, still holding its work.
    const after = await prisma.sprint.findUniqueOrThrow({
      where: { id: closedSprintId },
      select: { name: true, status: true, _count: { select: { issues: true } } },
    });
    expect(after).toMatchObject({ name: "Out of reach", status: "PLANNED" });
    expect(after._count.issues).toBe(1);
  });
});

describe("a sprint id is not a capability", () => {
  it("refuses somebody who cannot open the project, on every write", async () => {
    await actAs(OUTSIDER);

    const attempts: Record<string, { ok: boolean }> = {
      update: await updateSprint({
        sprintId: closedSprintId,
        name: "Renamed by an outsider",
        goal: "",
        ...dates(),
      }),
      addIssues: await addIssuesToSprint({
        sprintId: closedSprintId,
        issueIds: [closedIssueId],
      }),
      removeIssue: await removeIssueFromSprint({
        sprintId: closedSprintId,
        issueId: closedIssueId,
      }),
      moveIssue: await moveIssueToSprint({
        issueId: closedIssueId,
        destination: { type: "BACKLOG" },
      }),
      start: await startSprint({ sprintId: closedSprintId }),
      complete: await completeSprint({
        sprintId: closedSprintId,
        moveIncompleteTo: "BACKLOG",
      }),
      delete: await deleteSprint({ sprintId: closedSprintId }),
    };

    for (const [name, result] of Object.entries(attempts)) {
      expect(result.ok, `${name} must be refused`).toBe(false);
    }

    const after = await prisma.sprint.findUniqueOrThrow({
      where: { id: closedSprintId },
      select: { name: true, status: true, _count: { select: { issues: true } } },
    });
    expect(after).toMatchObject({ name: "Out of reach", status: "PLANNED" });
    expect(after._count.issues).toBe(1);
  });

  it("refuses an outsider moving their own issue into a sprint they cannot see", async () => {
    /* The cross-project rule from the other side: the issue is genuinely
       theirs, the sprint genuinely is not, and the sprint's project — read
       from its own row — is what decides. */
    await actAs(OUTSIDER);

    const result = await moveIssueToSprint({
      issueId: outsiderIssueId,
      destination: { type: "SPRINT", sprintId: closedSprintId },
    });

    expect(result.ok).toBe(false);
    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: outsiderIssueId },
        select: { sprintId: true },
      }),
    ).toMatchObject({ sprintId: null });
  });
});

describe("the payload is not evidence", () => {
  it("ignores role and permission flags a caller puts in the body", async () => {
    /*
     * Everything a client could claim about itself, claimed at once, by
     * somebody who is a member of Engineering and nothing more. Deleting a
     * sprint is an administrator's, so a payload that says otherwise is the
     * clearest test of whether the body is ever consulted — and the schemas
     * drop unknown keys, so these never reach a decision at all.
     */
    await actAs(OUTSIDER);
    const engineering = await projectByKey("ENG");

    await actAs(ADMIN);
    const theirs = await createSprint({
      projectId: engineering.id,
      name: `Not the claimant's ${Date.now()}`,
      goal: "",
      ...dates(),
    });
    if (!theirs.ok) throw new Error(theirs.error);

    await actAs(OUTSIDER);
    const forged = {
      sprintId: theirs.data.id,
      isAdmin: true,
      role: "ADMIN",
      canEditSprint: true,
      canDeleteSprint: true,
      canStartSprint: true,
      canCompleteSprint: true,
      projectAccess: true,
      permissions: ["sprint.delete"],
    };

    const removed = await deleteSprint(forged);
    expect(removed.ok).toBe(false);

    const completed = await completeSprint({
      ...forged,
      moveIncompleteTo: "BACKLOG",
    });
    expect(completed.ok).toBe(false);

    // Still there, and still planned.
    const after = await prisma.sprint.findUnique({
      where: { id: theirs.data.id },
      select: { status: true },
    });
    expect(after).toMatchObject({ status: "PLANNED" });

    await actAs(ADMIN);
    await prisma.sprint.delete({ where: { id: theirs.data.id } });
  });

  it("takes the sprint's project from the sprint, not from the request", async () => {
    /*
     * `addIssuesToSprint` reads the sprint's own `projectId` and checks every
     * issue against it. A caller naming a different project in the body — the
     * project the issue is actually in — cannot make a cross-project
     * assignment succeed, because that value is never read.
     */
    await actAs(ADMIN);

    const result = await addIssuesToSprint({
      sprintId: closedSprintId,
      issueIds: [outsiderIssueId],
      // A lie: this issue is in Engineering, not in the sprint's project.
      projectId: closedProjectId,
    });

    expect(result.ok).toBe(false);
    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: outsiderIssueId },
        select: { sprintId: true },
      }),
    ).toMatchObject({ sprintId: null });
  });
});
