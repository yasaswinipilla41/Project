import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createIssue } from "@/server/issues";
import {
  addIssuesToSprint,
  eligibleSprintsForIssue,
  moveIssueToSprint,
} from "@/server/sprints";
import {
  actAs,
  actAsAnonymous,
  deleteIssues,
  holdWorkRole,
} from "./helpers";

/**
 * Which sprints an issue may be moved into, asserted at the server boundary.
 *
 * The issue page's Move to sprint control asks `eligibleSprintsForIssue` what to
 * offer and `moveIssueToSprint` to carry it out. This file holds the two to the
 * same rule, because a selector that offers a move the server refuses — or, far
 * worse, one whose refusal is the only thing standing between a member and
 * another project's sprint — is the failure worth testing for.
 *
 * Every case calls the actions directly. That is what a forged request is: no
 * control was hidden, no menu filtered anything, and no client code ran. Each
 * one therefore asserts two things at once — what the selector would show, and
 * what the server does when a caller ignores it.
 *
 * The fixture is one project with three sprints in the three states a sprint can
 * be in, plus a second project nobody in the first is a member of, so
 * "cannot open that project" is something this file establishes rather than
 * assumes.
 */

const ADMIN = "admin@symbiosystech.com";
/** A MEMBER account, added to the fixture project. */
const MEMBER = "kiran.das@symbiosystech.com";
/** A MEMBER account deliberately left off the fixture project. */
const OUTSIDER = "priya.nair@symbiosystech.com";

const createdIssues: string[] = [];
const createdProjects: string[] = [];

let projectId = "";
let activeSprintId = "";
let plannedSprintId = "";
let completedSprintId = "";
/** A sprint in a project the fixture's members cannot open. */
let foreignSprintId = "";

function dates(offsetDays: number) {
  const start = new Date();
  start.setDate(start.getDate() + offsetDays);
  const end = new Date(start);
  end.setDate(end.getDate() + 13);
  return { startDate: start, endDate: end };
}

/** A fresh issue in the fixture project, optionally already in a sprint. */
async function seedIssue(title: string, sprintId?: string) {
  await actAs(ADMIN);
  const issue = await createIssue({ projectId, type: "TASK", title });
  if (!issue.ok) throw new Error(`issue fixture failed: ${issue.error}`);
  createdIssues.push(issue.data.id);

  if (sprintId) {
    const added = await addIssuesToSprint({
      sprintId,
      issueIds: [issue.data.id],
    });
    if (!added.ok) throw new Error(`membership fixture failed: ${added.error}`);
  }
  return issue.data.id;
}

beforeAll(async () => {
  const admin = await prisma.user.findUniqueOrThrow({
    where: { email: ADMIN },
    select: { id: true },
  });
  const member = await prisma.user.findUniqueOrThrow({
    where: { email: MEMBER },
    select: { id: true },
  });

  const stamp = Date.now().toString(36).toUpperCase();

  const project = await prisma.project.create({
    data: {
      key: `ELG${stamp}`.slice(0, 10),
      name: "Sprint eligibility fixture",
      createdById: admin.id,
      members: { create: [{ userId: admin.id }, { userId: member.id }] },
    },
    select: { id: true },
  });
  projectId = project.id;
  createdProjects.push(project.id);

  /*
   * The three states, written straight to the database rather than driven
   * through `startSprint` and `completeSprint`: this file is about what may be
   * moved where, and the lifecycle actions have their own suites. Writing the
   * rows keeps the fixture readable and independent of those rules.
   */
  const planned = await prisma.sprint.create({
    data: {
      projectId,
      name: "Eligibility · planned",
      createdById: admin.id,
      ...dates(14),
    },
    select: { id: true },
  });
  plannedSprintId = planned.id;

  const active = await prisma.sprint.create({
    data: {
      projectId,
      name: "Eligibility · active",
      status: "ACTIVE",
      startedAt: new Date(),
      createdById: admin.id,
      ...dates(0),
    },
    select: { id: true },
  });
  activeSprintId = active.id;

  const completed = await prisma.sprint.create({
    data: {
      projectId,
      name: "Eligibility · completed",
      status: "COMPLETED",
      completedAt: new Date(),
      createdById: admin.id,
      ...dates(-28),
    },
    select: { id: true },
  });
  completedSprintId = completed.id;

  /* A second project, with neither MEMBER nor OUTSIDER on it. */
  const foreign = await prisma.project.create({
    data: {
      key: `FGN${stamp}`.slice(0, 10),
      name: "Another team's project",
      createdById: admin.id,
      members: { create: { userId: admin.id } },
    },
    select: { id: true },
  });
  createdProjects.push(foreign.id);

  const foreignSprint = await prisma.sprint.create({
    data: {
      projectId: foreign.id,
      name: "Somebody else's sprint",
      status: "ACTIVE",
      startedAt: new Date(),
      createdById: admin.id,
      ...dates(0),
    },
    select: { id: true },
  });
  foreignSprintId = foreignSprint.id;
});

afterAll(async () => {
  await actAs(ADMIN);
  await deleteIssues(createdIssues);
  if (createdProjects.length > 0) {
    await prisma.project.deleteMany({ where: { id: { in: createdProjects } } });
  }
  await prisma.$disconnect();
});

describe("the eligible sprints a move can name", () => {
  it("offers this project's open sprints, and no completed or foreign one", async () => {
    const issueId = await seedIssue("Eligible destinations");
    await actAs(ADMIN);

    const result = await eligibleSprintsForIssue({ issueId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const offered = result.data.sprints.map((sprint) => sprint.id);

    // Both of this project's open sprints, soonest first.
    expect(offered).toEqual([activeSprintId, plannedSprintId]);

    // A completed sprint is a closed record, so it is never a destination.
    expect(offered).not.toContain(completedSprintId);

    /* And nothing from another project — the rule §11 rules out outright. The
       administrator can open that project, which is exactly why this case
       matters: visibility is not eligibility. */
    expect(offered).not.toContain(foreignSprintId);

    expect(result.data.current).toBeNull();
    expect(result.data.inBacklog).toBe(true);
    expect(result.data.locked).toBe(false);
  });

  it("names the sprint an issue is already in, and still offers the others", async () => {
    const issueId = await seedIssue("Already sprinted", activeSprintId);
    await actAs(ADMIN);

    const result = await eligibleSprintsForIssue({ issueId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.current?.id).toBe(activeSprintId);
    expect(result.data.inBacklog).toBe(false);
    expect(result.data.sprints.map((s) => s.id)).toContain(plannedSprintId);
  });

  it("offers nothing for an issue whose sprint has been completed", async () => {
    /* Membership of a completed sprint is part of that sprint's record.
       `moveIssueToSprint` refuses to move such an issue at all, so the
       selector must not offer a destination — and the reason it gives is
       "this sprint is closed", never "no sprints exist". */
    const issueId = await seedIssue("Held by the record");
    await prisma.issue.update({
      where: { id: issueId },
      data: { sprintId: completedSprintId },
    });
    await actAs(ADMIN);

    const result = await eligibleSprintsForIssue({ issueId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.locked).toBe(true);
    expect(result.data.sprints).toEqual([]);
    expect(result.data.current?.id).toBe(completedSprintId);
  });

  it("is refused to an unauthenticated caller", async () => {
    const issueId = await seedIssue("Not for nobody");
    actAsAnonymous();

    const result = await eligibleSprintsForIssue({ issueId });
    expect(result.ok).toBe(false);
  });

  it("is refused to somebody who cannot open the issue's project", async () => {
    const issueId = await seedIssue("Behind a closed door");
    await actAs(OUTSIDER);

    const result = await eligibleSprintsForIssue({ issueId });
    expect(result.ok).toBe(false);
  });

  it("is refused for an issue id that names nothing", async () => {
    await actAs(ADMIN);
    const result = await eligibleSprintsForIssue({
      issueId: "no-such-issue-id",
    });
    expect(result.ok).toBe(false);
  });
});

describe("moving an issue to a named sprint", () => {
  it("is allowed for an authorized member, into an eligible same-project sprint", async () => {
    const issueId = await seedIssue("Member's own move");
    const role = await holdWorkRole(MEMBER, "DEVELOPER");
    try {
      await actAs(MEMBER);
      const result = await moveIssueToSprint({
        issueId,
        destination: { type: "SPRINT", sprintId: plannedSprintId },
      });
      expect(result.ok).toBe(true);

      expect(
        await prisma.issue.findUniqueOrThrow({
          where: { id: issueId },
          select: { sprintId: true },
        }),
      ).toMatchObject({ sprintId: plannedSprintId });
    } finally {
      await role.leave();
    }
  });

  it("is allowed for every working role, which is the existing rule", async () => {
    /* `canEditSprintIssues` is every working role's — filling a sprint or
       moving its work is ordinary project work. Asserted rather than assumed,
       so narrowing it would fail here rather than quietly on somebody's
       screen. */
    for (const role of ["DEVELOPER", "QA", "FULLSTACK"] as const) {
      const issueId = await seedIssue(`Moved by a ${role}`);
      const held = await holdWorkRole(MEMBER, role);
      try {
        await actAs(MEMBER);
        const result = await moveIssueToSprint({
          issueId,
          destination: { type: "SPRINT", sprintId: activeSprintId },
        });
        expect(result.ok, `${role} must be allowed to move sprint issues`).toBe(
          true,
        );
      } finally {
        await held.leave();
      }
    }
  });

  it("moves an issue between two eligible sprints without duplicating anything", async () => {
    const issueId = await seedIssue("Changed its mind", activeSprintId);
    await actAs(ADMIN);

    const result = await moveIssueToSprint({
      issueId,
      destination: { type: "SPRINT", sprintId: plannedSprintId },
    });
    expect(result.ok).toBe(true);

    /* One sprint, not two: membership is the issue's own `sprintId`, so there
       is no join row that could hold both and no second association to
       create. It is in the destination and out of the origin by construction. */
    const after = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: { sprintId: true, previousSprintId: true },
    });
    expect(after.sprintId).toBe(plannedSprintId);
    expect(after.previousSprintId).toBe(activeSprintId);

    expect(
      await prisma.issue.count({
        where: { id: issueId, sprintId: activeSprintId },
      }),
    ).toBe(0);
  });

  it("refuses a destination the issue is already in", async () => {
    const issueId = await seedIssue("Already there", activeSprintId);
    await actAs(ADMIN);

    const result = await moveIssueToSprint({
      issueId,
      destination: { type: "SPRINT", sprintId: activeSprintId },
    });
    expect(result.ok).toBe(false);

    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: issueId },
        select: { sprintId: true },
      }),
    ).toMatchObject({ sprintId: activeSprintId });
  });

  it("refuses a sprint in another project, even to somebody who can see it", async () => {
    const issueId = await seedIssue("Not going next door");
    await actAs(ADMIN);

    const result = await moveIssueToSprint({
      issueId,
      destination: { type: "SPRINT", sprintId: foreignSprintId },
    });
    expect(result.ok).toBe(false);

    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: issueId },
        select: { sprintId: true },
      }),
    ).toMatchObject({ sprintId: null });
  });

  it("refuses a completed sprint as a destination", async () => {
    const issueId = await seedIssue("Not into the record");
    await actAs(ADMIN);

    const result = await moveIssueToSprint({
      issueId,
      destination: { type: "SPRINT", sprintId: completedSprintId },
    });
    expect(result.ok).toBe(false);
  });

  it("refuses a sprint id that names nothing", async () => {
    const issueId = await seedIssue("Nowhere to go");
    await actAs(ADMIN);

    const result = await moveIssueToSprint({
      issueId,
      destination: { type: "SPRINT", sprintId: "no-such-sprint-id" },
    });
    expect(result.ok).toBe(false);
  });

  it("refuses a destination that stopped being eligible after it was offered", async () => {
    /*
     * The stale-selection case. The sprint was open when the selector read it
     * and has since been completed; the move is refused on the sprint's own
     * current row rather than on what the browser was told earlier, and the
     * issue stays exactly where it was.
     */
    const issueId = await seedIssue("Raced a closing sprint");
    await actAs(ADMIN);

    const offered = await eligibleSprintsForIssue({ issueId });
    expect(offered.ok).toBe(true);
    if (!offered.ok) return;
    expect(offered.data.sprints.map((s) => s.id)).toContain(plannedSprintId);

    // The world moves on between the read and the write.
    await prisma.sprint.update({
      where: { id: plannedSprintId },
      data: { status: "COMPLETED", completedAt: new Date() },
    });

    try {
      const result = await moveIssueToSprint({
        issueId,
        destination: { type: "SPRINT", sprintId: plannedSprintId },
      });
      expect(result.ok).toBe(false);

      expect(
        await prisma.issue.findUniqueOrThrow({
          where: { id: issueId },
          select: { sprintId: true },
        }),
      ).toMatchObject({ sprintId: null });

      /* And the list, read again as the control re-reads it after a refusal,
         no longer offers it. */
      const revalidated = await eligibleSprintsForIssue({ issueId });
      expect(revalidated.ok).toBe(true);
      if (!revalidated.ok) return;
      expect(revalidated.data.sprints.map((s) => s.id)).not.toContain(
        plannedSprintId,
      );
    } finally {
      await prisma.sprint.update({
        where: { id: plannedSprintId },
        data: { status: "PLANNED", completedAt: null },
      });
    }
  });

  it("refuses an unauthenticated caller, and changes nothing", async () => {
    const issueId = await seedIssue("Moved by nobody");
    actAsAnonymous();

    const result = await moveIssueToSprint({
      issueId,
      destination: { type: "SPRINT", sprintId: activeSprintId },
    });
    expect(result.ok).toBe(false);

    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: issueId },
        select: { sprintId: true },
      }),
    ).toMatchObject({ sprintId: null });
  });

  it("refuses somebody who cannot open the issue's project", async () => {
    const issueId = await seedIssue("Not theirs to move");
    await actAs(OUTSIDER);

    const result = await moveIssueToSprint({
      issueId,
      destination: { type: "SPRINT", sprintId: activeSprintId },
    });
    expect(result.ok).toBe(false);

    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: issueId },
        select: { sprintId: true },
      }),
    ).toMatchObject({ sprintId: null });
  });
});

describe("taking an issue back out of a sprint", () => {
  it("returns it to the backlog, preserving every other field", async () => {
    const issueId = await seedIssue("Out again", activeSprintId);
    await actAs(ADMIN);

    const before = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: {
        status: true,
        priority: true,
        assigneeId: true,
        title: true,
        effortHours: true,
        remainingHours: true,
      },
    });

    const result = await moveIssueToSprint({
      issueId,
      destination: { type: "BACKLOG" },
    });
    expect(result.ok).toBe(true);

    const after = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: {
        sprintId: true,
        status: true,
        priority: true,
        assigneeId: true,
        title: true,
        effortHours: true,
        remainingHours: true,
      },
    });
    expect(after.sprintId).toBeNull();
    expect(after).toMatchObject(before);
  });
});
