import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { TESTING_TEAM_SLUG } from "@/lib/authz";
import { createIssue, updateIssue } from "@/server/issues";
import { loadDashboard } from "@/server/queries/dashboard";
import type { CurrentUser } from "@/lib/session";
import { actAs, projectByKey } from "./helpers";

/**
 * Who hears that work was finished.
 *
 * Prio's Home carries a Recent activity list scoped to the projects a person
 * can open. A completion is the one entry on it that is addressed rather than
 * broadcast: it reaches whoever moved the work to Done, whoever was holding
 * it, and the administrators. Sharing the project is deliberately not enough
 * — a colleague who was neither can still open the issue and read its history,
 * and that is where a completion they had no part in belongs.
 *
 * Everything else on the feed is unchanged and is still the project's news, so
 * the last block here asserts that an ordinary status change still reaches the
 * bystander. A rule that quietly narrowed the whole feed would pass every
 * other case in this file.
 *
 * Deduplication is a property of the query rather than a step after it: one
 * activity row is one row however many of the three categories the reader
 * occupies, which is what the "finished by its holder" case pins down.
 *
 * Asserted through `loadDashboard`, which is what Home renders, so what is
 * tested is what a person actually sees rather than a helper alongside it.
 */

const ADMIN = "admin@symbiosystech.com";
const TESTER = "priya.nair@symbiosystech.com";
const ASSIGNEE = "kiran.das@symbiosystech.com";
/* A member — deliberately not an administrator, who is a recipient by rule —
   who shares the project with everybody else here. */
const COLLEAGUE = "vikram.shetty@symbiosystech.com";

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

beforeAll(async () => {
  await join(TESTER, TESTING_TEAM_SLUG);

  /* The bystander has to be able to open the project — that is the whole
     point: sharing a project is exactly what used to be enough to see this. */
  const project = await projectByKey("ENG");
  for (const email of [ASSIGNEE, COLLEAGUE]) {
    const user = await prisma.user.findUniqueOrThrow({
      where: { email },
      select: { id: true },
    });
    await prisma.projectMember.upsert({
      where: { projectId_userId: { projectId: project.id, userId: user.id } },
      update: {},
      create: { projectId: project.id, userId: user.id },
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
  await prisma.$disconnect();
});

/** An ENG issue, held by `assignee`, walked as far as In QA. */
async function anIssueReadyToFinish(
  title: string,
  assigneeEmail: string | null,
): Promise<{ id: string; key: string }> {
  await actAs(ADMIN);
  const project = await projectByKey("ENG");
  const result = await createIssue({
    projectId: project.id,
    type: "TASK",
    title: `${title} ${Date.now()}`,
    description: "fixture",
    status: "TODO",
    priority: "MEDIUM",
  });
  if (!result.ok) throw new Error(result.error);
  created.push(result.data.id);

  const assignee = assigneeEmail
    ? await prisma.user.findUniqueOrThrow({
        where: { email: assigneeEmail },
        select: { id: true },
      })
    : null;

  const patch = await updateIssue({
    issueId: result.data.id,
    status: "IN_QA",
    ...(assignee ? { assigneeId: assignee.id } : {}),
  });
  if (!patch.ok) throw new Error(patch.error);

  return { id: result.data.id, key: result.data.key };
}

/** Does this person's Home carry the completion of that issue? */
async function homeShowsCompletion(
  email: string,
  issueKey: string,
): Promise<boolean> {
  const data = await loadDashboard(await userByEmail(email));
  return data.activity.some(
    (entry) =>
      entry.issue.key === issueKey &&
      entry.field === "status" &&
      entry.newValue === "DONE",
  );
}

describe("when a tester finishes somebody's work", () => {
  it("reaches the finisher, the holder and the admins, and nobody else", async () => {
    const issue = await anIssueReadyToFinish("Finished by a tester", ASSIGNEE);

    await actAs(TESTER);
    expect((await updateIssue({ issueId: issue.id, status: "DONE" })).ok).toBe(
      true,
    );

    expect(await homeShowsCompletion(TESTER, issue.key), "the changer").toBe(
      true,
    );
    expect(await homeShowsCompletion(ASSIGNEE, issue.key), "the holder").toBe(
      true,
    );
    expect(await homeShowsCompletion(ADMIN, issue.key), "an administrator").toBe(
      true,
    );

    /* …and not the colleague who merely shares the project. Being able to open
       the issue is not being one of the three people this is addressed to. */
    expect(
      await homeShowsCompletion(COLLEAGUE, issue.key),
      "a colleague on the same project",
    ).toBe(false);
  });
});

describe("when an administrator finishes it", () => {
  it("reaches them and the person holding it, and not the bystander", async () => {
    const issue = await anIssueReadyToFinish("Finished by an admin", ASSIGNEE);

    await actAs(ADMIN);
    expect((await updateIssue({ issueId: issue.id, status: "DONE" })).ok).toBe(
      true,
    );

    expect(await homeShowsCompletion(ADMIN, issue.key)).toBe(true);
    expect(await homeShowsCompletion(ASSIGNEE, issue.key)).toBe(true);
    expect(await homeShowsCompletion(COLLEAGUE, issue.key)).toBe(false);
  });
});

describe("when the person who finishes it is the person holding it", () => {
  it("is one entry, not two", async () => {
    const issue = await anIssueReadyToFinish("Finished by its holder", TESTER);

    await actAs(TESTER);
    expect((await updateIssue({ issueId: issue.id, status: "DONE" })).ok).toBe(
      true,
    );

    const data = await loadDashboard(await userByEmail(TESTER));
    const entries = data.activity.filter(
      (entry) =>
        entry.issue.key === issue.key &&
        entry.field === "status" &&
        entry.newValue === "DONE",
    );
    expect(entries).toHaveLength(1);
  });
});

describe("work with nobody holding it", () => {
  it("still reaches whoever finished it and the admins", async () => {
    /* One of the three categories is empty. The other two are unaffected —
       an absent assignee removes a recipient, it does not widen the rest. */
    const issue = await anIssueReadyToFinish("Finished, unassigned", null);

    await actAs(TESTER);
    expect((await updateIssue({ issueId: issue.id, status: "DONE" })).ok).toBe(
      true,
    );

    expect(await homeShowsCompletion(TESTER, issue.key)).toBe(true);
    expect(await homeShowsCompletion(ADMIN, issue.key)).toBe(true);
    expect(await homeShowsCompletion(COLLEAGUE, issue.key)).toBe(false);
  });
});

describe("everything else on the feed", () => {
  it("is still the project's, and reaches the colleague as it always did", async () => {
    /* The scoping is for completions alone. An ordinary status change is
       project news and must not have been quietly narrowed with it. */
    const issue = await anIssueReadyToFinish("Ordinary movement", ASSIGNEE);

    await actAs(ADMIN);
    expect((await updateIssue({ issueId: issue.id, status: "BACKLOG" })).ok).toBe(
      true,
    );

    const data = await loadDashboard(await userByEmail(COLLEAGUE));
    expect(
      data.activity.some(
        (entry) => entry.issue.key === issue.key && entry.field === "status",
      ),
    ).toBe(true);
  });

  it("keeps entries with no field at all, which a NOT would have dropped", async () => {
    /* `field` and `newValue` are nullable, so "not a completion" cannot be
       written as one negation: `NOT (field = 'status' AND newValue = 'DONE')`
       is null — and therefore false — for a row where either is null, and the
       creation entry for every issue would silently vanish from the feed. */
    const issue = await anIssueReadyToFinish("Feed keeps creation", ASSIGNEE);

    const data = await loadDashboard(await userByEmail(COLLEAGUE));
    const entries = data.activity.filter(
      (entry) => entry.issue.key === issue.key && entry.field === null,
    );
    expect(entries.length).toBeGreaterThan(0);
  });
});

describe("the completion itself", () => {
  it("is persisted, with the date it happened", async () => {
    const issue = await anIssueReadyToFinish("Persisted completion", ASSIGNEE);

    await actAs(TESTER);
    const finished = await updateIssue({ issueId: issue.id, status: "DONE" });
    expect(finished.ok, finished.ok ? "" : finished.error).toBe(true);

    const row = await prisma.issue.findUniqueOrThrow({
      where: { id: issue.id },
      select: { status: true, completedAt: true },
    });
    expect(row.status).toBe("DONE");
    expect(row.completedAt).not.toBeNull();

    // And the trail records who did it, which is what the feed reads.
    const entry = await prisma.activityLogEntry.findFirstOrThrow({
      where: { issueId: issue.id, field: "status", newValue: "DONE" },
      select: { actorId: true },
    });
    const tester = await prisma.user.findUniqueOrThrow({
      where: { email: TESTER },
      select: { id: true },
    });
    expect(entry.actorId).toBe(tester.id);
  });
});
