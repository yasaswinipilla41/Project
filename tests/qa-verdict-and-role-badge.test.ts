import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  DEVELOPMENT_TEAM_SLUG,
  TESTING_TEAM_SLUG,
  workRoleOf,
} from "@/lib/authz";
import { WORK_ROLE_LABEL } from "@/lib/domain";
import type { CurrentUser } from "@/lib/session";
import { createIssue, updateIssue } from "@/server/issues";
import { actAs, projectByKey } from "./helpers";

/**
 * Two things a tester could not do, and one thing the account menu could not
 * say.
 *
 * **The verdict.** Checking work ends one of two ways: it passes and is Done,
 * or it fails and goes back. Done was already testing's, from In QA. Reopen
 * was not testing's at all, so the second half of the verdict had nowhere to
 * go — a tester could finish work and could not fail it. Both are asserted
 * here through `updateIssue`, which is the call the status menu makes and the
 * call a hand-made request makes, so what is offered and what is accepted are
 * the same thing.
 *
 * **The badge.** The account menu read `user.role`, which is the *account* —
 * ADMIN or MEMBER and nothing else — so a developer and a tester both read
 * "Member". `workRoleOf` is what the rest of Prio asks, and `WORK_ROLE_LABEL`
 * is how every other badge spells the answer. The cases below pin the mapping
 * for each of the four, from the same server-derived value the component is
 * handed.
 */

const ADMIN = "admin@symbiosystech.com";
const TESTER = "sneha.iyer@symbiosystech.com";
const DEVELOPER = "kiran.das@symbiosystech.com";
const FULLSTACK = "meera.pillai@symbiosystech.com";

const created: string[] = [];
const memberships: string[] = [];
/** Rows taken away to make somebody pure, put back afterwards. */
const suspended: { teamId: string; userId: string }[] = [];

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
  await leaveFor(TESTER, DEVELOPMENT_TEAM_SLUG);
  await join(TESTER, TESTING_TEAM_SLUG);

  await leaveFor(DEVELOPER, TESTING_TEAM_SLUG);
  await join(DEVELOPER, DEVELOPMENT_TEAM_SLUG);

  await join(FULLSTACK, TESTING_TEAM_SLUG);
  await join(FULLSTACK, DEVELOPMENT_TEAM_SLUG);

  const project = await projectByKey("ENG");
  for (const email of [TESTER, DEVELOPER, FULLSTACK]) {
    const person = await userByEmail(email);
    await prisma.projectMember.upsert({
      where: { projectId_userId: { projectId: project.id, userId: person.id } },
      update: {},
      create: { projectId: project.id, userId: person.id },
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

/** An ENG issue walked to Ready for QA, as the workflow does it. */
async function anIssueReadyForQa(label: string): Promise<string> {
  await actAs(ADMIN);
  const project = await projectByKey("ENG");
  const result = await createIssue({
    projectId: project.id,
    type: "TASK",
    title: `QA verdict ${label} ${Date.now()}-${Math.random()}`,
    description: "fixture",
    status: "TODO",
    priority: "MEDIUM",
  });
  if (!result.ok) throw new Error(result.error);
  created.push(result.data.id);

  const moved = await updateIssue({
    issueId: result.data.id,
    status: "IN_REVIEW",
  });
  if (!moved.ok) throw new Error(moved.error);
  return result.data.id;
}

describe("a tester reaching a verdict", () => {
  it("takes work in and finishes it: Ready for QA, In QA, Done", async () => {
    const issueId = await anIssueReadyForQa("passes");

    await actAs(TESTER);
    expect((await updateIssue({ issueId, status: "IN_QA" })).ok).toBe(true);

    const done = await updateIssue({ issueId, status: "DONE" });
    expect(done.ok, done.ok ? "" : done.error).toBe(true);

    const row = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: { status: true, completedAt: true },
    });
    expect(row.status).toBe("DONE");
    expect(row.completedAt).not.toBeNull();
  });

  it("takes work in and sends it back: Ready for QA, In QA, Reopen", async () => {
    const issueId = await anIssueReadyForQa("fails");

    await actAs(TESTER);
    expect((await updateIssue({ issueId, status: "IN_QA" })).ok).toBe(true);

    const reopened = await updateIssue({ issueId, status: "REOPENED" });
    expect(reopened.ok, reopened.ok ? "" : reopened.error).toBe(true);

    const row = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: { status: true },
    });
    expect(row.status).toBe("REOPENED");
  });

  it("can reopen work that was already finished", async () => {
    /* The other way round to the case above: something called Done, found
       wanting later, goes back through the same status. */
    const issueId = await anIssueReadyForQa("finished-then-reopened");

    await actAs(TESTER);
    await updateIssue({ issueId, status: "IN_QA" });
    expect((await updateIssue({ issueId, status: "DONE" })).ok).toBe(true);
    expect((await updateIssue({ issueId, status: "REOPENED" })).ok).toBe(true);

    const row = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: { status: true },
    });
    expect(row.status).toBe("REOPENED");
  });

  it("still cannot reach into the build, whatever is sent", async () => {
    /* The menu does not offer these; this is the server saying the same, which
       is what a forged request meets. Nothing was widened but Reopen. */
    const issueId = await anIssueReadyForQa("still-refused");

    await actAs(TESTER);
    await updateIssue({ issueId, status: "IN_QA" });

    for (const status of ["TODO", "IN_PROGRESS", "IN_REVIEW"] as const) {
      const result = await updateIssue({ issueId, status });
      expect(result.ok, `${status} must stay refused`).toBe(false);
    }

    const row = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: { status: true },
    });
    expect(row.status).toBe("IN_QA");
  });

  it("leaves the build's own statuses to the developer", async () => {
    /* Reopen became testing's; it did not become everybody's. */
    const issueId = await anIssueReadyForQa("developer-unchanged");

    await actAs(DEVELOPER);
    const reopened = await updateIssue({ issueId, status: "REOPENED" });
    expect(reopened.ok, "Reopen is not the build's").toBe(false);

    expect((await updateIssue({ issueId, status: "IN_PROGRESS" })).ok).toBe(true);
    expect((await updateIssue({ issueId, status: "IN_REVIEW" })).ok).toBe(true);
  });
});

describe("the role the account menu shows", () => {
  it("is what the person does, for each of the four", async () => {
    /*
     * The value the component is handed. `workRoleOf` reads the session user's
     * account role and their team rows on the server — there is nothing here a
     * request could carry, and nothing derived from a name or an address.
     */
    const cases: [string, string][] = [
      [ADMIN, "Admin"],
      [DEVELOPER, "Developer"],
      [TESTER, "QA member"],
      [FULLSTACK, "Full Stack Developer"],
    ];

    for (const [email, label] of cases) {
      const role = await workRoleOf(await userByEmail(email));
      expect(WORK_ROLE_LABEL[role], `${email} reads as ${label}`).toBe(label);
    }
  });

  it("no longer collapses everybody who is not an admin into one word", async () => {
    /* The defect, stated as the thing that must not come back: the account
       role has two values, so a developer and a tester were the same badge. */
    const developer = await userByEmail(DEVELOPER);
    const tester = await userByEmail(TESTER);

    expect(developer.role).toBe(tester.role);

    const [asDeveloper, asTester] = await Promise.all([
      workRoleOf(developer),
      workRoleOf(tester),
    ]);
    expect(WORK_ROLE_LABEL[asDeveloper]).not.toBe(WORK_ROLE_LABEL[asTester]);
  });

  it("follows the person, so signing in as somebody else changes it", async () => {
    /* Nothing is remembered between reads: each call resolves from the user it
       is given, which is what makes switching accounts show the new role. */
    const first = await workRoleOf(await userByEmail(TESTER));
    const second = await workRoleOf(await userByEmail(DEVELOPER));
    const third = await workRoleOf(await userByEmail(ADMIN));

    expect(WORK_ROLE_LABEL[first]).toBe("QA member");
    expect(WORK_ROLE_LABEL[second]).toBe("Developer");
    expect(WORK_ROLE_LABEL[third]).toBe("Admin");
  });
});
