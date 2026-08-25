import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createIssue, updateIssue } from "@/server/issues";
import { actAs, deleteIssues, projectByKey } from "./helpers";

/**
 * Work submission, and who is allowed to move work between people.
 *
 * Two separate rules live here and are easy to conflate:
 *
 *   - **Working on an issue** — commenting, moving it through the workflow,
 *     submitting it for review — needs only project access, as it always has.
 *   - **Reassigning an issue that already belongs to someone** is
 *     administrative. A member can pick up unassigned work and can hand on
 *     work that is currently theirs, but cannot take another person's work.
 *
 * Every assertion goes through the real server actions with a real session,
 * so what is measured is the boundary itself rather than a hidden button.
 */

const created: string[] = [];

const ADMIN = "admin@symbiosystech.com";
const MEMBER_A = "priya.nair@symbiosystech.com";
const MEMBER_B = "kiran.das@symbiosystech.com";

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

/** A fresh unassigned TODO issue in a project all three share. */
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

describe("submitting work for review", () => {
  it("moves the assignee's own issue to In Review and records who did it", async () => {
    const issueId = await anIssue("Submission fixture — happy path");
    const memberA = await userId(MEMBER_A);

    await actAs(ADMIN);
    await updateIssue({ issueId, assigneeId: memberA });

    // The assignee submits their own work — the same call the button makes.
    await actAs(MEMBER_A);
    const submitted = await updateIssue({ issueId, status: "IN_REVIEW" });
    expect(submitted.ok).toBe(true);

    const row = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: { status: true, assigneeId: true },
    });
    expect(row.status).toBe("IN_REVIEW");
    // Submitting does not quietly hand the work to somebody else.
    expect(row.assigneeId).toBe(memberA);

    // The reviewer can see who submitted it and when, from the existing trail.
    const entry = await prisma.activityLogEntry.findFirstOrThrow({
      where: { issueId, field: "status", newValue: "IN_REVIEW" },
      select: { actorId: true, oldValue: true, createdAt: true },
    });
    expect(entry.actorId).toBe(memberA);
    expect(entry.oldValue).toBe("TODO");
    expect(entry.createdAt).toBeInstanceOf(Date);
  });

  it("survives re-reading as a different authorized user", async () => {
    const issueId = await anIssue("Submission fixture — persistence");
    const memberA = await userId(MEMBER_A);

    await actAs(ADMIN);
    await updateIssue({ issueId, assigneeId: memberA });
    await actAs(MEMBER_A);
    await updateIssue({ issueId, status: "IN_REVIEW" });

    // A different session entirely reads the same row — the submission is in
    // PostgreSQL, not in anybody's client state.
    await actAs(MEMBER_B);
    const seen = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: { status: true },
    });
    expect(seen.status).toBe("IN_REVIEW");
  });
});

describe("assignment protection", () => {
  it("lets a member pick up unassigned work", async () => {
    const issueId = await anIssue("Assignment fixture — pick up");
    const memberA = await userId(MEMBER_A);

    await actAs(MEMBER_A);
    const result = await updateIssue({ issueId, assigneeId: memberA });
    expect(result.ok).toBe(true);

    const row = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: { assigneeId: true },
    });
    expect(row.assigneeId).toBe(memberA);
  });

  it("lets a member hand on work that is currently their own", async () => {
    const issueId = await anIssue("Assignment fixture — hand on");
    const memberA = await userId(MEMBER_A);
    const memberB = await userId(MEMBER_B);

    await actAs(ADMIN);
    await updateIssue({ issueId, assigneeId: memberA });

    await actAs(MEMBER_A);
    const result = await updateIssue({ issueId, assigneeId: memberB });
    expect(result.ok).toBe(true);

    const row = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: { assigneeId: true },
    });
    expect(row.assigneeId).toBe(memberB);
  });

  it("refuses to let a member take another member's work", async () => {
    const issueId = await anIssue("Assignment fixture — takeover");
    const memberA = await userId(MEMBER_A);
    const memberB = await userId(MEMBER_B);

    await actAs(ADMIN);
    await updateIssue({ issueId, assigneeId: memberA });

    // B calls the server action directly — no button involved, which is the
    // only version of this attempt that matters.
    await actAs(MEMBER_B);
    const result = await updateIssue({ issueId, assigneeId: memberB });
    expect(result.ok).toBe(false);

    const row = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: { assigneeId: true },
    });
    expect(row.assigneeId).toBe(memberA);
  });

  it("refuses to let a member unassign another member's work", async () => {
    const issueId = await anIssue("Assignment fixture — strip");
    const memberA = await userId(MEMBER_A);

    await actAs(ADMIN);
    await updateIssue({ issueId, assigneeId: memberA });

    await actAs(MEMBER_B);
    const result = await updateIssue({ issueId, assigneeId: "" });
    expect(result.ok).toBe(false);

    const row = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: { assigneeId: true },
    });
    expect(row.assigneeId).toBe(memberA);
  });

  it("still lets an admin reassign anyone's work", async () => {
    const issueId = await anIssue("Assignment fixture — admin override");
    const memberA = await userId(MEMBER_A);
    const memberB = await userId(MEMBER_B);

    await actAs(ADMIN);
    await updateIssue({ issueId, assigneeId: memberA });
    const result = await updateIssue({ issueId, assigneeId: memberB });
    expect(result.ok).toBe(true);

    const row = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: { assigneeId: true },
    });
    expect(row.assigneeId).toBe(memberB);
  });

  it("does not block a member from ordinary work on someone else's issue", async () => {
    /*
     * The guard must be narrow. Moving another person's issue through the
     * workflow is normal collaboration and has to keep working — only the
     * assignment itself is protected.
     */
    const issueId = await anIssue("Assignment fixture — collaboration intact");
    const memberA = await userId(MEMBER_A);

    await actAs(ADMIN);
    await updateIssue({ issueId, assigneeId: memberA });

    await actAs(MEMBER_B);
    const status = await updateIssue({ issueId, status: "IN_PROGRESS" });
    expect(status.ok).toBe(true);

    const priority = await updateIssue({ issueId, priority: "HIGH" });
    expect(priority.ok).toBe(true);

    const row = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: { status: true, priority: true, assigneeId: true },
    });
    expect(row.status).toBe("IN_PROGRESS");
    expect(row.priority).toBe("HIGH");
    expect(row.assigneeId).toBe(memberA);
  });
});
