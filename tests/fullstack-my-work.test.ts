import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IssueStatus } from "@prisma/client";
import {
  DEVELOPMENT_TEAM_SLUG,
  FULLSTACK_TEAM_SLUG,
  TESTING_TEAM_SLUG,
  issueScope,
  workRoleOf,
} from "@/lib/authz";
import {
  DEVELOPMENT_STATUSES,
  OPEN_STATUSES,
  QA_STATUSES,
} from "@/lib/domain";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { createIssue } from "@/server/issues";
import { actAs, projectByKey } from "./helpers";

/**
 * My Work for somebody who does both jobs.
 *
 * A full stack member builds and checks, so their page has to carry the whole
 * workflow: the Developer statuses and the QA statuses, each appearing once.
 *
 * The page does not keep two lists to do that. It renders a block for every
 * open status the reader holds work in, and `OPEN_STATUSES` is precisely the
 * open half of `DEVELOPMENT_STATUSES` together with `QA_STATUSES` — which the
 * first test pins, because it is the reason the page is already right rather
 * than a coincidence it happens to be. Scoping the blocks per role would have
 * *removed* blocks from developers and testers, who reach these statuses too.
 *
 * Everything below reproduces the page's own rule — assigned to me, in a
 * project I may open — through the same helpers, against the same database.
 */

const ADMIN = "admin@symbiosystech.com";
const FULLSTACK = "meera.pillai@symbiosystech.com";
const DEVELOPER = "kiran.das@symbiosystech.com";
const TESTER = "priya.nair@symbiosystech.com";

const created: string[] = [];
const teamRows: string[] = [];
const suspended: { teamId: string; userId: string }[] = [];
let projectId = "";

const TEAM_NAMES: Record<string, string> = {
  [TESTING_TEAM_SLUG]: "Testing",
  [DEVELOPMENT_TEAM_SLUG]: "Development",
  [FULLSTACK_TEAM_SLUG]: "Full Stack Developers",
};

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
    prisma.team.upsert({
      where: { slug },
      update: {},
      create: { slug, name: TEAM_NAMES[slug] ?? slug },
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

async function leaveFor(email: string, slug: string): Promise<void> {
  const [user, team] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } }),
    prisma.team.findUnique({ where: { slug }, select: { id: true } }),
  ]);
  if (!team) return;

  const existing = await prisma.teamMember.findFirst({
    where: { teamId: team.id, userId: user.id },
    select: { id: true },
  });
  if (!existing) return;

  await prisma.teamMember.delete({ where: { id: existing.id } });
  suspended.push({ teamId: team.id, userId: user.id });
}

/** The one fragment `my-work/page.tsx` builds every figure and list from. */
function assignedWhere(user: CurrentUser) {
  return {
    ...issueScope(user),
    assigneeId: user.id,
    status: { in: [...OPEN_STATUSES] },
  };
}

/**
 * The status blocks My Work would render for this person: one per open status
 * they actually hold work in, in the page's own order.
 */
async function blocksFor(user: CurrentUser): Promise<IssueStatus[]> {
  const rows = await prisma.issue.findMany({
    where: assignedWhere(user),
    select: { status: true },
  });
  const held = new Set(rows.map((row) => row.status));
  return OPEN_STATUSES.filter((status) => held.has(status));
}

/** How many issues each block holds, straight from the database. */
async function countsFor(user: CurrentUser): Promise<Map<IssueStatus, number>> {
  const rows = await prisma.issue.findMany({
    where: assignedWhere(user),
    select: { status: true },
  });
  const counts = new Map<IssueStatus, number>();
  for (const row of rows) {
    counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  }
  return counts;
}

/** An ENG issue filed straight into `status` and handed to somebody. */
async function anIssue(status: IssueStatus, assigneeId: string): Promise<string> {
  await actAs(ADMIN);
  const result = await createIssue({
    projectId,
    type: "TASK",
    title: `Full stack my work ${status} ${Date.now()}-${Math.random()}`,
    description: "fixture",
    priority: "MEDIUM",
    status,
    assigneeId,
  });
  if (!result.ok) throw new Error(result.error);
  created.push(result.data.id);
  return result.data.id;
}

/** The open statuses belonging to each half of the job. */
const DEVELOPER_SIDE = DEVELOPMENT_STATUSES.filter((status) =>
  (OPEN_STATUSES as readonly IssueStatus[]).includes(status),
);
const QA_SIDE = QA_STATUSES.filter((status) =>
  (OPEN_STATUSES as readonly IssueStatus[]).includes(status),
);

beforeAll(async () => {
  projectId = (await projectByKey("ENG")).id;

  await leaveFor(FULLSTACK, TESTING_TEAM_SLUG);
  await leaveFor(FULLSTACK, DEVELOPMENT_TEAM_SLUG);
  await join(FULLSTACK, FULLSTACK_TEAM_SLUG);

  await leaveFor(DEVELOPER, TESTING_TEAM_SLUG);
  await leaveFor(DEVELOPER, FULLSTACK_TEAM_SLUG);
  await join(DEVELOPER, DEVELOPMENT_TEAM_SLUG);

  await leaveFor(TESTER, DEVELOPMENT_TEAM_SLUG);
  await leaveFor(TESTER, FULLSTACK_TEAM_SLUG);
  await join(TESTER, TESTING_TEAM_SLUG);

  for (const email of [FULLSTACK, DEVELOPER, TESTER]) {
    const person = await userByEmail(email);
    await prisma.projectMember.upsert({
      where: { projectId_userId: { projectId, userId: person.id } },
      update: {},
      create: { projectId, userId: person.id },
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
  if (teamRows.length > 0) {
    await prisma.teamMember.deleteMany({ where: { id: { in: teamRows } } });
  }
  for (const row of suspended) {
    await prisma.teamMember.upsert({
      where: { teamId_userId: { teamId: row.teamId, userId: row.userId } },
      update: {},
      create: { teamId: row.teamId, userId: row.userId },
    });
  }
  await prisma.$disconnect();
});

describe("the blocks My Work can render", () => {
  it("are the Developer and QA statuses together, each exactly once", async () => {
    /*
     * The invariant the whole page rests on. If a status were ever added to one
     * half and not to `OPEN_STATUSES`, a full stack member would silently stop
     * seeing that part of their workflow — this is the guard that would fire.
     */
    const union = new Set<IssueStatus>([...DEVELOPER_SIDE, ...QA_SIDE]);

    expect(new Set(OPEN_STATUSES)).toEqual(union);
    expect(
      OPEN_STATUSES.length,
      "no status is listed twice",
    ).toBe(new Set(OPEN_STATUSES).size);
  });

  it("covers both halves — neither list is empty", async () => {
    /* Guards the test above from passing vacuously. */
    expect(DEVELOPER_SIDE.length).toBeGreaterThan(0);
    expect(QA_SIDE.length).toBeGreaterThan(0);
  });
});

describe("a full stack member's My Work", () => {
  it("resolves to FULLSTACK from the membership alone", async () => {
    expect(await workRoleOf(await userByEmail(FULLSTACK))).toBe("FULLSTACK");
  });

  it("carries the Developer statuses and the QA statuses, each once", async () => {
    const person = await userByEmail(FULLSTACK);
    for (const status of [...DEVELOPER_SIDE, ...QA_SIDE]) {
      await anIssue(status, person.id);
    }

    const blocks = await blocksFor(person);

    for (const status of DEVELOPER_SIDE) {
      expect(blocks, `${status} is a Developer block`).toContain(status);
    }
    for (const status of QA_SIDE) {
      expect(blocks, `${status} is a QA block`).toContain(status);
    }
    expect(blocks.length, "no status rendered twice").toBe(
      new Set(blocks).size,
    );
  });

  it("counts each block from the issues actually held", async () => {
    const person = await userByEmail(FULLSTACK);
    const counts = await countsFor(person);

    for (const [status, count] of counts) {
      const real = await prisma.issue.count({
        where: { ...assignedWhere(person), status },
      });
      expect(count, `${status} count is the database's`).toBe(real);
      expect(count).toBeGreaterThan(0);
    }
  });

  it("leaves out work held by somebody else", async () => {
    const person = await userByEmail(FULLSTACK);
    const developer = await userByEmail(DEVELOPER);
    const theirs = await anIssue("IN_PROGRESS", developer.id);

    const mine = await prisma.issue.findMany({
      where: assignedWhere(person),
      select: { id: true },
    });
    expect(mine.map((row) => row.id)).not.toContain(theirs);
  });

  it("leaves out work in a project they cannot open", async () => {
    const person = await userByEmail(FULLSTACK);
    const issueId = await anIssue("TODO", person.id);

    const membership = await prisma.projectMember.findUniqueOrThrow({
      where: { projectId_userId: { projectId, userId: person.id } },
      select: { id: true },
    });
    await prisma.projectMember.delete({ where: { id: membership.id } });

    try {
      const visible = await prisma.issue.findMany({
        where: assignedWhere(person),
        select: { id: true },
      });
      expect(visible.map((row) => row.id)).not.toContain(issueId);

      /* Still theirs — access decides what is shown, not who holds it. */
      const row = await prisma.issue.findUniqueOrThrow({
        where: { id: issueId },
        select: { assigneeId: true },
      });
      expect(row.assigneeId).toBe(person.id);
    } finally {
      await prisma.projectMember.create({
        data: { projectId, userId: person.id },
      });
    }
  });
});

describe("the other roles are unchanged", () => {
  it("still gives a developer every status they hold work in", async () => {
    /*
     * The preservation case. Scoping blocks to a role would have taken In QA
     * and Reopen off a developer's page — they reach those statuses whenever
     * their work is being checked or comes back — so this asserts a developer
     * keeps a QA-side block.
     */
    const developer = await userByEmail(DEVELOPER);
    await anIssue("IN_QA", developer.id);
    await anIssue("IN_PROGRESS", developer.id);

    const blocks = await blocksFor(developer);
    expect(blocks, "a developer keeps the QA-side block").toContain("IN_QA");
    expect(blocks).toContain("IN_PROGRESS");
  });

  it("still gives a tester every status they hold work in", async () => {
    const tester = await userByEmail(TESTER);
    await anIssue("IN_REVIEW", tester.id);
    await anIssue("IN_QA", tester.id);

    const blocks = await blocksFor(tester);
    expect(blocks, "a tester keeps the Developer-side block").toContain(
      "IN_REVIEW",
    );
    expect(blocks).toContain("IN_QA");
  });

  it("keeps an administrator's page to their own assignments", async () => {
    const admin = await userByEmail(ADMIN);
    const developer = await userByEmail(DEVELOPER);
    const theirs = await anIssue("TODO", developer.id);

    const rows = await prisma.issue.findMany({
      where: assignedWhere(admin),
      select: { id: true, assigneeId: true },
    });
    expect(rows.map((row) => row.id)).not.toContain(theirs);
    for (const row of rows) expect(row.assigneeId).toBe(admin.id);
  });
});
