import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createIssue, updateIssue } from "@/server/issues";
import { actAs, joinTestingTeam, projectByKey } from "./helpers";

/**
 * A developer hands their work to a QA member and marks it Ready for QA.
 *
 * The QA member it is assigned to is who tests it, so the notice is theirs and
 * nobody else's: not the other testers on the project, not the developers, not
 * the administrators. It says what they need — the issue, its project, the
 * status, and that it is theirs to test — it survives being read again later
 * because it is a row, and saving the same state twice does not say it twice.
 */

const ADMIN = "admin@symbiosystech.com";
const QA_MEMBER = "priya.nair@symbiosystech.com";
const OTHER_QA = "meera.pillai@symbiosystech.com";
const DEVELOPER = "kiran.das@symbiosystech.com";
const OTHER_DEVELOPER = "vikram.shetty@symbiosystech.com";

const created: string[] = [];
const leaves: (() => Promise<void>)[] = [];
const ids: Record<string, string> = {};
let projectId = "";
let projectName = "";

beforeAll(async () => {
  const qa = await joinTestingTeam(QA_MEMBER);
  const other = await joinTestingTeam(OTHER_QA);
  leaves.push(qa.leave, other.leave);

  const project = await prisma.project.findUniqueOrThrow({
    where: { key: "ENG" },
    select: { id: true, name: true },
  });
  projectId = project.id;
  projectName = project.name;

  for (const email of [ADMIN, QA_MEMBER, OTHER_QA, DEVELOPER, OTHER_DEVELOPER]) {
    const user = await prisma.user.findUniqueOrThrow({
      where: { email },
      select: { id: true },
    });
    ids[email] = user.id;
    if (email !== ADMIN) {
      await prisma.projectMember.upsert({
        where: { projectId_userId: { projectId, userId: user.id } },
        update: {},
        create: { projectId, userId: user.id },
      });
    }
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
  for (const leave of leaves) await leave();
  await prisma.$disconnect();
});

/**
 * An issue raised by an administrator — so no tester to return it to — held
 * by the developer and in progress.
 */
async function developersIssue(title: string) {
  await actAs(ADMIN);
  const project = await projectByKey("ENG");
  const issue = await createIssue({
    projectId: project.id,
    type: "TASK",
    title,
    description: "fixture",
    priority: "MEDIUM",
    assigneeId: ids[DEVELOPER],
  });
  if (!issue.ok) throw new Error(issue.error);
  created.push(issue.data.id);

  await actAs(DEVELOPER);
  const started = await updateIssue({
    issueId: issue.data.id,
    status: "IN_PROGRESS",
  });
  if (!started.ok) throw new Error(started.error);
  return issue.data;
}

async function readyForQaNotices(issueId: string) {
  return prisma.notification.findMany({
    where: { issueId, message: { contains: "Ready for QA", mode: "insensitive" } },
    select: { userId: true, type: true, message: true, projectId: true },
  });
}

describe("Developer → QA: Ready for QA", () => {
  it("notifies the assigned QA member, with the issue, project and status", async () => {
    const issue = await developersIssue(`Handed to QA ${Date.now()}`);

    /* An administrator decides who tests it — a developer cannot put somebody
       else's name on an issue. The developer then marks it ready, which is the
       act this file is actually about. */
    await actAs(ADMIN);
    const assigned = await updateIssue({
      issueId: issue.id,
      assigneeId: ids[QA_MEMBER],
    });
    expect(assigned.ok, assigned.ok ? "" : assigned.error).toBe(true);

    await actAs(DEVELOPER);
    const moved = await updateIssue({ issueId: issue.id, status: "IN_REVIEW" });
    expect(moved.ok).toBe(true);

    const notices = await readyForQaNotices(issue.id);
    const toQa = notices.filter((n) => n.userId === ids[QA_MEMBER]);

    expect(toQa).toHaveLength(1);
    expect(toQa[0]!.message).toContain(issue.key);
    expect(toQa[0]!.message).toContain(issue.title);
    expect(toQa[0]!.message).toContain(projectName);
    expect(toQa[0]!.message).toContain("Ready for QA");
    expect(toQa[0]!.message).toMatch(/to you to test/);
    expect(toQa[0]!.projectId).toBe(projectId);

    const row = await prisma.issue.findUniqueOrThrow({
      where: { id: issue.id },
      select: { status: true, assigneeId: true },
    });
    expect(row).toEqual({ status: "IN_REVIEW", assigneeId: ids[QA_MEMBER] });
  });

  it("does not notify other testers, other developers or administrators", async () => {
    const issue = await developersIssue(`Only the assignee ${Date.now()}`);

    await actAs(ADMIN);
    await updateIssue({ issueId: issue.id, assigneeId: ids[QA_MEMBER] });

    await actAs(DEVELOPER);
    await updateIssue({ issueId: issue.id, status: "IN_REVIEW" });

    const notices = await readyForQaNotices(issue.id);
    const recipients = new Set(notices.map((n) => n.userId));

    /* The status line to watchers is "moved … to Ready for QA", so it
       matches too: the administrator raised the issue and watches it, and is
       told the status moved. What must not reach them — or anybody but the
       QA member — is the request to test it. */
    const asks = notices.filter((n) => /to test/.test(n.message));
    expect(new Set(asks.map((n) => n.userId))).toEqual(new Set([ids[QA_MEMBER]]));

    expect(recipients.has(ids[OTHER_QA]!), "another tester").toBe(false);
    expect(recipients.has(ids[OTHER_DEVELOPER]!), "another developer").toBe(false);
    expect(recipients.has(ids[DEVELOPER]!), "the developer who acted").toBe(false);
  });

  it("says it once when assigned and marked ready in the same save", async () => {
    const issue = await developersIssue(`One save ${Date.now()}`);

    /* One save carrying both, which is an administrator's to make: they are
       the only role that may name somebody else as the assignee. */
    await actAs(ADMIN);
    const moved = await updateIssue({
      issueId: issue.id,
      assigneeId: ids[QA_MEMBER],
      status: "IN_REVIEW",
    });
    expect(moved.ok, moved.ok ? "" : moved.error).toBe(true);

    const toQa = await prisma.notification.findMany({
      where: { issueId: issue.id, userId: ids[QA_MEMBER] },
      select: { message: true },
    });
    expect(toQa, JSON.stringify(toQa)).toHaveLength(1);
    expect(toQa[0]!.message).toContain("Ready for QA");
  });

  it("does not repeat itself when the same state is saved again", async () => {
    const issue = await developersIssue(`Saved twice ${Date.now()}`);

    await actAs(ADMIN);
    await updateIssue({ issueId: issue.id, assigneeId: ids[QA_MEMBER] });

    await actAs(DEVELOPER);
    await updateIssue({ issueId: issue.id, status: "IN_REVIEW" });
    const before = await prisma.notification.count({
      where: { issueId: issue.id, userId: ids[QA_MEMBER] },
    });

    /* A developer may not name an assignee at all, so the status alone is what
       a re-save from them carries. */
    const again = await updateIssue({ issueId: issue.id, status: "IN_REVIEW" });
    expect(again.ok).toBe(true);

    const after = await prisma.notification.count({
      where: { issueId: issue.id, userId: ids[QA_MEMBER] },
    });
    expect(after).toBe(before);
  });

  it("still asks every tester when no QA member holds the work", async () => {
    const issue = await developersIssue(`Nobody on QA holds it ${Date.now()}`);

    await actAs(DEVELOPER);
    await updateIssue({ issueId: issue.id, status: "IN_REVIEW" });

    const notices = await readyForQaNotices(issue.id);
    const recipients = new Set(notices.map((n) => n.userId));
    expect(recipients.has(ids[QA_MEMBER]!)).toBe(true);
    expect(recipients.has(ids[OTHER_QA]!)).toBe(true);
  });
});

describe("the developer's hand-off, and what it does not open up", () => {
  it("refuses a developer handing work to a QA member", async () => {
    /*
     * This was allowed once: a developer could choose who tested their work.
     * Deciding who a piece of work belongs to is an administrator's now, so
     * naming anybody — even a tester, even work they hold — is refused.
     *
     * The hand-off itself is unaffected. Marking work Ready for QA still
     * returns it to the tester who raised it, without the developer naming
     * anyone; `qa-return-to-reporter.test.ts` is where that is asserted.
     */
    const issue = await developersIssue(`Hand-off refused ${Date.now()}`);
    await actAs(DEVELOPER);
    const result = await updateIssue({
      issueId: issue.id,
      assigneeId: ids[QA_MEMBER],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/only an administrator/i);

    const row = await prisma.issue.findUniqueOrThrow({
      where: { id: issue.id },
      select: { assigneeId: true },
    });
    expect(row.assigneeId, "it is still the developer's").toBe(ids[DEVELOPER]);
  });

  it("still refuses handing it to another developer", async () => {
    const issue = await developersIssue(`Hand-off to developer ${Date.now()}`);
    await actAs(DEVELOPER);
    const result = await updateIssue({
      issueId: issue.id,
      assigneeId: ids[OTHER_DEVELOPER],
    });
    expect(result.ok).toBe(false);
  });

  it("still refuses handing a QA member work the developer does not hold", async () => {
    await actAs(ADMIN);
    const project = await projectByKey("ENG");
    const issue = await createIssue({
      projectId: project.id,
      type: "TASK",
      title: `Not theirs to hand ${Date.now()}`,
      description: "fixture",
      priority: "MEDIUM",
      assigneeId: ids[OTHER_DEVELOPER],
    });
    if (!issue.ok) throw new Error(issue.error);
    created.push(issue.data.id);

    await actAs(DEVELOPER);
    const result = await updateIssue({
      issueId: issue.data.id,
      assigneeId: ids[QA_MEMBER],
    });
    expect(result.ok).toBe(false);
  });
});
