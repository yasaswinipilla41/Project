import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEVELOPMENT_TEAM_SLUG } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { createIssue } from "@/server/issues";
import { createProject } from "@/server/projects";
import {
  applyBacklogAllocation,
  previewBacklogAllocation,
} from "@/server/backlogAssignment";
import { listLaneMembers } from "@/server/queries/workStatus";
import { actAs, joinTestingTeam } from "./helpers";
import type { Priority } from "@prisma/client";

/**
 * Auto-assigning the backlog, against the real actions and a real database.
 *
 * `backlog-allocation.test.ts` pins the arithmetic; this pins everything around
 * it — who may ask, which work is eligible, who is eligible to receive it, and
 * that a preview really is only a preview.
 *
 * A project of this file's own, because the seeded Engineering backlog runs to
 * hundreds of issues and the run is capped at the most urgent twenty-five.
 * Assertions about "the plan" would otherwise be assertions about the seed.
 */

const ADMIN = "admin@symbiosystech.com";
/** Two people who build. */
const DEVELOPER = "kiran.das@symbiosystech.com";
const SECOND_DEVELOPER = "sneha.iyer@symbiosystech.com";
/** And one who does not, to prove the work is never offered to them. */
const TESTER = "priya.nair@symbiosystech.com";

let projectId = "";
let projectKey = "";
const teamRows: string[] = [];
let leaveTesting: () => Promise<void> = async () => {};

/** Issues this file made, by the shorthand the tests refer to them by. */
const made = new Map<string, string>();

async function userId(email: string): Promise<string> {
  const row = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: { id: true },
  });
  return row.id;
}

async function joinDevelopment(email: string): Promise<void> {
  const [user, team] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } }),
    prisma.team.upsert({
      where: { slug: DEVELOPMENT_TEAM_SLUG },
      update: {},
      create: { slug: DEVELOPMENT_TEAM_SLUG, name: "Development" },
      select: { id: true },
    }),
  ]);

  const existing = await prisma.teamMember.findFirst({
    where: { teamId: team.id, userId: user.id },
    select: { id: true },
  });
  if (existing) return;

  const row = await prisma.teamMember.create({
    data: { teamId: team.id, userId: user.id },
    select: { id: true },
  });
  teamRows.push(row.id);
}

async function anIssue(
  name: string,
  options: {
    status: "BACKLOG" | "TODO" | "REOPENED";
    priority?: Priority;
    assigneeId?: string;
  },
): Promise<string> {
  await actAs(ADMIN);
  const result = await createIssue({
    projectId,
    type: "TASK",
    title: `${name} ${Date.now()}`,
    description: "fixture",
    priority: options.priority ?? "MEDIUM",
    status: options.status,
    assigneeId: options.assigneeId,
  });
  if (!result.ok) throw new Error(result.error);
  made.set(name, result.data.id);
  return result.data.id;
}

async function assigneeOf(issueId: string): Promise<string | null> {
  const row = await prisma.issue.findUniqueOrThrow({
    where: { id: issueId },
    select: { assigneeId: true },
  });
  return row.assigneeId;
}

beforeAll(async () => {
  await actAs(ADMIN);

  projectKey = `AB${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const created = await createProject({
    name: `Auto assign ${Date.now()}`,
    key: projectKey,
    description: "Fixture for backlog auto-assignment.",
  });
  if (!created.ok) throw new Error(created.error);
  projectId = created.data.id;

  /* Two developers and a tester, all on the project. Being on it is half of
     what makes somebody eligible; the other half is what this file is about. */
  await joinDevelopment(DEVELOPER);
  await joinDevelopment(SECOND_DEVELOPER);
  ({ leave: leaveTesting } = await joinTestingTeam(TESTER));

  for (const email of [DEVELOPER, SECOND_DEVELOPER, TESTER]) {
    await prisma.projectMember.upsert({
      where: {
        projectId_userId: { projectId, userId: await userId(email) },
      },
      update: {},
      create: { projectId, userId: await userId(email) },
    });
  }
});

afterAll(async () => {
  /* The project cascades to its issues, their activity and their
     notifications, so this is the whole of the cleanup for the work. */
  if (projectId) await prisma.project.deleteMany({ where: { id: projectId } });
  if (teamRows.length > 0) {
    await prisma.teamMember.deleteMany({ where: { id: { in: teamRows } } });
  }
  await leaveTesting();
  await prisma.$disconnect();
});

describe("who may auto-assign", () => {
  it("refuses a developer and a tester, and writes nothing", async () => {
    const issueId = await anIssue("authorization", { status: "BACKLOG" });

    for (const email of [DEVELOPER, TESTER]) {
      await actAs(email);

      const preview = await previewBacklogAllocation({ projectId });
      expect(preview.ok, `${email} may not preview`).toBe(false);

      const applied = await applyBacklogAllocation({ projectId });
      expect(applied.ok, `${email} may not apply`).toBe(false);
    }

    expect(await assigneeOf(issueId)).toBeNull();
  });
});

describe("what is eligible", () => {
  it("plans backlog work, and no other status", async () => {
    const backlog = await anIssue("eligible-backlog", { status: "BACKLOG" });
    const todo = await anIssue("eligible-todo", { status: "TODO" });
    const reopened = await anIssue("eligible-reopened", { status: "REOPENED" });

    await actAs(ADMIN);
    const preview = await previewBacklogAllocation({ projectId });
    expect(preview.ok, preview.ok ? "" : preview.error).toBe(true);
    if (!preview.ok) return;

    const planned = preview.data.allocations.map((row) => row.issueId);
    expect(planned).toContain(backlog);
    /* New is work somebody has just raised and may still be shaping; Reopen
       goes back to whoever built it. Neither is the pile with nobody's name
       on it. */
    expect(planned).not.toContain(todo);
    expect(planned).not.toContain(reopened);
  });

  it("never takes work off somebody who is already holding it", async () => {
    const held = await anIssue("already-held", {
      status: "BACKLOG",
      assigneeId: await userId(DEVELOPER),
    });

    await actAs(ADMIN);
    const preview = await previewBacklogAllocation({ projectId });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    expect(preview.data.allocations.map((row) => row.issueId)).not.toContain(
      held,
    );
  });

  it("offers the work to developers and never to a tester", async () => {
    await anIssue("recipients", { status: "BACKLOG" });

    await actAs(ADMIN);
    const preview = await previewBacklogAllocation({ projectId });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    /*
     * The eligible set is asked for rather than assumed. A project has members
     * this file never added — a member on no team is a developer by Prio's
     * long-standing default — so listing the two it did add would be asserting
     * the fixture rather than the rule. `listLaneMembers` is the query the
     * manual dialog offers from, and the allocator must not reach past it.
     */
    const eligible = new Set(
      (await listLaneMembers("DEVELOPER", projectId)).map((person) => person.id),
    );
    const testerId = await userId(TESTER);

    expect(eligible.has(testerId), "a pure tester is not a candidate").toBe(
      false,
    );
    expect(preview.data.allocations.length).toBeGreaterThan(0);
    for (const row of preview.data.allocations) {
      expect(eligible.has(row.assigneeId), `${row.assigneeName} builds`).toBe(
        true,
      );
      expect(row.assigneeId).not.toBe(testerId);
    }
  });

  it("places the most urgent work first", async () => {
    const low = await anIssue("priority-low", {
      status: "BACKLOG",
      priority: "LOW",
    });
    const urgent = await anIssue("priority-urgent", {
      status: "BACKLOG",
      priority: "URGENT",
    });

    await actAs(ADMIN);
    const preview = await previewBacklogAllocation({ projectId });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const planned = preview.data.allocations.map((row) => row.issueId);
    expect(planned.indexOf(urgent)).toBeGreaterThanOrEqual(0);
    expect(planned.indexOf(urgent)).toBeLessThan(planned.indexOf(low));
  });
});

describe("previewing and applying", () => {
  it("a preview writes nothing at all", async () => {
    const issueId = await anIssue("preview-only", { status: "BACKLOG" });

    await actAs(ADMIN);
    const preview = await previewBacklogAllocation({ projectId });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    expect(preview.data.assigned).toBe(0);
    expect(await assigneeOf(issueId)).toBeNull();
  });

  it("applying assigns the work, and records it like any other assignment", async () => {
    const issueId = await anIssue("applied", { status: "BACKLOG" });

    await actAs(ADMIN);
    const applied = await applyBacklogAllocation({ projectId });
    expect(applied.ok, applied.ok ? "" : applied.error).toBe(true);
    if (!applied.ok) return;

    expect(applied.data.assigned).toBeGreaterThan(0);

    const holder = await assigneeOf(issueId);
    expect(holder).not.toBeNull();

    /* Through `updateIssue`, so the trail and the notification are the ones
       every other assignment produces rather than a second set. */
    const entry = await prisma.activityLogEntry.findFirst({
      where: { issueId, field: "assigneeId", newValue: holder },
      select: { actorId: true },
    });
    expect(entry?.actorId).toBe(await userId(ADMIN));

    /*
     * `notify` never tells somebody about their own act, and an administrator
     * is an eligible developer here like anybody else — so the notice exists
     * exactly when the work went to somebody other than the person who ran it.
     * Stated as an equality rather than a conditional assertion, so both cases
     * are actually checked.
     */
    const notice = await prisma.notification.findFirst({
      where: { issueId, userId: holder!, type: "ISSUE_ASSIGNED" },
      select: { id: true },
    });
    expect(notice === null).toBe(holder === (await userId(ADMIN)));
  });

  it("leaves nothing waiting that it said it would place", async () => {
    await anIssue("drains-1", { status: "BACKLOG" });
    await anIssue("drains-2", { status: "BACKLOG" });

    await actAs(ADMIN);
    const before = await previewBacklogAllocation({ projectId });
    expect(before.ok).toBe(true);
    if (!before.ok) return;

    const applied = await applyBacklogAllocation({ projectId });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    /* Everything the plan named is now held, so a second preview has less to
       do — the figure on the card and the work behind it stay in step. */
    const after = await previewBacklogAllocation({ projectId });
    expect(after.ok).toBe(true);
    if (!after.ok) return;

    expect(after.data.waiting).toBeLessThan(before.data.waiting);
  });
});
