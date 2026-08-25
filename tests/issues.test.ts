import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createIssue, updateIssue } from "@/server/issues";
import { actAs, deleteIssues, projectByKey } from "./helpers";

/**
 * Integration coverage for issue, story and bug creation.
 *
 * These run against the real PostgreSQL database with a real better-auth
 * session, so they exercise validation, key allocation, activity logging and
 * notifications exactly as the UI does.
 */

const created: string[] = [];

afterAll(async () => {
  await deleteIssues(created);
  await prisma.$disconnect();
});

describe("createIssue", () => {
  it("creates a task and allocates the next issue key", async () => {
    const user = await actAs("admin@symbiosystech.com");
    const project = await projectByKey("ENG");

    const result = await createIssue({
      projectId: project.id,
      type: "TASK",
      title: "Verify issue key allocation",
      description: "Created by the integration suite.",
      status: "TODO",
      priority: "HIGH",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    created.push(result.data.id);

    expect(result.data.key).toBe(`ENG-${project.issueSequence + 1}`);

    const row = await prisma.issue.findUniqueOrThrow({
      where: { id: result.data.id },
      select: {
        type: true,
        status: true,
        priority: true,
        severity: true,
        reporterId: true,
        number: true,
        stepsToReproduce: true,
      },
    });

    expect(row.type).toBe("TASK");
    expect(row.status).toBe("TODO");
    expect(row.priority).toBe("HIGH");
    expect(row.reporterId).toBe(user.id);
    // Bug-only fields stay null on a task.
    expect(row.severity).toBeNull();
    expect(row.stepsToReproduce).toBeNull();

    // The project counter advanced with it.
    const after = await projectByKey("ENG");
    expect(after.issueSequence).toBe(row.number);
  });

  it("creates a story", async () => {
    await actAs("priya.nair@symbiosystech.com");
    const project = await projectByKey("ENG");

    const result = await createIssue({
      projectId: project.id,
      type: "STORY",
      title: "As a tester I want stories to persist",
      description: "So that the story path is covered too.",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    created.push(result.data.id);

    const row = await prisma.issue.findUniqueOrThrow({
      where: { id: result.data.id },
      select: { type: true, status: true, priority: true },
    });

    expect(row.type).toBe("STORY");
    // Defaults from the schema.
    expect(row.status).toBe("BACKLOG");
    expect(row.priority).toBe("MEDIUM");
  });

  it("still requires a bug to describe the problem", async () => {
    await actAs("admin@symbiosystech.com");
    const project = await projectByKey("ENG");

    const result = await createIssue({
      projectId: project.id,
      type: "BUG",
      title: "Incomplete bug report",
      // no description
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(Object.keys(result.fieldErrors ?? {})).toContain("description");
  });

  /*
   * Reproduction steps, expected result and actual result were once mandatory.
   * They were removed from the creation form, so demanding them would reject
   * every bug the UI can produce. This asserts the new contract explicitly
   * rather than leaving the relaxation untested.
   */
  it("no longer demands reproduction steps, expected or actual result", async () => {
    await actAs("admin@symbiosystech.com");
    const project = await projectByKey("ENG");

    const result = await createIssue({
      projectId: project.id,
      type: "BUG",
      title: "Bug reported the way the form now submits it",
      description: "The board drops a card when two are dragged at once.",
      severity: "MAJOR",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    created.push(result.data.id);

    const row = await prisma.issue.findUniqueOrThrow({
      where: { id: result.data.id },
      select: {
        severity: true,
        stepsToReproduce: true,
        expectedResult: true,
        actualResult: true,
      },
    });

    // Severity survived; the retired fields are simply empty, not defaulted.
    expect(row.severity).toBe("MAJOR");
    expect(row.stepsToReproduce).toBeNull();
    expect(row.expectedResult).toBeNull();
    expect(row.actualResult).toBeNull();
  });

  it("creates a bug with every bug-specific field and records activity", async () => {
    const reporter = await actAs("sneha.iyer@symbiosystech.com");
    const project = await projectByKey("ENG");

    const assignee = await prisma.user.findUniqueOrThrow({
      where: { email: "kiran.das@symbiosystech.com" },
      select: { id: true },
    });

    const result = await createIssue({
      projectId: project.id,
      type: "BUG",
      title: "Board loses card after rapid drag",
      description: "Cards vanish when dropped twice in quick succession.",
      status: "TODO",
      priority: "URGENT",
      severity: "CRITICAL",
      assigneeId: assignee.id,
      stepsToReproduce: "1. Open the board\n2. Drag a card twice quickly",
      expectedResult: "The card settles in the target column.",
      actualResult: "The card disappears until the page is reloaded.",
      environment: "Staging",
      browser: "Chrome 141",
      operatingSystem: "Windows 11",
      versionBuild: "2026.8.20-test",
      affectedModule: "Board",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    created.push(result.data.id);

    const bug = await prisma.issue.findUniqueOrThrow({
      where: { id: result.data.id },
      select: {
        type: true,
        severity: true,
        priority: true,
        stepsToReproduce: true,
        expectedResult: true,
        actualResult: true,
        environment: true,
        browser: true,
        operatingSystem: true,
        versionBuild: true,
        affectedModule: true,
        assigneeId: true,
        reporterId: true,
      },
    });

    expect(bug.type).toBe("BUG");
    // Severity and priority are independent concepts and both persist.
    expect(bug.severity).toBe("CRITICAL");
    expect(bug.priority).toBe("URGENT");
    expect(bug.stepsToReproduce).toContain("Drag a card twice");
    expect(bug.expectedResult).toContain("settles");
    expect(bug.actualResult).toContain("disappears");
    expect(bug.environment).toBe("Staging");
    expect(bug.browser).toBe("Chrome 141");
    expect(bug.operatingSystem).toBe("Windows 11");
    expect(bug.versionBuild).toBe("2026.8.20-test");
    expect(bug.affectedModule).toBe("Board");
    expect(bug.assigneeId).toBe(assignee.id);
    expect(bug.reporterId).toBe(reporter.id);

    // Creation is recorded as bug.created, not issue.created.
    const activity = await prisma.activityLogEntry.findMany({
      where: { issueId: result.data.id },
      select: { action: true },
    });
    expect(activity.map((a) => a.action)).toContain("bug.created");

    // The assignee was notified and is now watching.
    const notification = await prisma.notification.findFirst({
      where: { issueId: result.data.id, userId: assignee.id },
      select: { type: true },
    });
    expect(notification?.type).toBe("ISSUE_ASSIGNED");

    const watchers = await prisma.issueWatcher.findMany({
      where: { issueId: result.data.id },
      select: { userId: true },
    });
    expect(watchers.map((w) => w.userId)).toEqual(
      expect.arrayContaining([reporter.id, assignee.id]),
    );
  });

  it("issues consecutive, never-reused keys under repeated creation", async () => {
    await actAs("admin@symbiosystech.com");
    const project = await projectByKey("WEB");

    const first = await createIssue({
      projectId: project.id,
      type: "TASK",
      title: "Sequence check one",
    });
    const second = await createIssue({
      projectId: project.id,
      type: "TASK",
      title: "Sequence check two",
    });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    created.push(first.data.id, second.data.id);

    const firstNumber = Number(first.data.key.split("-")[1]);
    const secondNumber = Number(second.data.key.split("-")[1]);

    expect(secondNumber).toBe(firstNumber + 1);

    // Deleting an issue must not free its number for reuse.
    await prisma.issue.delete({ where: { id: second.data.id } });
    created.splice(created.indexOf(second.data.id), 1);

    const third = await createIssue({
      projectId: project.id,
      type: "TASK",
      title: "Sequence check three",
    });
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    created.push(third.data.id);

    expect(Number(third.data.key.split("-")[1])).toBe(secondNumber + 1);
  });
});

describe("updateIssue", () => {
  it("moves a bug through the workflow and records each change", async () => {
    const actor = await actAs("kiran.das@symbiosystech.com");
    const project = await projectByKey("ENG");

    const result = await createIssue({
      projectId: project.id,
      type: "BUG",
      title: "Workflow transition check",
      description: "Used to verify status transitions are recorded.",
      status: "TODO",
      priority: "MEDIUM",
      severity: "MINOR",
      stepsToReproduce: "1. Do the thing",
      expectedResult: "It works",
      actualResult: "It does not",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    created.push(result.data.id);

    const moveTo = async (status: string) => {
      const update = await updateIssue({ issueId: result.data.id, status });
      expect(update.ok).toBe(true);
    };

    await moveTo("IN_PROGRESS");
    await moveTo("IN_REVIEW");
    await moveTo("DONE");

    const bug = await prisma.issue.findUniqueOrThrow({
      where: { id: result.data.id },
      select: { status: true, completedAt: true },
    });

    expect(bug.status).toBe("DONE");
    // Closing stamps completedAt so reports can measure resolution.
    expect(bug.completedAt).not.toBeNull();

    const statusChanges = await prisma.activityLogEntry.findMany({
      where: { issueId: result.data.id, field: "status" },
      orderBy: { createdAt: "asc" },
      select: { oldValue: true, newValue: true, actorId: true },
    });

    expect(statusChanges).toHaveLength(3);
    expect(statusChanges[0]).toMatchObject({
      oldValue: "TODO",
      newValue: "IN_PROGRESS",
      actorId: actor.id,
    });
    expect(statusChanges[2]).toMatchObject({
      oldValue: "IN_REVIEW",
      newValue: "DONE",
    });
  });

  it("records severity and priority as separate changes", async () => {
    await actAs("admin@symbiosystech.com");
    const project = await projectByKey("ENG");

    const result = await createIssue({
      projectId: project.id,
      type: "BUG",
      title: "Severity and priority independence",
      description: "Severity and priority must not be derived from each other.",
      priority: "LOW",
      severity: "CRITICAL",
      stepsToReproduce: "1. Inspect the fields",
      expectedResult: "They are independent",
      actualResult: "Checking",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    created.push(result.data.id);

    await updateIssue({ issueId: result.data.id, priority: "URGENT" });

    const row = await prisma.issue.findUniqueOrThrow({
      where: { id: result.data.id },
      select: { priority: true, severity: true },
    });

    // Changing priority left severity untouched.
    expect(row.priority).toBe("URGENT");
    expect(row.severity).toBe("CRITICAL");

    const changes = await prisma.activityLogEntry.findMany({
      where: { issueId: result.data.id, field: { in: ["priority", "severity"] } },
      select: { field: true, oldValue: true, newValue: true },
    });

    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      field: "priority",
      oldValue: "LOW",
      newValue: "URGENT",
    });
  });

  it("makes no change, and writes no activity, when nothing differs", async () => {
    await actAs("admin@symbiosystech.com");
    const project = await projectByKey("INT");

    const result = await createIssue({
      projectId: project.id,
      type: "TASK",
      title: "No-op update check",
      status: "TODO",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    created.push(result.data.id);

    const before = await prisma.activityLogEntry.count({
      where: { issueId: result.data.id },
    });

    await updateIssue({ issueId: result.data.id, status: "TODO" });

    const after = await prisma.activityLogEntry.count({
      where: { issueId: result.data.id },
    });

    expect(after).toBe(before);
  });

  it("reassigns to a project member, persists it and records the change", async () => {
    await actAs("admin@symbiosystech.com");
    const project = await projectByKey("ENG");

    const result = await createIssue({
      projectId: project.id,
      type: "TASK",
      title: "Reassignment persists",
      description: "Checks the assignee change is saved and logged.",
      status: "TODO",
      priority: "MEDIUM",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    created.push(result.data.id);

    const member = await prisma.projectMember.findFirstOrThrow({
      where: { projectId: project.id },
      select: { userId: true },
    });

    const update = await updateIssue({
      issueId: result.data.id,
      assigneeId: member.userId,
    });
    expect(update.ok).toBe(true);

    const row = await prisma.issue.findUniqueOrThrow({
      where: { id: result.data.id },
      select: { assigneeId: true },
    });
    expect(row.assigneeId).toBe(member.userId);

    const activity = await prisma.activityLogEntry.findFirst({
      where: { issueId: result.data.id, field: "assigneeId" },
      select: { newValue: true },
    });
    expect(activity?.newValue).toBe(member.userId);
  });

  it("refuses to assign someone who is not a member of the issue's project", async () => {
    /*
     * `createIssue` already refuses a non-member assignee at the moment of
     * creation — this proves the same rule holds on the separate `updateIssue`
     * write path, which reassigns an existing issue rather than creating one.
     */
    await actAs("admin@symbiosystech.com");
    const project = await projectByKey("ENG");

    const result = await createIssue({
      projectId: project.id,
      type: "TASK",
      title: "Reassignment authorization",
      description: "An outsider must not become assignable via update.",
      status: "TODO",
      priority: "MEDIUM",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    created.push(result.data.id);

    const outsider = await prisma.user.findFirstOrThrow({
      where: { projectMemberships: { none: { projectId: project.id } } },
      select: { id: true },
    });

    const update = await updateIssue({
      issueId: result.data.id,
      assigneeId: outsider.id,
    });
    expect(update.ok).toBe(false);
    if (!update.ok) {
      expect(update.fieldErrors?.assigneeId).toBeDefined();
    }

    const row = await prisma.issue.findUniqueOrThrow({
      where: { id: result.data.id },
      select: { assigneeId: true },
    });
    expect(row.assigneeId).toBeNull();
  });
});
