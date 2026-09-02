import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { IssueStatus } from "@prisma/client";
import {
  allowedTransitions,
  canTransition,
  ISSUE_STATUSES,
  STATUS_TRANSITIONS,
} from "@/lib/domain";
import { createIssue, updateIssue } from "@/server/issues";
import { prisma } from "@/lib/prisma";
import { actAs, projectByKey } from "./helpers";

/**
 * The workflow, and the fact that it is enforced where it cannot be avoided.
 *
 * The rules themselves are a declaration, so most of what matters is that the
 * server applies them — a UI that only offers valid moves is an accuracy, not
 * a boundary, and a request that never went near the interface has to meet the
 * same rule.
 */

describe("the transition rules themselves", () => {
  it("lets an issue stay where it is", () => {
    for (const status of ISSUE_STATUSES) {
      expect(canTransition(status, status)).toBe(true);
    }
  });

  it("names a destination for every status", () => {
    for (const status of ISSUE_STATUSES) {
      expect(STATUS_TRANSITIONS[status].length).toBeGreaterThan(0);
    }
  });

  it("only ever names real statuses", () => {
    for (const status of ISSUE_STATUSES) {
      for (const next of STATUS_TRANSITIONS[status]) {
        expect(ISSUE_STATUSES).toContain(next);
      }
    }
  });

  it("reaches Done only from Ready for QA or In QA", () => {
    /* The rule the whole workflow exists for: work does not finish without
       somebody having had the chance to look at it. */
    const canFinish = ISSUE_STATUSES.filter(
      (from) => from !== "DONE" && canTransition(from, "DONE"),
    );
    /* Reopened work can finish again without repeating the whole journey --
       it has already been through review once. */
    expect(canFinish.sort()).toEqual(["IN_QA", "IN_REVIEW", "REOPENED"]);
  });

  it("refuses the jumps that skip the workflow", () => {
    expect(canTransition("TODO", "DONE")).toBe(false);
    expect(canTransition("BACKLOG", "DONE")).toBe(false);
    expect(canTransition("IN_PROGRESS", "DONE")).toBe(false);
    expect(canTransition("BACKLOG", "IN_REVIEW")).toBe(false);
  });

  it("allows the ordinary path through", () => {
    expect(canTransition("BACKLOG", "TODO")).toBe(true);
    expect(canTransition("TODO", "IN_PROGRESS")).toBe(true);
    expect(canTransition("TODO", "IN_REVIEW")).toBe(true);
    expect(canTransition("IN_PROGRESS", "IN_REVIEW")).toBe(true);
    expect(canTransition("IN_REVIEW", "IN_QA")).toBe(true);
    expect(canTransition("IN_QA", "DONE")).toBe(true);
  });

  it("lets work be abandoned and brought back", () => {
    for (const from of ["BACKLOG", "TODO", "IN_PROGRESS", "IN_REVIEW", "IN_QA"] as const) {
      expect(canTransition(from, "CANCELLED")).toBe(true);
    }
    expect(canTransition("CANCELLED", "TODO")).toBe(true);
    expect(canTransition("DONE", "IN_PROGRESS")).toBe(true);
  });

  it("offers the same set the rules allow, in board order", () => {
    const offered = allowedTransitions("IN_REVIEW");
    expect(offered).toContain("IN_QA");
    expect(offered).toContain("IN_REVIEW"); // staying put
    expect(offered).not.toContain("TODO");
    // Board order, not declaration order.
    expect(offered).toEqual(
      ISSUE_STATUSES.filter((s) => offered.includes(s)),
    );
  });
});

/*
 * What the server does with a status change.
 *
 * It used to refuse any move the table did not describe. That followed from
 * the issue page offering only valid destinations -- and the issue page now
 * offers every status the project has, deliberately, so refusing the choice it
 * just presented would leave a control that visibly does nothing. The table
 * still describes the ordinary path and still shapes the board's drag and
 * drop; it is no longer a gate on the write.
 *
 * Authorization is untouched and is tested elsewhere: who may change an issue
 * is a security question, and that answer has not moved.
 */
describe("the server accepts any status the project has", () => {
  const created: string[] = [];

  beforeAll(async () => {
    await actAs("admin@symbiosystech.com");
  });

  afterAll(async () => {
    if (created.length > 0) {
      await prisma.issue.deleteMany({ where: { id: { in: created } } });
    }
  });

  async function anIssueIn(status: IssueStatus): Promise<string> {
    const project = await projectByKey("ENG");
    const result = await createIssue({
      projectId: project.id,
      type: "TASK",
      title: `Transition fixture ${status}`,
      description: "Created by the integration suite.",
      status,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("fixture not created");
    created.push(result.data.id);
    return result.data.id;
  }

  it("allows a jump the ordinary path does not describe", async () => {
    const issueId = await anIssueIn("TODO");

    // The table does not describe this move...
    expect(canTransition("TODO", "DONE")).toBe(false);

    // ...and the server performs it anyway, because somebody chose it.
    const result = await updateIssue({ issueId, status: "DONE" });
    expect(result.ok).toBe(true);

    const after = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: { status: true, completedAt: true },
    });
    expect(after.status).toBe("DONE");
    // Finishing still stamps the completion date, however it was reached.
    expect(after.completedAt).not.toBeNull();
  });

  it("records the move in the history like any other", async () => {
    const issueId = await anIssueIn("TODO");
    const before = await prisma.activityLogEntry.count({ where: { issueId } });

    await updateIssue({ issueId, status: "DONE" });

    expect(await prisma.activityLogEntry.count({ where: { issueId } })).toBe(
      before + 1,
    );
  });

  it("reaches the statuses added for reopening and rejecting", async () => {
    const issueId = await anIssueIn("TODO");

    expect(await updateIssue({ issueId, status: "REJECTED" })).toMatchObject({
      ok: true,
    });
    expect(await updateIssue({ issueId, status: "REOPENED" })).toMatchObject({
      ok: true,
    });

    const after = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: { status: true },
    });
    expect(after.status).toBe("REOPENED");
  });

  it("allows a move the workflow permits", async () => {
    const issueId = await anIssueIn("TODO");

    const result = await updateIssue({ issueId, status: "IN_PROGRESS" });
    expect(result.ok).toBe(true);

    const after = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: { status: true },
    });
    expect(after.status).toBe("IN_PROGRESS");
  });

  it("lets an issue reach Done the long way round", async () => {
    const issueId = await anIssueIn("TODO");

    for (const step of ["IN_PROGRESS", "IN_REVIEW", "IN_QA", "DONE"] as const) {
      const result = await updateIssue({ issueId, status: step });
      expect(result.ok, `${step} should be allowed`).toBe(true);
    }

    const after = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: { status: true, completedAt: true },
    });
    expect(after.status).toBe("DONE");
    // Finishing still stamps the completion date it always did.
    expect(after.completedAt).not.toBeNull();
  });

  it("does not treat an unchanged status as a transition", async () => {
    /* Saving a form without touching the status must not be refused because
       the issue happens to sit somewhere with few exits. */
    const issueId = await anIssueIn("DONE");

    const result = await updateIssue({ issueId, status: "DONE", title: "Renamed" });
    expect(result.ok).toBe(true);

    const after = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: { status: true, title: true },
    });
    expect(after.status).toBe("DONE");
    expect(after.title).toBe("Renamed");
  });
});
