import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  allowedStatusesFor,
  filableStatusesFor,
  STATUS_LABEL,
} from "@/lib/domain";
import { createIssue, updateIssue } from "@/server/issues";
import { actAs, joinTestingTeam, projectByKey } from "./helpers";

/**
 * The round trip: a tester raises work, a developer builds it, and it comes
 * back to the same tester to be checked.
 *
 * The half that was missing is the coming back. A developer moving an issue to
 * Ready for QA told the project's testers about it, which is a notice anybody
 * could act on and therefore one nobody owned. The person who has to decide
 * whether it is fixed is the person who wrote down what "fixed" means, and
 * that is the reporter — so the work returns to them, and it appears in their
 * queue rather than in a list they have to go and search.
 *
 * What these hold is mostly what the rule must *not* do. It must not pick a
 * tester because they were first, or because there was only one; it must not
 * pick one because the request said so; it must not overwrite who raised the
 * issue; and where the reporter is no longer somebody who could act on it, it
 * must do nothing at all rather than guess.
 */

const ADMIN = "admin@symbiosystech.com";
const TESTER = "priya.nair@symbiosystech.com";
const OTHER_TESTER = "meera.pillai@symbiosystech.com";
const DEVELOPER = "kiran.das@symbiosystech.com";

const createdIssueIds: string[] = [];
const leaves: (() => Promise<void>)[] = [];

let testerId = "";
let otherTesterId = "";
let developerId = "";
let projectId = "";

beforeAll(async () => {
  const tester = await joinTestingTeam(TESTER);
  const other = await joinTestingTeam(OTHER_TESTER);
  testerId = tester.userId;
  otherTesterId = other.userId;
  leaves.push(tester.leave, other.leave);

  developerId = (
    await prisma.user.findUniqueOrThrow({
      where: { email: DEVELOPER },
      select: { id: true },
    })
  ).id;

  projectId = (await projectByKey("ENG")).id;

  /* All three have to be able to open the project, or the assignee rule the
     rest of Prio enforces would refuse the handover for an unrelated reason. */
  for (const userId of [testerId, otherTesterId, developerId]) {
    await prisma.projectMember.upsert({
      where: { projectId_userId: { projectId, userId } },
      update: {},
      create: { projectId, userId },
    });
  }
});

afterAll(async () => {
  if (createdIssueIds.length > 0) {
    await prisma.notification.deleteMany({
      where: { issueId: { in: createdIssueIds } },
    });
    await prisma.issue.deleteMany({ where: { id: { in: createdIssueIds } } });
  }
  for (const leave of leaves) await leave();
  await prisma.$disconnect();
});

/** A defect raised by the tester and handed to the developer, as QA would. */
async function raisedByTester(title: string): Promise<{ id: string; key: string }> {
  await actAs(TESTER);
  const created = await createIssue({
    projectId,
    type: "BUG",
    title,
    description: "Raised by QA for this test.",
    priority: "MEDIUM",
    assigneeId: developerId,
  });
  if (!created.ok) throw new Error(created.error);
  createdIssueIds.push(created.data.id);
  return created.data;
}

/** What the row says now. */
async function readIssue(id: string) {
  return prisma.issue.findUniqueOrThrow({
    where: { id },
    select: {
      status: true,
      assigneeId: true,
      reporterId: true,
      completedAt: true,
    },
  });
}

describe("QA-01 / QA-02  raising work, and handing it to a developer", () => {
  it("records the tester who raised it, and the developer who was given it", async () => {
    const issue = await raisedByTester(`QA raises ${Date.now()}`);
    const row = await readIssue(issue.id);

    expect(row.reporterId).toBe(testerId);
    expect(row.assigneeId).toBe(developerId);
  });
});

describe("QA-03 / QA-04  each half of the job is offered its own statuses", () => {
  it("a developer is offered New, In Progress and Ready for QA", async () => {
    const offered = allowedStatusesFor("DEVELOPER", "IN_PROGRESS").map(
      (status) => STATUS_LABEL[status],
    );
    expect(offered).toEqual(["New", "In Progress", "Ready for QA"]);
  });

  it("a tester is offered exactly the six QA statuses, with no duplicates", async () => {
    /* From In QA, because Done is the verdict that follows testing and is
       withheld anywhere else — the one place the six are all available. */
    const offered = allowedStatusesFor("QA", "IN_QA").map(
      (status) => STATUS_LABEL[status],
    );

    expect(offered).toEqual([
      "Backlog",
      "In QA",
      "Done",
      "Reopen",
      "Reject / Not an Issue",
      "Cancelled",
    ]);
    expect(new Set(offered).size).toBe(offered.length);
  });

  it("offers New on the create form to everybody it is a status for", async () => {
    /*
     * The reported "only Backlog is selectable" is the tester's create form,
     * and it is the rule rather than a fault: a tester raises a request for
     * somebody to pick up, and New says somebody already has. Everybody who
     * builds — and the administrator, who is unrestricted — is offered it,
     * which is what this pins. Filing and working are separate lists on
     * purpose; the tester's working list is asserted above and is untouched
     * by this.
     */
    expect(filableStatusesFor("DEVELOPER").map((s) => STATUS_LABEL[s])).toContain(
      "New",
    );
    expect(filableStatusesFor("FULLSTACK").map((s) => STATUS_LABEL[s])).toContain(
      "New",
    );
    expect(filableStatusesFor("ADMIN").map((s) => STATUS_LABEL[s])).toContain(
      "New",
    );
    expect(filableStatusesFor("QA").map((s) => STATUS_LABEL[s])).toEqual([
      "Backlog",
    ]);
  });

  it("never offers a tester the developer's working statuses", async () => {
    for (const current of ["BACKLOG", "IN_QA", "REOPENED", "DONE"] as const) {
      const offered = allowedStatusesFor("QA", current).map(
        (status) => STATUS_LABEL[status],
      );
      for (const developerOnly of ["New", "In Progress", "Ready for QA"]) {
        expect(offered).not.toContain(developerOnly);
      }
    }
  });
});

describe("QA-05 / QA-06  Ready for QA returns the work to whoever raised it", () => {
  it("assigns it back to the reporter, and keeps the reporter", async () => {
    const issue = await raisedByTester(`Returns to reporter ${Date.now()}`);

    await actAs(DEVELOPER);
    const started = await updateIssue({ issueId: issue.id, status: "IN_PROGRESS" });
    expect(started.ok).toBe(true);

    const handedBack = await updateIssue({ issueId: issue.id, status: "IN_REVIEW" });
    expect(handedBack.ok).toBe(true);

    const row = await readIssue(issue.id);
    expect(row.status).toBe("IN_REVIEW");
    expect(row.assigneeId).toBe(testerId);
    // The developer's work is not erased by the handover.
    expect(row.reporterId).toBe(testerId);
  });

  it("QA-07  picks the reporter, not whichever tester comes first", async () => {
    /*
     * The test that would pass by accident with one tester on the project.
     * Two are members, and the one who raised it is deliberately not the one
     * a query ordered by name, id or membership date would reach first.
     */
    await actAs(ADMIN);
    const created = await createIssue({
      projectId,
      type: "BUG",
      title: `Second tester raises ${Date.now()}`,
      description: "fixture",
      priority: "MEDIUM",
    });
    if (!created.ok) throw new Error(created.error);
    createdIssueIds.push(created.data.id);

    /* Reported by the *other* tester, and held by the developer. */
    await prisma.issue.update({
      where: { id: created.data.id },
      data: { reporterId: otherTesterId, assigneeId: developerId },
    });

    await actAs(DEVELOPER);
    const handedBack = await updateIssue({
      issueId: created.data.id,
      status: "IN_REVIEW",
    });
    expect(handedBack.ok).toBe(true);

    const row = await readIssue(created.data.id);
    expect(row.assigneeId).toBe(otherTesterId);
    expect(row.assigneeId).not.toBe(testerId);
  });

  it("does nothing when the issue was not raised by a tester", async () => {
    /* An administrator's issue has no tester to go back to. The work stays
       where it is; the project's testers are told, as they always were. */
    await actAs(ADMIN);
    const created = await createIssue({
      projectId,
      type: "TASK",
      title: `Admin raises ${Date.now()}`,
      description: "fixture",
      priority: "MEDIUM",
      assigneeId: developerId,
    });
    if (!created.ok) throw new Error(created.error);
    createdIssueIds.push(created.data.id);

    await actAs(DEVELOPER);
    expect((await updateIssue({ issueId: created.data.id, status: "IN_REVIEW" })).ok)
      .toBe(true);

    const row = await readIssue(created.data.id);
    expect(row.assigneeId).toBe(developerId);
  });

  it("leaves an assignee alone when the same request named one", async () => {
    /* Somebody who said where the work should go has made a decision. */
    const issue = await raisedByTester(`Explicit assignee ${Date.now()}`);

    await actAs(ADMIN);
    const moved = await updateIssue({
      issueId: issue.id,
      status: "IN_REVIEW",
      assigneeId: otherTesterId,
    });
    expect(moved.ok).toBe(true);

    const row = await readIssue(issue.id);
    expect(row.assigneeId).toBe(otherTesterId);
  });

  it("does not reassign when the reporter has left the project", async () => {
    const issue = await raisedByTester(`Reporter left ${Date.now()}`);

    await prisma.projectMember.deleteMany({
      where: { projectId, userId: testerId },
    });
    try {
      await actAs(DEVELOPER);
      expect((await updateIssue({ issueId: issue.id, status: "IN_REVIEW" })).ok)
        .toBe(true);

      const row = await readIssue(issue.id);
      expect(row.assigneeId).toBe(developerId);
    } finally {
      await prisma.projectMember.create({ data: { projectId, userId: testerId } });
    }
  });
});

describe("QA-08 / QA-09  the tester is told, and it is in their queue", () => {
  it("notifies the reporter by name, and the other testers separately", async () => {
    const issue = await raisedByTester(`Notifies reporter ${Date.now()}`);

    await actAs(DEVELOPER);
    expect((await updateIssue({ issueId: issue.id, status: "IN_REVIEW" })).ok).toBe(
      true,
    );

    const mine = await prisma.notification.findMany({
      where: { issueId: issue.id, userId: testerId },
      select: { type: true, message: true, actorId: true },
    });

    const returned = mine.find((row) => row.type === "ISSUE_ASSIGNED");
    expect(returned, "the reporter is told the work is theirs again").toBeTruthy();
    expect(returned!.actorId).toBe(developerId);
    expect(returned!.message).toContain(issue.key);
    expect(returned!.message).toContain("to test");

    /* And not the broadcast as well — one event, one notice addressed to them. */
    const broadcast = mine.filter((row) =>
      row.message.includes("ready for QA"),
    );
    expect(broadcast).toHaveLength(0);

    /* The other tester on the project still gets the notice they always got. */
    const theirs = await prisma.notification.findMany({
      where: { issueId: issue.id, userId: otherTesterId },
      select: { message: true },
    });
    expect(theirs.some((row) => row.message.includes("ready for QA"))).toBe(true);
  });

  it("puts it in the reporter's own assigned work", async () => {
    const issue = await raisedByTester(`In my queue ${Date.now()}`);

    await actAs(DEVELOPER);
    await updateIssue({ issueId: issue.id, status: "IN_REVIEW" });

    const assigned = await prisma.issue.findMany({
      where: { assigneeId: testerId, id: issue.id },
      select: { id: true },
    });
    expect(assigned).toHaveLength(1);
  });
});

describe("QA-10 … QA-15  the verdict, and what stays on the record", () => {
  /** Raised by QA, built by the developer, handed back, and taken into QA. */
  async function readyForTheVerdict(title: string) {
    const issue = await raisedByTester(title);
    await actAs(DEVELOPER);
    await updateIssue({ issueId: issue.id, status: "IN_REVIEW" });
    await actAs(TESTER);
    const taken = await updateIssue({ issueId: issue.id, status: "IN_QA" });
    expect(taken.ok).toBe(true);
    return issue;
  }

  it("QA-10  Done is written, dated, and recorded in the history", async () => {
    const issue = await readyForTheVerdict(`Done persists ${Date.now()}`);

    const done = await updateIssue({ issueId: issue.id, status: "DONE" });
    expect(done.ok).toBe(true);

    const row = await readIssue(issue.id);
    expect(row.status).toBe("DONE");
    expect(row.completedAt).not.toBeNull();

    const history = await prisma.activityLogEntry.findMany({
      where: { issueId: issue.id, field: "status" },
      select: { oldValue: true, newValue: true, actorId: true },
      orderBy: { createdAt: "asc" },
    });
    const closing = history.at(-1)!;
    expect(closing.newValue).toBe("DONE");
    expect(closing.actorId, "the tester is recorded as closing it").toBe(testerId);
  });

  it("QA-11  it is counted as completed work rather than open work", async () => {
    const issue = await readyForTheVerdict(`Done is complete ${Date.now()}`);
    await updateIssue({ issueId: issue.id, status: "DONE" });

    const open = await prisma.issue.count({
      where: { id: issue.id, status: { in: ["BACKLOG", "TODO", "IN_PROGRESS", "IN_REVIEW", "IN_QA", "REOPENED"] } },
    });
    const complete = await prisma.issue.count({
      where: { id: issue.id, status: "DONE" },
    });
    expect(open).toBe(0);
    expect(complete).toBe(1);
  });

  for (const [code, status, label] of [
    ["QA-12", "REOPENED", "Reopen"],
    ["QA-13", "REJECTED", "Reject / Not an Issue"],
    ["QA-14", "CANCELLED", "Cancelled"],
  ] as const) {
    it(`${code}  ${label} is accepted from In QA and persists`, async () => {
      const issue = await readyForTheVerdict(`${label} ${Date.now()}`);

      const result = await updateIssue({ issueId: issue.id, status });
      expect(result.ok).toBe(true);

      expect((await readIssue(issue.id)).status).toBe(status);

      const history = await prisma.activityLogEntry.findMany({
        where: { issueId: issue.id, field: "status", newValue: status },
        select: { actorId: true },
      });
      expect(history).toHaveLength(1);
      expect(history[0]!.actorId).toBe(testerId);
    });
  }

  it("QA-15  the whole round trip is still readable afterwards", async () => {
    const issue = await readyForTheVerdict(`Traceable ${Date.now()}`);
    await updateIssue({ issueId: issue.id, status: "DONE" });

    const row = await readIssue(issue.id);
    // Who raised it, and who closed it.
    expect(row.reporterId).toBe(testerId);
    expect(row.assigneeId).toBe(testerId);

    const history = await prisma.activityLogEntry.findMany({
      where: { issueId: issue.id },
      select: { field: true, oldValue: true, newValue: true, actorId: true },
      orderBy: { createdAt: "asc" },
    });

    const statuses = history.filter((row) => row.field === "status");
    expect(statuses.map((row) => row.newValue)).toEqual([
      "IN_REVIEW",
      "IN_QA",
      "DONE",
    ]);

    /* The developer is on the record as the person who handed it over, and
       the handover itself is there as an assignment rather than as a gap. */
    const handover = history.find(
      (row) => row.field === "assigneeId" && row.newValue === testerId,
    );
    expect(handover, "the return to QA is in the history").toBeTruthy();
    expect(handover!.oldValue).toBe(developerId);
    expect(handover!.actorId).toBe(developerId);
  });
});

describe("QA-16 / QA-17  an administrator is unaffected", () => {
  it("can still hand unassigned work to a developer", async () => {
    await actAs(ADMIN);
    const created = await createIssue({
      projectId,
      type: "TASK",
      title: `Admin assigns ${Date.now()}`,
      description: "fixture",
      priority: "MEDIUM",
    });
    if (!created.ok) throw new Error(created.error);
    createdIssueIds.push(created.data.id);

    expect((await readIssue(created.data.id)).assigneeId).toBeNull();

    const assigned = await updateIssue({
      issueId: created.data.id,
      assigneeId: developerId,
    });
    expect(assigned.ok).toBe(true);
    expect((await readIssue(created.data.id)).assigneeId).toBe(developerId);
  });

  it("can still move work anywhere, including straight to Done", async () => {
    const issue = await raisedByTester(`Admin closes ${Date.now()}`);

    await actAs(ADMIN);
    const done = await updateIssue({ issueId: issue.id, status: "DONE" });
    expect(done.ok).toBe(true);
    expect((await readIssue(issue.id)).status).toBe("DONE");
  });

  it("keeps every status available to an administrator", async () => {
    const offered = allowedStatusesFor("ADMIN", "IN_QA");
    expect(offered).toHaveLength(9);
  });
});
