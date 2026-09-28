import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createIssue } from "@/server/issues";
import {
  addIssuesToSprint,
  completeSprint,
  createSprint,
  moveIssueToSprint,
  startSprint,
} from "@/server/sprints";
import { actAs } from "./helpers";

/**
 * One rule, asked of every way there is to break it:
 *
 *     an issue's project and its sprint's project are the same project
 *
 * `tests/sprints.test.ts` covers the sprint lifecycle and asserts this rule
 * where it comes up naturally. This file exists to ask it deliberately — of
 * every server path that can write `sprintId`, including the ones no interface
 * offers, and with the *whole* issue compared before and after rather than
 * just its sprint. A rule that holds because the picker only lists the right
 * sprints is not enforced; it is merely hard to break by accident.
 *
 * The four writers, found by reading every `sprintId` write in `src/server`
 * and every schema that carries one — both live only in `server/sprints.ts`:
 *
 *   `addIssuesToSprint`      filling a sprint
 *   `removeIssueFromSprint`  emptying one (writes null, so it cannot offend)
 *   `moveIssueToSprint`      SPRINT, PREVIOUS, NEXT_SPRINT, BACKLOG
 *   `completeSprint`         carrying unfinished work over
 *
 * Nothing else assigns a sprint: `server/issues.ts` never touches the field,
 * so creating and editing work cannot; the sprint board's drag sends a status
 * and nothing more; duplicating a project copies issues without their sprints;
 * and the import has no sprint column. Each of the four is called here
 * directly, which is the point — no route, no form, no picker in the way.
 */

const ADMIN = "admin@symbiosystech.com";

const createdProjects: string[] = [];
const createdSprints: string[] = [];
const createdIssues: string[] = [];

let fixtureCount = 0;

/** A project with only the administrator in it, on a key of its own. */
async function makeProject(label: string): Promise<string> {
  const admin = await prisma.user.findUniqueOrThrow({
    where: { email: ADMIN },
    select: { id: true },
  });
  fixtureCount += 1;
  const key = `INV${fixtureCount}${Date.now().toString(36).toUpperCase()}`.slice(
    0,
    10,
  );
  const project = await prisma.project.create({
    data: {
      key,
      name: `Invariant fixture ${label} ${key}`,
      createdById: admin.id,
      members: { create: { userId: admin.id } },
    },
    select: { id: true },
  });
  createdProjects.push(project.id);
  return project.id;
}

function dates(offsetDays: number) {
  const start = new Date();
  start.setDate(start.getDate() + offsetDays);
  const end = new Date(start);
  end.setDate(end.getDate() + 13);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

async function makeSprint(
  projectId: string,
  name: string,
  offsetDays = 0,
): Promise<string> {
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

async function makeIssue(projectId: string, title: string): Promise<string> {
  const result = await createIssue({ projectId, type: "TASK", title });
  if (!result.ok) throw new Error(`createIssue failed: ${result.error}`);
  const issue = await prisma.issue.findUniqueOrThrow({
    where: { key: result.data.key },
    select: { id: true },
  });
  createdIssues.push(issue.id);
  return issue.id;
}

/**
 * Everything about an issue that a rejected write must leave alone.
 *
 * The whole row, not a chosen field or two: "does not persist the sprint" is a
 * weaker claim than "changes nothing", and the second is what is wanted. The
 * activity trail is counted alongside it, because a refusal that still wrote
 * history would be a partial write of exactly the kind §18 rules out.
 */
async function snapshot(issueId: string) {
  const [issue, history] = await Promise.all([
    prisma.issue.findUniqueOrThrow({ where: { id: issueId } }),
    prisma.activityLogEntry.count({ where: { issueId } }),
  ]);
  return { issue, history };
}

afterAll(async () => {
  if (createdSprints.length > 0) {
    await prisma.sprint.deleteMany({ where: { id: { in: createdSprints } } });
  }
  if (createdIssues.length > 0) {
    await prisma.activityLogEntry.deleteMany({
      where: { issueId: { in: createdIssues } },
    });
    await prisma.issue.deleteMany({ where: { id: { in: createdIssues } } });
  }
  if (createdProjects.length > 0) {
    await prisma.project.deleteMany({ where: { id: { in: createdProjects } } });
  }
});

describe("a sprint takes its own project's work", () => {
  it("accepts an issue from the sprint's project, and records the project it was already in", async () => {
    await actAs(ADMIN);
    const projectId = await makeProject("valid");
    const sprintId = await makeSprint(projectId, "Sprint one");
    const issueId = await makeIssue(projectId, "Work that belongs here");

    const result = await addIssuesToSprint({ sprintId, issueIds: [issueId] });
    expect(result.ok).toBe(true);

    const after = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: { sprintId: true, projectId: true },
    });
    /* Both halves of the invariant, read back from the database rather than
       taken from the action's own answer. */
    expect(after.sprintId).toBe(sprintId);
    expect(after.projectId).toBe(projectId);
  });

  it("refuses an issue from another project, and leaves both projects as they were", async () => {
    await actAs(ADMIN);
    const home = await makeProject("home");
    const foreign = await makeProject("foreign");
    const foreignSprint = await makeSprint(foreign, "Somebody else's sprint");
    const issueId = await makeIssue(home, "Work that must stay put");

    const before = await snapshot(issueId);

    const result = await addIssuesToSprint({
      sprintId: foreignSprint,
      issueIds: [issueId],
    });
    expect(result.ok).toBe(false);

    const after = await snapshot(issueId);
    expect(after.issue).toEqual(before.issue);
    expect(after.history).toBe(before.history);
    /* And the sprint it was aimed at is still empty, so nothing landed there
       under another id. */
    expect(await prisma.issue.count({ where: { sprintId: foreignSprint } })).toBe(0);
  });
});

describe("moving an issue between sprints", () => {
  it("moves it within its own project, changing the sprint and nothing else", async () => {
    await actAs(ADMIN);
    const projectId = await makeProject("move");
    const first = await makeSprint(projectId, "Sprint one", 0);
    const second = await makeSprint(projectId, "Sprint two", 14);
    const issueId = await makeIssue(projectId, "Work that moves on");

    await addIssuesToSprint({ sprintId: first, issueIds: [issueId] });
    const before = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
    });

    const result = await moveIssueToSprint({
      issueId,
      destination: { type: "SPRINT", sprintId: second },
    });
    expect(result.ok).toBe(true);

    const after = await prisma.issue.findUniqueOrThrow({ where: { id: issueId } });
    expect(after.sprintId).toBe(second);
    expect(after.projectId).toBe(before.projectId);
    expect(after.status).toBe(before.status);
    /* The move writes exactly three things: the sprint, the note of where it
       came from, and `updatedAt`. Everything else is compared field by field. */
    expect({
      ...after,
      sprintId: null,
      previousSprintId: null,
      updatedAt: before.updatedAt,
    }).toEqual({
      ...before,
      sprintId: null,
      previousSprintId: null,
      updatedAt: before.updatedAt,
    });
    expect(after.previousSprintId).toBe(first);
  });

  it("refuses a named sprint in another project, and persists nothing", async () => {
    await actAs(ADMIN);
    const home = await makeProject("named-home");
    const foreign = await makeProject("named-foreign");
    const homeSprint = await makeSprint(home, "Its own sprint");
    const foreignSprint = await makeSprint(foreign, "Another project's sprint");
    const issueId = await makeIssue(home, "Work aimed across a boundary");

    await addIssuesToSprint({ sprintId: homeSprint, issueIds: [issueId] });
    const before = await snapshot(issueId);

    const result = await moveIssueToSprint({
      issueId,
      destination: { type: "SPRINT", sprintId: foreignSprint },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/belongs to this issue's project/i);

    const after = await snapshot(issueId);
    expect(after.issue).toEqual(before.issue);
    expect(after.history).toBe(before.history);
    /* Still in the sprint it started in — a rejected move is not a removal. */
    expect(after.issue.sprintId).toBe(homeSprint);
  });

  it("will not restore an issue into another project's sprint", async () => {
    /*
     * `PREVIOUS` is the one destination a caller cannot name: it is read from
     * the issue's own note of where it came from. That makes its project check
     * unreachable through the interface — and therefore the one most worth
     * asserting, because a check that cannot be reached is a check nobody
     * notices removing.
     *
     * So the note is written directly, which is the only way to produce the
     * state it guards against: an issue pointing back at a sprint in another
     * project.
     */
    await actAs(ADMIN);
    const home = await makeProject("restore-home");
    const foreign = await makeProject("restore-foreign");
    const homeSprint = await makeSprint(home, "Where it is now");
    const foreignSprint = await makeSprint(foreign, "Where it claims to be from");
    const issueId = await makeIssue(home, "Work with a foreign history");

    await addIssuesToSprint({ sprintId: homeSprint, issueIds: [issueId] });
    await prisma.issue.update({
      where: { id: issueId },
      data: { previousSprintId: foreignSprint },
    });

    const before = await snapshot(issueId);

    const result = await moveIssueToSprint({
      issueId,
      destination: { type: "PREVIOUS" },
    });
    expect(result.ok).toBe(false);

    const after = await snapshot(issueId);
    expect(after.issue).toEqual(before.issue);
    expect(after.history).toBe(before.history);
    expect(after.issue.sprintId).toBe(homeSprint);

    /* The note was written here to make a state the application cannot
       produce, so it is taken back out: the audit at the end of this file
       reads the whole database, and this row would be the violation it is
       looking for. */
    await prisma.issue.update({
      where: { id: issueId },
      data: { previousSprintId: null },
    });
  });

  it("never reaches into another project for the next sprint", async () => {
    /*
     * `NEXT_SPRINT` names no sprint at all — the server chooses one. The
     * choice is scoped to the issue's own project, so a project whose only
     * later open sprint belongs to somebody else has no next sprint, and is
     * told so rather than being given theirs.
     */
    await actAs(ADMIN);
    const home = await makeProject("next-home");
    const foreign = await makeProject("next-foreign");
    const homeSprint = await makeSprint(home, "The only one here", 0);
    /* Later than the issue's sprint, open, and in the wrong project — exactly
       what an unscoped query would return. */
    await makeSprint(foreign, "A tempting later sprint", 14);
    const issueId = await makeIssue(home, "Work with nowhere to go");

    await addIssuesToSprint({ sprintId: homeSprint, issueIds: [issueId] });
    const before = await snapshot(issueId);

    const result = await moveIssueToSprint({
      issueId,
      destination: { type: "NEXT_SPRINT" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no future sprint/i);

    const after = await snapshot(issueId);
    expect(after.issue).toEqual(before.issue);
    expect(after.history).toBe(before.history);
  });
});

describe("completing a sprint", () => {
  it("will not carry unfinished work into another project's sprint, and completes nothing", async () => {
    await actAs(ADMIN);
    const home = await makeProject("complete-home");
    const foreign = await makeProject("complete-foreign");
    const running = await makeSprint(home, "The sprint being closed");
    const foreignSprint = await makeSprint(foreign, "Another project's sprint");
    const issueId = await makeIssue(home, "Unfinished work");

    await addIssuesToSprint({ sprintId: running, issueIds: [issueId] });
    const started = await startSprint({ sprintId: running });
    expect(started.ok).toBe(true);

    const before = await snapshot(issueId);

    const result = await completeSprint({
      sprintId: running,
      moveIncompleteTo: "NEXT_SPRINT",
      nextSprintId: foreignSprint,
    });
    expect(result.ok).toBe(false);

    /*
     * Nothing half-done: the issue is untouched, the sprint is still running
     * rather than closed, and no outcome rows were written for it. Completing
     * a sprint is several writes in one transaction, so this is the case where
     * a partial commit would actually show.
     */
    const after = await snapshot(issueId);
    expect(after.issue).toEqual(before.issue);
    expect(after.history).toBe(before.history);
    expect(
      await prisma.sprint.findUniqueOrThrow({
        where: { id: running },
        select: { status: true, completedAt: true },
      }),
    ).toMatchObject({ status: "ACTIVE", completedAt: null });
    expect(
      await prisma.sprintIssueOutcome.count({ where: { sprintId: running } }),
    ).toBe(0);

    /* Left as it was so the suite's own rule — one sprint running per project
       — holds for whatever runs next. */
    await completeSprint({ sprintId: running, moveIncompleteTo: "BACKLOG" });
  });
});

describe("the rule as it stands in the data", () => {
  it("holds for every issue in the database, not only the ones made here", async () => {
    /*
     * The invariant read straight off the tables, which is the only way to
     * find a row that predates the checks or arrived some way nobody thought
     * of. `previousSprintId` is included: it is the sprint a Restore would
     * aim at, so a foreign one there is a cross-project move waiting for
     * somebody to press the button.
     *
     * This is a report, not a repair. A violation fails this test and is
     * fixed by deciding what the row should say — never by a migration that
     * rewrites somebody's work to make a test pass.
     */
    const [offending] = await prisma.$queryRaw<
      { sprint_violations: bigint; previous_violations: bigint }[]
    >`
      SELECT
        (SELECT count(*) FROM issue i
           JOIN sprint s ON i."sprintId" = s.id
          WHERE i."projectId" <> s."projectId") AS sprint_violations,
        (SELECT count(*) FROM issue i
           JOIN sprint s ON i."previousSprintId" = s.id
          WHERE i."projectId" <> s."projectId") AS previous_violations
    `;

    expect(Number(offending?.sprint_violations ?? 0)).toBe(0);
    expect(Number(offending?.previous_violations ?? 0)).toBe(0);
  });
});
