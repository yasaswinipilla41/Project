import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createIssue, reportBug, updateIssue } from "@/server/issues";
import { createComment } from "@/server/comments";
import { recordTestResult } from "@/server/qa";
import { signUp } from "@/server/signup";
import { actAs, deleteIssues, projectByKey } from "./helpers";

/**
 * The developer ↔ tester loop, end to end through the real server actions.
 *
 * The flow under test is the one from the brief:
 *
 *   assign → developer submits → tester fails it → developer responds and
 *   resubmits → tester passes it
 *
 * Each step is a separate authenticated call, so what is proven is that the
 * state genuinely lives in PostgreSQL between them rather than in any one
 * request's memory.
 */

const created: string[] = [];

const ADMIN = "admin@symbiosystech.com";
const DEV = "priya.nair@symbiosystech.com";
const TESTER = "kiran.das@symbiosystech.com";

afterAll(async () => {
  await deleteIssues(created);
  await prisma.$disconnect();
});

async function userId(email: string): Promise<string> {
  const row = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: { id: true },
  });
  return row.id;
}

/** A fresh issue in a project all three people belong to. */
async function anIssue(title: string): Promise<string> {
  await actAs(ADMIN);
  const project = await projectByKey("ENG");
  const result = await createIssue({
    projectId: project.id,
    type: "TASK",
    title,
    description: "Created by the integration suite.",
    status: "TODO",
    priority: "MEDIUM",
  });
  if (!result.ok) throw new Error(`fixture create failed: ${result.error}`);
  created.push(result.data.id);
  return result.data.id;
}

async function verdict(issueId: string) {
  return prisma.issue.findUniqueOrThrow({
    where: { id: issueId },
    select: {
      status: true,
      testResult: true,
      testedById: true,
      testedAt: true,
    },
  });
}

describe("the developer ↔ tester round trip", () => {
  it("carries an issue from assignment to a passing verdict", async () => {
    const issueId = await anIssue("QA round trip fixture");
    const dev = await userId(DEV);

    // 1. Admin assigns it to the developer.
    await actAs(ADMIN);
    await updateIssue({ issueId, assigneeId: dev });
    expect((await verdict(issueId)).testResult).toBe("NOT_TESTED");

    // 2. The developer works, comments, and submits.
    await actAs(DEV);
    const devNote = await createComment({
      issueId,
      body: "Implemented and deployed to staging.",
    });
    expect(devNote.ok).toBe(true);

    const submit = await updateIssue({ issueId, status: "IN_REVIEW" });
    expect(submit.ok).toBe(true);
    expect((await verdict(issueId)).status).toBe("IN_REVIEW");

    /* 3. A problem is found: comment plus a FAILED verdict.
     *
     * The comment is anyone's to leave, but the verdict belongs to whoever
     * raised the issue — the fixture files it as ADMIN, so that is who
     * records it. */
    await actAs(TESTER);
    const qaNote = await createComment({
      issueId,
      body: "Fails on the second attempt — the token is not refreshed.",
    });
    expect(qaNote.ok).toBe(true);

    await actAs(ADMIN);
    const failed = await recordTestResult({ issueId, result: "FAILED" });
    expect(failed.ok).toBe(true);

    const afterFail = await verdict(issueId);
    expect(afterFail.testResult).toBe("FAILED");
    expect(afterFail.testedById).toBe(await userId(ADMIN));
    expect(afterFail.testedAt).toBeInstanceOf(Date);

    // The developer is told, through the existing notification system.
    const told = await prisma.notification.findFirst({
      where: { userId: dev, issueId, type: "TEST_RESULT" },
      select: { message: true, actorId: true },
    });
    expect(told).not.toBeNull();
    expect(told?.actorId).toBe(await userId(ADMIN));
    expect(told?.message).toContain("failed");

    // 4. The developer responds and resubmits.
    await actAs(DEV);
    const reply = await createComment({
      issueId,
      body: "Good catch — refresh added, please retest.",
    });
    expect(reply.ok).toBe(true);
    await updateIssue({ issueId, status: "IN_REVIEW" });

    // 5. The reporter verifies again and signs it off.
    await actAs(ADMIN);
    const passed = await recordTestResult({ issueId, result: "PASSED" });
    expect(passed.ok).toBe(true);
    expect((await verdict(issueId)).testResult).toBe("PASSED");

    // The whole exchange is on the issue: three comments, and both verdicts
    // preserved in the append-only trail even though the column holds one.
    const comments = await prisma.comment.count({ where: { issueId } });
    expect(comments).toBe(3);

    const trail = await prisma.activityLogEntry.findMany({
      where: { issueId, field: "testResult" },
      orderBy: { createdAt: "asc" },
      select: { oldValue: true, newValue: true, actorId: true },
    });
    expect(trail.map((t) => t.newValue)).toEqual(["FAILED", "PASSED"]);
    /* Both verdicts were recorded by the same person — the one who raised the
       issue, which is the only person who may. */
    expect(new Set(trail.map((t) => t.actorId))).toEqual(
      new Set([await userId(ADMIN)]),
    );
  });

  it("keeps the verdict across independent sessions", async () => {
    const issueId = await anIssue("QA persistence fixture");
    const dev = await userId(DEV);

    await actAs(ADMIN);
    await updateIssue({ issueId, assigneeId: dev });
    // The reporter records it — the fixture raised this issue as ADMIN.
    await recordTestResult({ issueId, result: "BLOCKED" });

    // A different person entirely reads it back.
    await actAs(ADMIN);
    expect((await verdict(issueId)).testResult).toBe("BLOCKED");
  });
});

describe("who may record a verdict", () => {
  it("refuses to let the assignee sign off their own work", async () => {
    const issueId = await anIssue("QA self-signoff fixture");
    const dev = await userId(DEV);

    await actAs(ADMIN);
    await updateIssue({ issueId, assigneeId: dev });

    // Called directly, with no button involved — the only version that counts.
    await actAs(DEV);
    const result = await recordTestResult({ issueId, result: "PASSED" });
    expect(result.ok).toBe(false);

    expect((await verdict(issueId)).testResult).toBe("NOT_TESTED");
  });

  it("refuses a project member who did not raise the issue", async () => {
    /* Recording a verdict says whether the reported problem is actually
       fixed, and only the person who reported it can say that. Being on the
       project is not enough — this used to be allowed and is not any more. */
    const issueId = await anIssue("QA peer verdict fixture");
    const dev = await userId(DEV);

    await actAs(ADMIN);
    await updateIssue({ issueId, assigneeId: dev });

    await actAs(TESTER);
    const result = await recordTestResult({ issueId, result: "PASSED" });
    expect(result.ok).toBe(false);

    expect((await verdict(issueId)).testResult).toBe("NOT_TESTED");
  });

  it("refuses an administrator who did not raise the issue", async () => {
    /* Administering Prio does not confer knowledge of whether a fix works,
       so there is no override here. */
    const issueId = await anIssue("QA admin non-reporter fixture");
    const tester = await userId(TESTER);

    /* The reporter is set directly: `updateIssue` does not expose it, which
       is itself the point — who raised an issue is not something anybody
       edits later. */
    await prisma.issue.update({
      where: { id: issueId },
      data: { reporterId: tester },
    });

    await actAs(ADMIN);
    const result = await recordTestResult({ issueId, result: "PASSED" });
    expect(result.ok).toBe(false);
    expect((await verdict(issueId)).testResult).toBe("NOT_TESTED");
  });

  it("lets the person who raised the issue record one", async () => {
    const issueId = await anIssue("QA reporter verdict fixture");
    const admin = await userId(ADMIN);

    await actAs(ADMIN);
    const result = await recordTestResult({ issueId, result: "PASSED" });
    expect(result.ok).toBe(true);
    expect((await verdict(issueId)).testedById).toBe(admin);
  });

  it("refuses someone with no access to the issue's project", async () => {
    const issueId = await anIssue("QA outsider fixture");

    /*
     * Creates its own outsider rather than hunting the seed for one: every
     * seeded member belongs to ENG, and picking a real account would depend
     * on a password this test has no business knowing. `signUp` gives a
     * genuine account, in no project, with a password chosen here.
     */
    const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const email = `qa-outsider-${stamp}@symbiosystech.local`;
    const password = "Fixture-Password-1";

    const registered = await signUp({
      name: "QA Outsider Fixture",
      email,
      password,
      confirmPassword: password,
    });
    expect(registered.ok).toBe(true);

    const outsider = await prisma.user.findUniqueOrThrow({
      where: { email },
      select: { id: true },
    });

    try {
      expect(
        await prisma.projectMember.count({ where: { userId: outsider.id } }),
        "the fixture must genuinely be outside every project",
      ).toBe(0);

      await actAs(email, password);
      const result = await recordTestResult({ issueId, result: "PASSED" });
      expect(result.ok).toBe(false);

      expect((await verdict(issueId)).testResult).toBe("NOT_TESTED");
    } finally {
      await prisma.user.delete({ where: { id: outsider.id } });
    }
  });

  it("rejects a value that is not a real verdict", async () => {
    const issueId = await anIssue("QA bad input fixture");

    await actAs(TESTER);
    const result = await recordTestResult({ issueId, result: "LGTM" });
    expect(result.ok).toBe(false);
    expect((await verdict(issueId)).testResult).toBe("NOT_TESTED");
  });
});

describe("notification restraint", () => {
  it("does not notify the tester about their own verdict", async () => {
    const issueId = await anIssue("QA self-notify fixture");
    const dev = await userId(DEV);
    const tester = await userId(TESTER);

    await actAs(ADMIN);
    await updateIssue({ issueId, assigneeId: dev });
    await actAs(TESTER);
    await recordTestResult({ issueId, result: "FAILED" });

    const own = await prisma.notification.count({
      where: { userId: tester, issueId, type: "TEST_RESULT" },
    });
    expect(own).toBe(0);
  });

  it("writes no notification for clearing a verdict back to Not tested", async () => {
    const issueId = await anIssue("QA clear fixture");
    const dev = await userId(DEV);

    await actAs(ADMIN);
    await updateIssue({ issueId, assigneeId: dev });
    await actAs(TESTER);
    await recordTestResult({ issueId, result: "PASSED" });

    const before = await prisma.notification.count({
      where: { issueId, type: "TEST_RESULT" },
    });

    await recordTestResult({ issueId, result: "NOT_TESTED" });

    const after = await prisma.notification.count({
      where: { issueId, type: "TEST_RESULT" },
    });
    expect(after).toBe(before);

    // Clearing also drops who tested it, rather than leaving a stale name.
    const cleared = await verdict(issueId);
    expect(cleared.testResult).toBe("NOT_TESTED");
    expect(cleared.testedById).toBeNull();
    expect(cleared.testedAt).toBeNull();
  });

  it("writes nothing at all when the verdict is re-selected unchanged", async () => {
    const issueId = await anIssue("QA idempotent fixture");
    const dev = await userId(DEV);

    await actAs(ADMIN);
    await updateIssue({ issueId, assigneeId: dev });
    // Recorded by the reporter, which the fixture makes ADMIN.
    await recordTestResult({ issueId, result: "PASSED" });

    const entries = await prisma.activityLogEntry.count({
      where: { issueId, field: "testResult" },
    });

    const again = await recordTestResult({ issueId, result: "PASSED" });
    expect(again.ok).toBe(true);

    expect(
      await prisma.activityLogEntry.count({
        where: { issueId, field: "testResult" },
      }),
    ).toBe(entries);
  });
});

describe("reporting a bug against work under test", () => {
  it("files a linked bug, assigned back to the developer, with no manual context", async () => {
    const issueId = await anIssue("QA report-bug fixture");
    const dev = await userId(DEV);
    const tester = await userId(TESTER);

    await actAs(ADMIN);
    await updateIssue({ issueId, assigneeId: dev });

    const original = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: { key: true, projectId: true },
    });

    await actAs(TESTER);
    const reported = await reportBug({
      issueId,
      title: "Login button stops responding after a failed attempt",
      affectedModule: "Login page",
      priority: "HIGH",
    });
    expect(reported.ok).toBe(true);
    if (!reported.ok) return;
    created.push(reported.data.id);

    const bug = await prisma.issue.findUniqueOrThrow({
      where: { id: reported.data.id },
      select: {
        type: true,
        status: true,
        priority: true,
        projectId: true,
        reporterId: true,
        assigneeId: true,
        affectedModule: true,
      },
    });

    // Everything Prio already knew was filled in, not asked for.
    expect(bug.type).toBe("BUG");
    expect(bug.projectId).toBe(original.projectId);
    expect(bug.reporterId).toBe(tester);
    expect(bug.assigneeId).toBe(dev);
    expect(bug.status).toBe("TODO");

    // ...and what only the tester knew was stored on the existing column.
    expect(bug.affectedModule).toBe("Login page");
    expect(bug.priority).toBe("HIGH");

    // Linked both ways through the existing IssueLink table.
    const forward = await prisma.issueLink.count({
      where: { sourceId: reported.data.id, targetId: issueId, type: "RELATES_TO" },
    });
    const back = await prisma.issueLink.count({
      where: { sourceId: issueId, targetId: reported.data.id, type: "RELATES_TO" },
    });
    expect(forward).toBe(1);
    expect(back).toBe(1);

    // The developer is told, through the existing notification system.
    const told = await prisma.notification.findFirst({
      where: { userId: dev, issueId: reported.data.id },
      select: { message: true, actorId: true },
    });
    expect(told?.actorId).toBe(tester);
    expect(told?.message).toContain(original.key);

    // Recorded as a bug creation in the existing activity trail.
    const activity = await prisma.activityLogEntry.findMany({
      where: { issueId: reported.data.id },
      select: { action: true },
    });
    expect(activity.map((a) => a.action)).toContain("bug.created");
  });

  it("requires a summary and where the problem was found", async () => {
    const issueId = await anIssue("QA report-bug validation fixture");

    await actAs(TESTER);
    const result = await reportBug({
      issueId,
      title: "Thin",
      affectedModule: "",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    for (const field of ["title", "affectedModule"]) {
      expect(Object.keys(result.fieldErrors ?? {})).toContain(field);
    }
  });

  it("refuses someone with no access to the issue under test", async () => {
    const issueId = await anIssue("QA report-bug outsider fixture");

    const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const email = `qa-bug-outsider-${stamp}@symbiosystech.local`;
    const password = "Fixture-Password-1";
    await signUp({ name: "Bug Outsider", email, password, confirmPassword: password });

    const outsider = await prisma.user.findUniqueOrThrow({
      where: { email },
      select: { id: true },
    });

    try {
      const before = await prisma.issue.count();

      await actAs(email, password);
      const result = await reportBug({
        issueId,
        title: "Should never be created",
        affectedModule: "Nowhere",
      });

      expect(result.ok).toBe(false);
      // Nothing was written — not even a half-created issue.
      expect(await prisma.issue.count()).toBe(before);
    } finally {
      await prisma.user.delete({ where: { id: outsider.id } });
    }
  });
});
