import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEVELOPMENT_TEAM_SLUG,
  FULLSTACK_TEAM_SLUG,
  TESTING_TEAM_SLUG,
} from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { createIssue, updateIssue } from "@/server/issues";
import { recordTestResult } from "@/server/qa";
import { actAs, projectByKey } from "./helpers";

/**
 * Who hears about a full stack member's Developer or QA activity.
 *
 * A full stack member holds both halves of the job, so the people an ordinary
 * hand-off would tell are frequently themselves in the other half, or
 * colleagues with no part in the work. Their workflow activity is reported to
 * the administrators instead — and to nobody else.
 *
 * Every case below puts a developer, a tester and a *second* full stack member
 * on the issue as watchers first, so each of them would certainly have been
 * notified under the ordinary rule. An implementation that simply added the
 * administrators without removing the rest would pass a test that only checked
 * the administrators, so each excluded party is asserted by name.
 *
 * The role is never sent: every action here is called the way a browser calls
 * it, and the actor is resolved from the session inside the server action.
 */

const ADMIN = "admin@symbiosystech.com";
const FULLSTACK = "meera.pillai@symbiosystech.com";
const OTHER_FULLSTACK = "sneha.iyer@symbiosystech.com";
const DEVELOPER = "kiran.das@symbiosystech.com";
const TESTER = "priya.nair@symbiosystech.com";

const created: string[] = [];
const teamRows: string[] = [];
const suspended: { teamId: string; userId: string }[] = [];
let projectId = "";

async function userId(email: string): Promise<string> {
  const row = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: { id: true },
  });
  return row.id;
}

const TEAM_NAMES: Record<string, string> = {
  [TESTING_TEAM_SLUG]: "Testing",
  [DEVELOPMENT_TEAM_SLUG]: "Development",
  [FULLSTACK_TEAM_SLUG]: "Full Stack Developers",
};

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

/** Takes somebody off a roster for the run, remembering to put them back. */
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

/** Every active administrator — the audience a workflow activity redirects to. */
async function administrators(): Promise<string[]> {
  const rows = await prisma.user.findMany({
    where: { role: "ADMIN", isActive: true },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

/** Puts people on the issue so the ordinary rule would certainly tell them. */
async function watch(issueId: string, emails: string[]): Promise<void> {
  for (const email of emails) {
    await prisma.issueWatcher.createMany({
      data: [{ issueId, userId: await userId(email) }],
      skipDuplicates: true,
    });
  }
}

/** Who was notified about this issue, optionally since a moment. */
async function notifiedAbout(
  issueId: string,
  since?: Date,
): Promise<{ userId: string; type: string; message: string }[]> {
  return prisma.notification.findMany({
    where: { issueId, ...(since ? { createdAt: { gte: since } } : {}) },
    select: { userId: true, type: true, message: true },
  });
}

/** An ENG issue raised by the administrator, parked where the case needs it. */
async function anIssue(
  title: string,
  patch?: { assigneeId?: string; status?: "TODO" | "IN_PROGRESS" | "IN_QA" },
): Promise<string> {
  await actAs(ADMIN);
  const result = await createIssue({
    projectId,
    type: "TASK",
    title: `${title} ${Date.now()}-${Math.random()}`,
    description: "fixture",
    priority: "MEDIUM",
    status: "TODO",
  });
  if (!result.ok) throw new Error(result.error);
  created.push(result.data.id);

  if (patch) {
    const applied = await updateIssue({ issueId: result.data.id, ...patch });
    if (!applied.ok) throw new Error(applied.error);
  }
  return result.data.id;
}

beforeAll(async () => {
  projectId = (await projectByKey("ENG")).id;

  /* Two full stack members by the independent membership, a pure developer and
     a pure tester — the four roles these rules distinguish between. */
  for (const email of [FULLSTACK, OTHER_FULLSTACK]) {
    await leaveFor(email, TESTING_TEAM_SLUG);
    await leaveFor(email, DEVELOPMENT_TEAM_SLUG);
    await join(email, FULLSTACK_TEAM_SLUG);
  }

  await leaveFor(DEVELOPER, TESTING_TEAM_SLUG);
  await leaveFor(DEVELOPER, FULLSTACK_TEAM_SLUG);
  await join(DEVELOPER, DEVELOPMENT_TEAM_SLUG);

  await leaveFor(TESTER, DEVELOPMENT_TEAM_SLUG);
  await leaveFor(TESTER, FULLSTACK_TEAM_SLUG);
  await join(TESTER, TESTING_TEAM_SLUG);

  for (const email of [FULLSTACK, OTHER_FULLSTACK, DEVELOPER, TESTER]) {
    await prisma.projectMember.upsert({
      where: { projectId_userId: { projectId, userId: await userId(email) } },
      update: {},
      create: { projectId, userId: await userId(email) },
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

describe("a full stack member's Developer activity", () => {
  it("is reported to the administrators, and to nobody else", async () => {
    const issueId = await anIssue("Full stack builds", {
      assigneeId: await userId(FULLSTACK),
    });
    await watch(issueId, [DEVELOPER, TESTER, OTHER_FULLSTACK]);

    const since = new Date();
    await actAs(FULLSTACK);
    const moved = await updateIssue({ issueId, status: "IN_PROGRESS" });
    expect(moved.ok, moved.ok ? "" : moved.error).toBe(true);

    const told = await notifiedAbout(issueId, since);
    const recipients = new Set(told.map((row) => row.userId));
    const admins = await administrators();

    expect(recipients.size, "somebody was told").toBeGreaterThan(0);
    for (const recipient of recipients) {
      expect(admins, `${recipient} is an administrator`).toContain(recipient);
    }

    /* Each of these would have been told under the ordinary rule — they are
       watching the issue — so their absence is the rule working rather than an
       empty audience. */
    expect(recipients.has(await userId(DEVELOPER))).toBe(false);
    expect(recipients.has(await userId(TESTER))).toBe(false);
    expect(recipients.has(await userId(OTHER_FULLSTACK))).toBe(false);
  });

  it("keeps the notification exactly as it was, apart from who gets it", async () => {
    const issueId = await anIssue("Full stack hands over", {
      assigneeId: await userId(FULLSTACK),
    });
    const key = (
      await prisma.issue.findUniqueOrThrow({
        where: { id: issueId },
        select: { key: true },
      })
    ).key;

    const since = new Date();
    await actAs(FULLSTACK);
    expect((await updateIssue({ issueId, status: "IN_REVIEW" })).ok).toBe(true);

    const told = await notifiedAbout(issueId, since);
    expect(told.length).toBeGreaterThan(0);

    /* The same row shape, the same type and the same sentence the workflow has
       always written — only the recipient list was decided differently. */
    const statusNotice = told.find((row) => row.message.includes(key));
    expect(statusNotice, "the issue key is still named").toBeTruthy();
    expect(["STATUS_CHANGED", "ISSUE_ASSIGNED"]).toContain(statusNotice!.type);
  });
});

describe("a full stack member's QA activity", () => {
  it("is reported to the administrators, and to nobody else", async () => {
    const issueId = await anIssue("Full stack checks", {
      assigneeId: await userId(FULLSTACK),
      status: "IN_QA",
    });
    await watch(issueId, [DEVELOPER, TESTER, OTHER_FULLSTACK]);

    const since = new Date();
    await actAs(FULLSTACK);
    const done = await updateIssue({ issueId, status: "DONE" });
    expect(done.ok, done.ok ? "" : done.error).toBe(true);

    const recipients = new Set(
      (await notifiedAbout(issueId, since)).map((row) => row.userId),
    );
    const admins = await administrators();

    expect(recipients.size).toBeGreaterThan(0);
    for (const recipient of recipients) {
      expect(admins).toContain(recipient);
    }
    expect(recipients.has(await userId(DEVELOPER))).toBe(false);
    expect(recipients.has(await userId(TESTER))).toBe(false);
    expect(recipients.has(await userId(OTHER_FULLSTACK))).toBe(false);
  });

  it("redirects a QA verdict too, and tells the developer nothing", async () => {
    /* Recording a verdict is the reporter's, so the full stack member raises
       this one and hands it to the developer whose work it then judges. */
    await actAs(FULLSTACK);
    const raised = await createIssue({
      projectId,
      type: "BUG",
      title: `Full stack verdict ${Date.now()}`,
      description: "fixture",
      priority: "MEDIUM",
      assigneeId: await userId(DEVELOPER),
    });
    if (!raised.ok) throw new Error(raised.error);
    created.push(raised.data.id);

    const since = new Date();
    await actAs(FULLSTACK);
    const verdict = await recordTestResult({
      issueId: raised.data.id,
      result: "FAILED",
    });
    expect(verdict.ok, verdict.ok ? "" : verdict.error).toBe(true);

    const told = await notifiedAbout(raised.data.id, since);
    const recipients = new Set(told.map((row) => row.userId));
    const admins = await administrators();

    expect(told.some((row) => row.type === "TEST_RESULT")).toBe(true);
    for (const recipient of recipients) {
      expect(admins).toContain(recipient);
    }
    expect(
      recipients.has(await userId(DEVELOPER)),
      "the assignee would ordinarily hear about a failed verdict",
    ).toBe(false);
  });
});

describe("everybody else is untouched", () => {
  it("leaves a developer's own activity reaching its ordinary audience", async () => {
    const issueId = await anIssue("Developer builds", {
      assigneeId: await userId(DEVELOPER),
    });
    await watch(issueId, [TESTER]);

    const since = new Date();
    await actAs(DEVELOPER);
    expect((await updateIssue({ issueId, status: "IN_PROGRESS" })).ok).toBe(true);

    const recipients = new Set(
      (await notifiedAbout(issueId, since)).map((row) => row.userId),
    );
    expect(
      recipients.has(await userId(TESTER)),
      "a watching tester still hears about a developer's move",
    ).toBe(true);
  });

  it("leaves a tester's own activity reaching its ordinary audience", async () => {
    const issueId = await anIssue("Tester checks", {
      assigneeId: await userId(TESTER),
      status: "IN_QA",
    });
    await watch(issueId, [DEVELOPER]);

    const since = new Date();
    await actAs(TESTER);
    expect((await updateIssue({ issueId, status: "DONE" })).ok).toBe(true);

    const recipients = new Set(
      (await notifiedAbout(issueId, since)).map((row) => row.userId),
    );
    expect(
      recipients.has(await userId(DEVELOPER)),
      "a watching developer still hears about a tester's verdict",
    ).toBe(true);
  });

  it("leaves an administrator's own activity reaching its ordinary audience", async () => {
    const issueId = await anIssue("Admin moves it", {
      assigneeId: await userId(DEVELOPER),
    });
    await watch(issueId, [DEVELOPER, TESTER]);

    const since = new Date();
    await actAs(ADMIN);
    expect((await updateIssue({ issueId, status: "IN_PROGRESS" })).ok).toBe(true);

    const recipients = new Set(
      (await notifiedAbout(issueId, since)).map((row) => row.userId),
    );
    expect(recipients.has(await userId(DEVELOPER))).toBe(true);
    expect(recipients.has(await userId(TESTER))).toBe(true);
  });
});

describe("the rule is the server's", () => {
  it("ignores a role and a recipient supplied by the caller", async () => {
    /*
     * The shape a forged request would take: the payload names a role and a
     * recipient of its own. `updateIssue` parses what it accepts and resolves
     * the actor from the session, so neither reaches the decision — the
     * audience is still the administrators.
     */
    const issueId = await anIssue("Forged payload", {
      assigneeId: await userId(FULLSTACK),
    });
    await watch(issueId, [DEVELOPER, TESTER]);

    const since = new Date();
    await actAs(FULLSTACK);
    const moved = await updateIssue({
      issueId,
      status: "IN_PROGRESS",
      workRole: "DEVELOPER",
      isFullstack: false,
      recipientId: await userId(DEVELOPER),
      userId: await userId(DEVELOPER),
    } as unknown);
    expect(moved.ok, moved.ok ? "" : moved.error).toBe(true);

    const recipients = new Set(
      (await notifiedAbout(issueId, since)).map((row) => row.userId),
    );
    const admins = await administrators();

    expect(recipients.size).toBeGreaterThan(0);
    for (const recipient of recipients) {
      expect(admins).toContain(recipient);
    }
    expect(recipients.has(await userId(DEVELOPER))).toBe(false);
    expect(recipients.has(await userId(TESTER))).toBe(false);
  });
});
