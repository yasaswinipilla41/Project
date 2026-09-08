import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { allowedStatusesFor, canSetStatus } from "@/lib/domain";
import { DEVELOPMENT_TEAM_SLUG, TESTING_TEAM_SLUG } from "@/lib/authz";
import { createIssue } from "@/server/issues";
import { actAs, projectByKey } from "./helpers";

/**
 * What a tester may file, and with what on it.
 *
 * Two rules, both asserted against the server rather than the form: a tester
 * raises work without handing it to anybody and without dating it, and files
 * it in a status their half of the job owns. The dialog leaves those fields
 * out and offers the four statuses; that is the courtesy. This is the rule.
 */

const ADMIN = "admin@symbiosystech.com";
const TESTER = "priya.nair@symbiosystech.com";
const FULLSTACK = "meera.pillai@symbiosystech.com";
const DEVELOPER = "kiran.das@symbiosystech.com";

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
  await join(FULLSTACK, TESTING_TEAM_SLUG);
  await join(FULLSTACK, DEVELOPMENT_TEAM_SLUG);
});

afterAll(async () => {
  if (created.length > 0) {
    await prisma.notification.deleteMany({ where: { issueId: { in: created } } });
    await prisma.issue.deleteMany({ where: { id: { in: created } } });
  }
  await prisma.teamMember.deleteMany({ where: { id: { in: memberships } } });
  await prisma.$disconnect();
});

async function userId(email: string): Promise<string> {
  const row = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: { id: true },
  });
  return row.id;
}

describe("the statuses each job may set", () => {
  it("gives a tester the four that testing uses, and nothing of the build", () => {
    expect([...allowedStatusesFor("QA")]).toEqual([
      "IN_REVIEW",
      "IN_QA",
      "DONE",
      "REOPENED",
    ]);
  });

  it("gives a developer the build, and nothing that closes work", () => {
    expect([...allowedStatusesFor("DEVELOPER")]).toEqual([
      "BACKLOG",
      "TODO",
      "IN_PROGRESS",
      "IN_REVIEW",
      "REOPENED",
    ]);
  });

  it("gives an administrator every status", () => {
    expect(allowedStatusesFor("ADMIN")).toHaveLength(9);
    for (const status of ["REJECTED", "CANCELLED", "IN_QA", "DONE"] as const) {
      expect(canSetStatus("ADMIN", "BACKLOG", status)).toBe(true);
    }
  });

  it("gives somebody who does both halves the union of them", () => {
    const both = allowedStatusesFor("FULLSTACK");
    for (const status of [
      "BACKLOG",
      "TODO",
      "IN_PROGRESS",
      "IN_REVIEW",
      "IN_QA",
      "DONE",
      "REOPENED",
    ] as const) {
      expect(both, `${status} is theirs`).toContain(status);
    }
    // Writing work off is still nobody's but an administrator's.
    expect(both).not.toContain("REJECTED");
    expect(both).not.toContain("CANCELLED");
  });

  it("holds Done back until testing has happened, for a tester alone", () => {
    expect(canSetStatus("QA", "IN_REVIEW", "DONE")).toBe(false);
    expect(canSetStatus("QA", "IN_QA", "DONE")).toBe(true);
    // Somebody who also builds keeps the direct route, as does an admin.
    expect(canSetStatus("FULLSTACK", "IN_REVIEW", "DONE")).toBe(true);
    expect(canSetStatus("ADMIN", "IN_REVIEW", "DONE")).toBe(true);
  });
});

describe("a tester filing work", () => {
  it("cannot file it into a status the build owns", async () => {
    await actAs(TESTER);
    const project = await projectByKey("ENG");

    const result = await createIssue({
      projectId: project.id,
      type: "BUG",
      title: `Tester files straight into progress ${Date.now()}`,
      description: "x",
      status: "IN_PROGRESS",
      priority: "MEDIUM",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/in progress/i);
  });

  it("files without an assignee or a due date, whatever the request says", async () => {
    await actAs(TESTER);
    const project = await projectByKey("ENG");

    const result = await createIssue({
      projectId: project.id,
      type: "BUG",
      title: `Tester tries to hand work out ${Date.now()}`,
      description: "x",
      status: "IN_REVIEW",
      priority: "MEDIUM",
      // Exactly what a stale form, or a forged request, would carry.
      assigneeId: await userId(DEVELOPER),
      dueDate: "2099-03-01",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    created.push(result.data.id);

    const row = await prisma.issue.findUniqueOrThrow({
      where: { id: result.data.id },
      select: { assigneeId: true, dueDate: true, reporterId: true },
    });

    expect(row.assigneeId).toBeNull();
    expect(row.dueDate).toBeNull();
    // …and the reporter is the person who filed it.
    expect(row.reporterId).toBe(await userId(TESTER));
  });

  it("keeps both fields for an administrator", async () => {
    await actAs(ADMIN);
    const project = await projectByKey("ENG");
    const assignee = await userId(DEVELOPER);

    const result = await createIssue({
      projectId: project.id,
      type: "TASK",
      title: `Admin files with an assignee ${Date.now()}`,
      description: "x",
      priority: "MEDIUM",
      assigneeId: assignee,
      dueDate: "2099-03-01",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    created.push(result.data.id);

    const row = await prisma.issue.findUniqueOrThrow({
      where: { id: result.data.id },
      select: { assigneeId: true, dueDate: true },
    });
    expect(row.assigneeId).toBe(assignee);
    expect(row.dueDate).not.toBeNull();
  });

  it("keeps both fields for somebody who builds as well as tests", async () => {
    await actAs(FULLSTACK);
    const project = await projectByKey("ENG");
    const assignee = await userId(FULLSTACK);

    const result = await createIssue({
      projectId: project.id,
      type: "TASK",
      title: `Full stack files with an assignee ${Date.now()}`,
      description: "x",
      priority: "MEDIUM",
      assigneeId: assignee,
      dueDate: "2099-03-01",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    created.push(result.data.id);

    const row = await prisma.issue.findUniqueOrThrow({
      where: { id: result.data.id },
      select: { assigneeId: true, dueDate: true },
    });
    expect(row.assigneeId).toBe(assignee);
    expect(row.dueDate).not.toBeNull();
  });
});

describe("the reporter", () => {
  it("is whoever filed the work, for every role that may file", async () => {
    for (const email of [ADMIN, TESTER, FULLSTACK]) {
      await actAs(email);
      const project = await projectByKey("ENG");

      const result = await createIssue({
        projectId: project.id,
        type: "TASK",
        title: `Reporter check ${email} ${Date.now()}`,
        description: "x",
        status: "IN_REVIEW",
        priority: "MEDIUM",
        /* A payload naming somebody else changes nothing: there is no field
           for it, and the reporter is read from the session. */
        reporterId: await userId(DEVELOPER),
      } as unknown as Parameters<typeof createIssue>[0]);

      expect(result.ok, `${email} may file`).toBe(true);
      if (!result.ok) continue;
      created.push(result.data.id);

      const row = await prisma.issue.findUniqueOrThrow({
        where: { id: result.data.id },
        select: { reporterId: true },
      });
      expect(row.reporterId, `${email} is the reporter`).toBe(
        await userId(email),
      );
    }
  });
});
