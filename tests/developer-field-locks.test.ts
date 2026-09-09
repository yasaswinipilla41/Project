import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { DEVELOPMENT_TEAM_SLUG, TESTING_TEAM_SLUG } from "@/lib/authz";
import {
  canEditDueDate,
  canEditIssueName,
  canEditPriority,
} from "@/lib/domain";
import { createIssue, updateIssue } from "@/server/issues";
import { actAs, projectByKey } from "./helpers";

/**
 * The three fields a developer may read and not change.
 *
 * The summary, the due date and the priority describe and schedule the work
 * rather than do it. The issue page renders all three read-only for the roles
 * that may not set them, and this is why that is only a courtesy: every case
 * calls `updateIssue` directly, which is the same call a hand-made request
 * makes.
 *
 * The due date is stricter than the other two — nobody but an administrator
 * sets it, a tester included — so it is asserted for both member jobs.
 */

const ADMIN = "admin@symbiosystech.com";
const DEVELOPER = "kiran.das@symbiosystech.com";
const TESTER = "priya.nair@symbiosystech.com";

const created: string[] = [];
const memberships: string[] = [];

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

beforeAll(async () => {
  await join(TESTER, TESTING_TEAM_SLUG);
  await prisma.teamMember.deleteMany({
    where: {
      user: { email: DEVELOPER },
      team: { slug: { in: [TESTING_TEAM_SLUG, DEVELOPMENT_TEAM_SLUG] } },
    },
  });
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
  await prisma.$disconnect();
});

/** An ENG issue with a title, a priority and a due date already on it. */
async function anIssue(title: string): Promise<string> {
  await actAs(ADMIN);
  const project = await projectByKey("ENG");
  const result = await createIssue({
    projectId: project.id,
    type: "TASK",
    title: `${title} ${Date.now()}`,
    description: "fixture",
    status: "TODO",
    priority: "MEDIUM",
    dueDate: "2099-06-01",
  });
  if (!result.ok) throw new Error(result.error);
  created.push(result.data.id);
  return result.data.id;
}

function stateOf(issueId: string) {
  return prisma.issue.findUniqueOrThrow({
    where: { id: issueId },
    select: { title: true, priority: true, dueDate: true, status: true },
  });
}

describe("the rules themselves", () => {
  it("say who may rename, reprioritise and date work", () => {
    expect(canEditIssueName("DEVELOPER")).toBe(false);
    expect(canEditPriority("DEVELOPER")).toBe(false);
    expect(canEditDueDate("DEVELOPER")).toBe(false);

    // A tester keeps the two that describe the work they raise.
    expect(canEditIssueName("QA")).toBe(true);
    expect(canEditPriority("QA")).toBe(true);
    expect(canEditDueDate("QA")).toBe(false);

    for (const rule of [canEditIssueName, canEditPriority, canEditDueDate]) {
      expect(rule("ADMIN")).toBe(true);
    }
  });
});

describe("a developer", () => {
  it("cannot rename an issue", async () => {
    const issueId = await anIssue("Developer rename");
    const before = await stateOf(issueId);

    await actAs(DEVELOPER);
    const result = await updateIssue({ issueId, title: "Renamed by a developer" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/renaming/i);
    expect((await stateOf(issueId)).title).toBe(before.title);
  });

  it("cannot change the priority", async () => {
    const issueId = await anIssue("Developer priority");

    await actAs(DEVELOPER);
    const result = await updateIssue({ issueId, priority: "URGENT" });

    expect(result.ok).toBe(false);
    expect((await stateOf(issueId)).priority).toBe("MEDIUM");
  });

  it("cannot set, move or clear the due date", async () => {
    const issueId = await anIssue("Developer due date");
    const before = await stateOf(issueId);

    await actAs(DEVELOPER);
    for (const dueDate of ["2099-07-01", ""]) {
      const result = await updateIssue({ issueId, dueDate });
      expect(result.ok, `dueDate=${dueDate || "(cleared)"}`).toBe(false);
    }

    expect((await stateOf(issueId)).dueDate?.getTime()).toBe(
      before.dueDate?.getTime(),
    );
  });

  it("still moves the work through the build, which is theirs", async () => {
    const issueId = await anIssue("Developer works");

    await actAs(DEVELOPER);
    for (const status of ["IN_PROGRESS", "IN_REVIEW"] as const) {
      expect((await updateIssue({ issueId, status })).ok, status).toBe(true);
    }
    expect((await stateOf(issueId)).status).toBe("IN_REVIEW");
  });

  it("may re-save the fields it holds, so long as nothing moves", async () => {
    /* A form that posts every field back must not be refused for carrying the
       values it was given. Only a real change is a change. */
    const issueId = await anIssue("Developer re-saves");
    const before = await stateOf(issueId);

    await actAs(DEVELOPER);
    const result = await updateIssue({
      issueId,
      title: before.title,
      priority: before.priority,
      dueDate: before.dueDate!.toISOString().slice(0, 10),
      status: "IN_PROGRESS",
    });

    expect(result.ok).toBe(true);
    expect((await stateOf(issueId)).status).toBe("IN_PROGRESS");
  });
});

describe("a tester", () => {
  it("cannot set the due date either", async () => {
    const issueId = await anIssue("Tester due date");
    const before = await stateOf(issueId);

    await actAs(TESTER);
    const result = await updateIssue({ issueId, dueDate: "2099-08-01" });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/administrator/i);
    expect((await stateOf(issueId)).dueDate?.getTime()).toBe(
      before.dueDate?.getTime(),
    );
  });

  it("keeps the summary and the priority, which describe what they raised", async () => {
    const issueId = await anIssue("Tester describes");

    await actAs(TESTER);
    expect((await updateIssue({ issueId, title: "Renamed by a tester" })).ok).toBe(
      true,
    );
    expect((await updateIssue({ issueId, priority: "HIGH" })).ok).toBe(true);

    const after = await stateOf(issueId);
    expect(after.title).toBe("Renamed by a tester");
    expect(after.priority).toBe("HIGH");
  });
});

describe("an administrator", () => {
  it("sets all three", async () => {
    const issueId = await anIssue("Admin edits");

    await actAs(ADMIN);
    const result = await updateIssue({
      issueId,
      title: "Renamed by an administrator",
      priority: "LOW",
      dueDate: "2099-09-09",
    });
    expect(result.ok).toBe(true);

    const after = await stateOf(issueId);
    expect(after.title).toBe("Renamed by an administrator");
    expect(after.priority).toBe("LOW");
    expect(after.dueDate?.toISOString().slice(0, 10)).toBe("2099-09-09");
  });
});
