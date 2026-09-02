import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BOARD_STATUSES } from "@/lib/board";
import { allowedTransitions, canTransition, ISSUE_STATUSES } from "@/lib/domain";
import { prisma } from "@/lib/prisma";
import { createIssue, updateIssue } from "@/server/issues";
import { actAs, projectByKey } from "./helpers";

/**
 * Backlog on the Flow Board.
 *
 * Two separate claims, and they are easy to conflate:
 *
 *  1. Backlog is a column, so filed-but-unplanned work — which is where most
 *     unassigned issues sit — is visible on the board rather than only in the
 *     issue list. The board page selects `status: { in: BOARD_STATUSES }`, so
 *     this is decided by the query, not by anything the browser does after
 *     the rows arrive.
 *
 *  2. Being a column buys it no privileges. Which columns will accept a card
 *     dragged from Backlog comes from `STATUS_TRANSITIONS`, exactly as it does
 *     for every other status, which is what stops the column being quietly
 *     treated as a review or QA queue. The issue page's own status menu is a
 *     separate surface and deliberately offers every status.
 */

describe("the board's columns", () => {
  it("includes Backlog", () => {
    expect(BOARD_STATUSES).toContain("BACKLOG");
  });

  it("leads with it, in the same order as the rest of the app", () => {
    expect(BOARD_STATUSES[0]).toBe("BACKLOG");
    expect(BOARD_STATUSES).toEqual(
      ISSUE_STATUSES.filter((status) => BOARD_STATUSES.includes(status)),
    );
  });

  it("names only real statuses, once each", () => {
    for (const status of BOARD_STATUSES) {
      expect(ISSUE_STATUSES).toContain(status);
    }
    expect(new Set(BOARD_STATUSES).size).toBe(BOARD_STATUSES.length);
  });
});

describe("Backlog is not a QA queue", () => {
  it("cannot reach the QA or finished statuses directly", () => {
    /* The point of E2: a Backlog column must not become a place work can be
       signed off from. Nothing here special-cases Backlog — the answer comes
       from the same table every other column uses. */
    expect(canTransition("BACKLOG", "IN_QA")).toBe(false);
    expect(canTransition("BACKLOG", "IN_REVIEW")).toBe(false);
    expect(canTransition("BACKLOG", "DONE")).toBe(false);
  });

  it("leads where planning leads", () => {
    expect(canTransition("BACKLOG", "TODO")).toBe(true);
    expect(canTransition("BACKLOG", "IN_PROGRESS")).toBe(true);
    expect(canTransition("BACKLOG", "CANCELLED")).toBe(true);
  });

  it("is reachable back from the working statuses", () => {
    expect(canTransition("TODO", "BACKLOG")).toBe(true);
    expect(canTransition("IN_PROGRESS", "BACKLOG")).toBe(true);
  });
});

describe("what the board reads, and what the server stores", () => {
  const created: string[] = [];

  beforeAll(async () => {
    await actAs("admin@symbiosystech.com");
  });

  afterAll(async () => {
    if (created.length > 0) {
      await prisma.issue.deleteMany({ where: { id: { in: created } } });
    }
  });

  async function aBacklogIssue(title: string): Promise<string> {
    const project = await projectByKey("ENG");
    const result = await createIssue({
      projectId: project.id,
      type: "TASK",
      title,
      description: "Created by the integration suite.",
      status: "BACKLOG",
    });
    if (!result.ok) throw new Error("fixture not created");
    created.push(result.data.id);
    return result.data.id;
  }

  it("does not offer Backlog to In QA as a drop target", () => {
    /* What stops a card being dragged from Backlog into In QA is the table,
       which the board reads to decide which columns will accept a drop. The
       server no longer refuses the write -- the issue page deliberately offers
       every status -- so this is asserted where the rule now lives. */
    expect(canTransition("BACKLOG", "IN_QA")).toBe(false);
    expect(allowedTransitions("BACKLOG")).not.toContain("IN_QA");
  });

  it("allows a drag from Backlog into Todo", async () => {
    const issueId = await aBacklogIssue("Backlog fixture: allowed move");

    expect(await updateIssue({ issueId, status: "TODO" })).toMatchObject({
      ok: true,
    });
    const after = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: { status: true },
    });
    expect(after.status).toBe("TODO");
  });

  it("puts an unassigned Backlog issue where the board's own query looks", async () => {
    /* E1 is a server-side claim, so it is tested server-side: the same
       `where` the board page runs has to return the issue. An issue filed
       with no assignee is the case that used to be loaded by nobody — it
       holds Backlog, and Backlog was not a column. */
    const project = await projectByKey("ENG");
    const issueId = await aBacklogIssue("Backlog fixture: unassigned");

    const onBoard = await prisma.issue.findMany({
      where: { projectId: project.id, status: { in: BOARD_STATUSES } },
      select: { id: true, assigneeId: true, status: true },
    });

    const mine = onBoard.find((issue) => issue.id === issueId);
    expect(mine).toBeDefined();
    expect(mine?.assigneeId).toBeNull();
    expect(mine?.status).toBe("BACKLOG");
  });
});
