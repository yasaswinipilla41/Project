import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { DEVELOPMENT_TEAM_SLUG, TESTING_TEAM_SLUG } from "@/lib/authz";
import { createIssue, updateIssue } from "@/server/issues";
import {
  laneIssues,
  laneMembers,
  assignWork,
} from "@/server/workStatus";
import {
  loadWorkStatus,
  listLaneIssues,
  listLaneMembers,
} from "@/server/queries/workStatus";
import type { CurrentUser } from "@/lib/session";
import type { IssueStatus } from "@prisma/client";
import { actAs, projectByKey } from "./helpers";

/**
 * Work Status — Admin Home's two assignment lanes.
 *
 * Four things are asserted, and they are the four that could go wrong:
 *
 *  1. **Which work is in each lane.** Ready for QA and nothing else on one
 *     side; New, Reopen and Backlog and nothing else on the other. Every
 *     status is checked in both directions rather than only the included ones,
 *     because a filter that is too wide passes every "is it there" case.
 *  2. **That handing work out takes it out of the lane.** A lane is work
 *     *waiting*, so an issue held by somebody who does that half of the job is
 *     not in it — and an issue held by somebody who does the other half still
 *     is. That is what makes the count on the card fall by one when an
 *     administrator assigns something, without its status having moved.
 *  3. **That the count and the list are the same query.** A card saying five
 *     and a dialog offering four is the bug the shared fragment exists to
 *     prevent, so the number is recomputed from the rows every time.
 *  4. **That it is an administrator's, on the server.** Every one of the three
 *     calls is made as a developer and as a tester, because hiding a card
 *     stops nobody who can post a request.
 *
 * Everything runs through the real server actions with a real session, so what
 * is tested is the call a browser makes rather than a helper beside it.
 */

const ADMIN = "admin@symbiosystech.com";
const TESTER = "sneha.iyer@symbiosystech.com";
const DEVELOPER = "kiran.das@symbiosystech.com";
const FULLSTACK = "meera.pillai@symbiosystech.com";

const created: string[] = [];
const memberships: string[] = [];
/** Team rows taken away to make somebody pure, and put back afterwards. */
const suspended: { teamId: string; userId: string }[] = [];

async function userId(email: string): Promise<string> {
  const row = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: { id: true },
  });
  return row.id;
}

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
  /* A pure tester, a pure developer and somebody who is both — the three
     answers `doesQaWork` and `doesDeveloperWork` can give a member. Team rows
     are shared state, so each is made explicitly rather than assumed. */
  await leaveFor(TESTER, DEVELOPMENT_TEAM_SLUG);
  await join(TESTER, TESTING_TEAM_SLUG);

  await leaveFor(DEVELOPER, TESTING_TEAM_SLUG);
  await join(DEVELOPER, DEVELOPMENT_TEAM_SLUG);

  await join(FULLSTACK, TESTING_TEAM_SLUG);
  await join(FULLSTACK, DEVELOPMENT_TEAM_SLUG);

  /* All three have to be on the project, because being on it is half of what
     makes somebody eligible and the other half is what this file is about. */
  const project = await projectByKey("ENG");
  for (const email of [TESTER, DEVELOPER, FULLSTACK]) {
    await prisma.projectMember.upsert({
      where: {
        projectId_userId: { projectId: project.id, userId: await userId(email) },
      },
      update: {},
      create: { projectId: project.id, userId: await userId(email) },
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

/** An unassigned ENG issue in a named status, created as the administrator. */
async function anIssue(status: IssueStatus, label: string): Promise<string> {
  await actAs(ADMIN);
  const project = await projectByKey("ENG");

  const result = await createIssue({
    projectId: project.id,
    type: "TASK",
    title: `Work Status ${label} ${Date.now()}-${Math.random()}`,
    description: "fixture",
    status: "TODO",
    priority: "MEDIUM",
  });
  if (!result.ok) throw new Error(result.error);
  created.push(result.data.id);

  if (status !== "TODO") {
    const moved = await updateIssue({ issueId: result.data.id, status });
    if (!moved.ok) throw new Error(moved.error);
  }
  return result.data.id;
}

/* ------------------------------------------------------ which work is where */

const EVERY_STATUS: readonly IssueStatus[] = [
  "BACKLOG",
  "TODO",
  "IN_PROGRESS",
  "IN_REVIEW",
  "IN_QA",
  "DONE",
  "REOPENED",
  "REJECTED",
  "CANCELLED",
];

describe("the QA lane", () => {
  it("holds Ready for QA, and no other status at all", async () => {
    const project = await projectByKey("ENG");
    const ids = new Map<IssueStatus, string>();
    for (const status of EVERY_STATUS) {
      ids.set(status, await anIssue(status, `qa-lane-${status}`));
    }

    const listed = new Set(
      (await listLaneIssues("QA", project.id)).map((row) => row.id),
    );

    for (const status of EVERY_STATUS) {
      const id = ids.get(status)!;
      expect(listed.has(id), `${status} in the QA lane`).toBe(
        status === "IN_REVIEW",
      );
    }
  });
});

describe("the developer lane", () => {
  it("holds New, Reopen and Backlog, and no other status at all", async () => {
    const project = await projectByKey("ENG");
    const ids = new Map<IssueStatus, string>();
    for (const status of EVERY_STATUS) {
      ids.set(status, await anIssue(status, `dev-lane-${status}`));
    }

    const listed = new Set(
      (await listLaneIssues("DEVELOPER", project.id)).map((row) => row.id),
    );

    const included: readonly IssueStatus[] = ["TODO", "REOPENED", "BACKLOG"];
    for (const status of EVERY_STATUS) {
      const id = ids.get(status)!;
      expect(listed.has(id), `${status} in the developer lane`).toBe(
        included.includes(status),
      );
    }
  });
});

/* -------------------------------------------------------- counts and lists */

describe("the numbers on the card", () => {
  it("are the rows the dialog then offers, lane by lane and project by project", async () => {
    await anIssue("IN_REVIEW", "count-qa");
    await anIssue("BACKLOG", "count-dev");

    const admin = await userByEmail(ADMIN);
    const data = await loadWorkStatus(admin);

    for (const lane of [data.qa, data.developer]) {
      let summed = 0;
      for (const project of lane.projects) {
        const rows = await listLaneIssues(lane.lane, project.id);
        expect(rows.length, `${lane.lane} in ${project.key}`).toBe(project.count);
        /* A project only appears because it holds something. One with nothing
           waiting is not a choice that leads anywhere. */
        expect(project.count).toBeGreaterThan(0);
        summed += rows.length;
      }
      expect(lane.count, `${lane.lane} total`).toBe(summed);
    }
  });

  it("drops an issue from the lane, and from the count, the moment it is handed out", async () => {
    /* §10: the assigned issue must not still be selectable, and the figure
       must fall. Both follow from the lane being work that is *waiting*. */
    const issueId = await anIssue("IN_REVIEW", "refresh");
    const project = await projectByKey("ENG");
    const admin = await userByEmail(ADMIN);

    const before = await listLaneIssues("QA", project.id);
    expect(before.map((row) => row.id)).toContain(issueId);
    const countBefore = (await loadWorkStatus(admin)).qa.count;

    await actAs(ADMIN);
    const result = await assignWork({
      lane: "QA",
      issueId,
      assigneeId: await userId(TESTER),
    });
    expect(result.ok, result.ok ? "" : result.error).toBe(true);

    const after = await listLaneIssues("QA", project.id);
    expect(after.map((row) => row.id)).not.toContain(issueId);
    expect((await loadWorkStatus(admin)).qa.count).toBe(countBefore - 1);

    const row = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: { assigneeId: true, status: true },
    });
    expect(row.assigneeId).toBe(await userId(TESTER));
    /* Assignment and transition are separate decisions: handing work over
       changes who holds it, not where it is. */
    expect(row.status).toBe("IN_REVIEW");
  });

  it("keeps work whose holder does the other half of the job", async () => {
    /*
     * The reason the lane cannot simply be "unassigned".
     *
     * A Ready for QA issue is normally still on the developer who built it and
     * marked it ready — that is what the hand-off looks like — so it is very
     * much still waiting for a tester. The mirror holds too: work raised by a
     * tester and left on them has nobody building it.
     */
    const forQa = await anIssue("IN_REVIEW", "held-by-developer");
    const forDeveloper = await anIssue("TODO", "held-by-tester");
    const project = await projectByKey("ENG");

    await actAs(ADMIN);
    expect(
      (await updateIssue({ issueId: forQa, assigneeId: await userId(DEVELOPER) }))
        .ok,
    ).toBe(true);
    expect(
      (await updateIssue({
        issueId: forDeveloper,
        assigneeId: await userId(TESTER),
      })).ok,
    ).toBe(true);

    expect(
      (await listLaneIssues("QA", project.id)).map((row) => row.id),
      "a developer holding it is not a tester testing it",
    ).toContain(forQa);

    expect(
      (await listLaneIssues("DEVELOPER", project.id)).map((row) => row.id),
      "a tester holding it is not a developer building it",
    ).toContain(forDeveloper);
  });
});

/* ------------------------------------------------------- who may be chosen */

describe("who a lane may be given to", () => {
  it("offers QA work to whoever does QA work, and to nobody else", async () => {
    const project = await projectByKey("ENG");
    const people = await listLaneMembers("QA", project.id);
    const ids = new Set(people.map((person) => person.id));

    expect(ids.has(await userId(TESTER)), "a tester").toBe(true);
    expect(ids.has(await userId(FULLSTACK)), "a full stack developer").toBe(true);
    /* Belonging to the project is not enough — that is the whole rule. */
    expect(ids.has(await userId(DEVELOPER)), "a pure developer").toBe(false);
  });

  it("offers development work to whoever builds, and to nobody else", async () => {
    const project = await projectByKey("ENG");
    const people = await listLaneMembers("DEVELOPER", project.id);
    const ids = new Set(people.map((person) => person.id));

    expect(ids.has(await userId(DEVELOPER)), "a developer").toBe(true);
    expect(ids.has(await userId(FULLSTACK)), "a full stack developer").toBe(true);
    expect(ids.has(await userId(TESTER)), "a pure tester").toBe(false);
  });

  it("refuses the write too, not only the list", async () => {
    /* The list is the courtesy. A payload naming somebody the list left out is
       what the check on the write is for. */
    const issueId = await anIssue("IN_REVIEW", "ineligible-person");

    await actAs(ADMIN);
    const result = await assignWork({
      lane: "QA",
      issueId,
      assigneeId: await userId(DEVELOPER),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/QA work/i);
  });

  it("refuses an issue that has left the lane since the dialog opened", async () => {
    const issueId = await anIssue("IN_REVIEW", "stale");

    await actAs(ADMIN);
    expect((await updateIssue({ issueId, status: "DONE" })).ok).toBe(true);

    const result = await assignWork({
      lane: "QA",
      issueId,
      assigneeId: await userId(TESTER),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no longer waiting/i);
  });

  it("refuses an issue somebody else has already been given", async () => {
    /* The other way a dialog goes stale: the status is untouched, but a second
       administrator handed the work out while this one was choosing. */
    const issueId = await anIssue("IN_REVIEW", "already-handed-out");

    await actAs(ADMIN);
    expect(
      (await assignWork({
        lane: "QA",
        issueId,
        assigneeId: await userId(TESTER),
      })).ok,
    ).toBe(true);

    const second = await assignWork({
      lane: "QA",
      issueId,
      assigneeId: await userId(FULLSTACK),
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/no longer waiting/i);

    // …and the first assignment stands.
    const row = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: { assigneeId: true },
    });
    expect(row.assigneeId).toBe(await userId(TESTER));
  });
});

/* ------------------------------------------------------------- who may ask */

describe("Work Status is an administrator's", () => {
  it("refuses every call to a developer and to a tester", async () => {
    const issueId = await anIssue("IN_REVIEW", "authorization");
    const project = await projectByKey("ENG");
    const assigneeId = await userId(TESTER);

    for (const email of [DEVELOPER, TESTER]) {
      await actAs(email);

      const issues = await laneIssues({ lane: "QA", projectId: project.id });
      expect(issues.ok, `${email} may not list the lane`).toBe(false);

      const people = await laneMembers({ lane: "QA", projectId: project.id });
      expect(people.ok, `${email} may not list the people`).toBe(false);

      const assigned = await assignWork({ lane: "QA", issueId, assigneeId });
      expect(assigned.ok, `${email} may not assign`).toBe(false);
    }

    // …and nothing was written by any of it.
    const row = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: { assigneeId: true },
    });
    expect(row.assigneeId).toBeNull();
  });

  it("lets an administrator do all three", async () => {
    const issueId = await anIssue("BACKLOG", "admin-happy-path");
    const project = await projectByKey("ENG");

    await actAs(ADMIN);

    const issues = await laneIssues({
      lane: "DEVELOPER",
      projectId: project.id,
    });
    expect(issues.ok).toBe(true);
    if (issues.ok) {
      expect(issues.data.map((row) => row.id)).toContain(issueId);
    }

    const people = await laneMembers({
      lane: "DEVELOPER",
      projectId: project.id,
    });
    expect(people.ok).toBe(true);

    const assigned = await assignWork({
      lane: "DEVELOPER",
      issueId,
      assigneeId: await userId(DEVELOPER),
    });
    expect(assigned.ok, assigned.ok ? "" : assigned.error).toBe(true);
  });
});

/* ------------------------------------------------------------ notification */

describe("the person who is given the work", () => {
  it("is told, through the notification assignment already raises", async () => {
    /* §13: no second notification system. This is the row `updateIssue`
       writes for every assignment, reached through Work Status. */
    const issueId = await anIssue("TODO", "notifies");
    const developerId = await userId(DEVELOPER);

    await actAs(ADMIN);
    const result = await assignWork({
      lane: "DEVELOPER",
      issueId,
      assigneeId: developerId,
    });
    expect(result.ok, result.ok ? "" : result.error).toBe(true);

    const notification = await prisma.notification.findFirst({
      where: { issueId, userId: developerId, type: "ISSUE_ASSIGNED" },
      select: { id: true },
    });
    expect(notification).not.toBeNull();

    // …and an activity entry recording who did it.
    const entry = await prisma.activityLogEntry.findFirst({
      where: { issueId, field: "assigneeId", newValue: developerId },
      select: { actorId: true },
    });
    expect(entry?.actorId).toBe(await userId(ADMIN));
  });
});
