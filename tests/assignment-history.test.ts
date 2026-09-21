import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createIssue, updateIssue } from "@/server/issues";
import { listAssignmentHistory } from "@/server/queries/assignmentHistory";
import { actAs, projectByKey } from "./helpers";

/**
 * Backlog History: who work went to, who sent it, and whether Prio decided.
 *
 * The question this page answers is "who did this?", and the way it used to
 * be answered wrongly is the thing most of these tests pin: the recipient of
 * an assignment is the one person who is certainly *not* its author, and any
 * reading that infers the actor from who ended up with the work will be wrong
 * exactly when somebody goes looking.
 */

const ADMIN = "admin@symbiosystech.com";

const made: string[] = [];

/**
 * Two people who are actually on Engineering, asked of the database.
 *
 * Named members would be a fixture pretending to be a fact: project
 * membership is data somebody can change, and a test that hard-codes it
 * fails for a reason that has nothing to do with what it is testing.
 */
async function twoMembers() {
  const project = await projectByKey("ENG");
  const members = await prisma.projectMember.findMany({
    where: { project: { id: project.id }, user: { isActive: true, role: "MEMBER" } },
    select: { user: { select: { id: true, name: true } } },
    orderBy: { user: { name: "asc" } },
    take: 2,
  });
  if (members.length < 2) {
    throw new Error("Engineering needs two active members for this suite.");
  }
  return [members[0]!.user, members[1]!.user] as const;
}

afterAll(async () => {
  if (made.length > 0) {
    await prisma.notification.deleteMany({ where: { issueId: { in: made } } });
    await prisma.issue.deleteMany({ where: { id: { in: made } } });
  }
  await prisma.$disconnect();
});

async function currentUser(email: string) {
  return prisma.user.findUniqueOrThrow({
    where: { email },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      image: true,
      jobTitle: true,
      isActive: true,
    },
  });
}

async function anIssue(title: string, assigneeId?: string) {
  await actAs(ADMIN);
  const project = await projectByKey("ENG");
  const result = await createIssue({
    projectId: project.id,
    type: "TASK",
    title: `${title} ${Date.now()}`,
    priority: "MEDIUM",
    labelIds: [],
    ...(assigneeId ? { assigneeId } : {}),
  });
  if (!result.ok) throw new Error(result.error);
  made.push(result.data.id);
  return result.data;
}

async function historyFor(issueId: string) {
  const admin = await currentUser(ADMIN);
  const result = await listAssignmentHistory(admin, {});
  return result.rows.filter((row) => row.issue.id === issueId);
}

describe("what gets recorded", () => {
  it("records an assignment made by hand, naming the person who made it", async () => {
    const [developer] = await twoMembers();
    const issue = await anIssue("Manual assignment");

    await actAs(ADMIN);
    await updateIssue({ issueId: issue.id, assigneeId: developer.id });

    const [row] = await historyFor(issue.id);
    const admin = await currentUser(ADMIN);

    expect(row?.newAssignee?.id).toBe(developer.id);
    expect(row?.previousAssignee).toBeNull();
    expect(row?.kind).toBe("Manual");
    /* The administrator did it. The developer received it. These are never
       the same field. */
    expect(row?.actor.id).toBe(admin.id);
    expect(row?.actor.id).not.toBe(developer.id);
  });

  it("records a reassignment as coming off one person and onto another", async () => {
    const [first, second] = await twoMembers();
    const issue = await anIssue("Reassignment", first.id);

    await actAs(ADMIN);
    await updateIssue({ issueId: issue.id, assigneeId: second.id });

    const [row] = await historyFor(issue.id);
    expect(row?.previousAssignee?.id).toBe(first.id);
    expect(row?.newAssignee?.id).toBe(second.id);
    /* Not "assigned from nobody": the work had a holder, and the history says
       who lost it. */
    expect(row?.previousAssignee).not.toBeNull();
  });

  it("records work that was created already assigned", async () => {
    /* This used to be a hole: an issue filed straight to somebody — including
       every row brought in by the importer — had no assignment history at
       all, so "who gave me this?" answered with silence. */
    const [developer] = await twoMembers();
    const issue = await anIssue("Born assigned", developer.id);

    const rows = await historyFor(issue.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.previousAssignee).toBeNull();
    expect(rows[0]?.newAssignee?.id).toBe(developer.id);
  });

  it("records an unassignment, which no feed used to show", async () => {
    const [developer] = await twoMembers();
    const issue = await anIssue("Taken off", developer.id);

    await actAs(ADMIN);
    await updateIssue({ issueId: issue.id, assigneeId: "" });

    const [row] = await historyFor(issue.id);
    expect(row?.previousAssignee?.id).toBe(developer.id);
    /* Given to nobody, and on the record. "Who took this off me?" is the
       question the old filter made unanswerable. */
    expect(row?.newAssignee).toBeNull();
  });

  it("writes nothing when the assignee did not actually change", async () => {
    const [developer] = await twoMembers();
    const issue = await anIssue("Unchanged", developer.id);

    await actAs(ADMIN);
    await updateIssue({ issueId: issue.id, assigneeId: developer.id });

    /* One row — the creation — and no second one for a change that was not a
       change. */
    expect(await historyFor(issue.id)).toHaveLength(1);
  });

  it("does not treat a status change as an assignment", async () => {
    const [developer] = await twoMembers();
    const issue = await anIssue("Status only", developer.id);

    await actAs(ADMIN);
    await updateIssue({ issueId: issue.id, status: "IN_PROGRESS" });

    expect(await historyFor(issue.id)).toHaveLength(1);
  });
});

describe("Prio's own decisions", () => {
  it("marks a reopen hand-back automatic, and does not call it the tester's choice", async () => {
    /*
     * The case the distinction exists for.
     *
     * A developer works on something; it is handed elsewhere; testing reopens
     * it. Prio sends it back to whoever built it — read from the trail, not
     * chosen by anybody. The tester is recorded as the actor because they
     * caused it, and that is exactly why the row must also say it was
     * automatic: without that, the history reads as the tester personally
     * picking this developer, which is not what happened.
     */
    const [builder, other] = await twoMembers();
    const issue = await anIssue("Reopened", builder.id);

    /* The builder moves it along, which is what the trail later reads. */
    await actAs(
      (
        await prisma.user.findUniqueOrThrow({
          where: { id: builder.id },
          select: { email: true },
        })
      ).email,
    );
    expect((await updateIssue({ issueId: issue.id, status: "IN_PROGRESS" })).ok).toBe(true);

    /* It moves to somebody else, and then comes back. */
    await actAs(ADMIN);
    expect((await updateIssue({ issueId: issue.id, assigneeId: other.id })).ok).toBe(true);
    expect((await updateIssue({ issueId: issue.id, status: "REOPENED" })).ok).toBe(true);

    const rows = await historyFor(issue.id);
    const handBack = rows.find(
      (row) => row.newAssignee?.id === builder.id && row.previousAssignee?.id === other.id,
    );

    expect(handBack, "the reopen handed it back to whoever built it").toBeTruthy();
    expect(handBack!.kind).toBe("Automatic");

    /* And the hand to `other` just before it was a person's choice, so the
       two are distinguishable — which is the whole point. */
    const manual = rows.find((row) => row.newAssignee?.id === other.id);
    expect(manual?.kind).toBe("Manual");
  });
});

describe("filtering", () => {
  it("separates the manual from the automatic", async () => {
    const admin = await currentUser(ADMIN);

    const manual = await listAssignmentHistory(admin, { kind: "Manual" });
    const automatic = await listAssignmentHistory(admin, { kind: "Automatic" });

    expect(manual.rows.every((row) => row.kind === "Manual")).toBe(true);
    expect(automatic.rows.every((row) => row.kind === "Automatic")).toBe(true);
  });

  it("finds a work item by its key", async () => {
    const [developer] = await twoMembers();
    const issue = await anIssue("Searchable", developer.id);

    const admin = await currentUser(ADMIN);
    const found = await listAssignmentHistory(admin, { q: issue.key });

    expect(found.rows.some((row) => row.issue.key === issue.key)).toBe(true);
  });

  it("includes somebody whether work came to them or went from them", async () => {
    const [first, second] = await twoMembers();
    const issue = await anIssue("Both directions", first.id);

    await actAs(ADMIN);
    await updateIssue({ issueId: issue.id, assigneeId: second.id });

    const admin = await currentUser(ADMIN);
    const theirs = await listAssignmentHistory(admin, { userId: first.id });
    const rows = theirs.rows.filter((row) => row.issue.id === issue.id);

    /* Two rows for this issue: the one that gave it to them, and the one that
       took it away. A filter that only matched the recipient would show one. */
    expect(rows).toHaveLength(2);
  });
});

describe("what a reader may see", () => {
  it("shows a member nothing from a project they cannot open", async () => {
    /*
     * Scope is the database's, not the page's. The Testing project is the
     * administrator's own, and this member is not in it.
     */
    const [someone] = await twoMembers();
    const member = await currentUser(
      (await prisma.user.findUniqueOrThrow({
        where: { id: someone.id },
        select: { email: true },
      })).email,
    );
    const testing = await projectByKey("TES");

    const result = await listAssignmentHistory(member, {
      projectId: testing.id,
    });

    expect(result.rows).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it("keeps one project's history out of another's", async () => {
    const admin = await currentUser(ADMIN);
    const engineering = await projectByKey("ENG");

    const result = await listAssignmentHistory(admin, {
      projectId: engineering.id,
    });

    expect(result.rows.every((row) => row.project.key === "ENG")).toBe(true);
  });
});
