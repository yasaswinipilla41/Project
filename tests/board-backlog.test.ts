import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BOARD_STATUSES, dropStatusFor } from "@/lib/board";
import {
  allowedTransitions,
  canSetStatus,
  canTransition,
  ISSUE_STATUSES,
} from "@/lib/domain";
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
 *  2. Being a column buys it no privileges and costs it none. A drop is no
 *     longer refused for being out of the ordinary order — work is finished
 *     out of sequence often enough that a board which will not record it is
 *     the thing that is wrong — so what `STATUS_TRANSITIONS` still decides is
 *     narrower: which of a column's statuses a card lands in. Backlog is read
 *     by the same table as every other status, with no special case either
 *     way, and who may set the result is `canSetStatus`, asked here and again
 *     on the server.
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

describe("Backlog, in the ordinary order of things", () => {
  it("does not lead to the QA or finished statuses", () => {
    /* The ordinary path, which is what `dropStatusFor` consults to decide
       what a drop *means*. Nothing here special-cases Backlog — the answer
       comes from the same table every other column uses. It is no longer a
       refusal: see "takes a drop at face value" below. */
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

  it("takes a drop at face value where the ordinary path has nothing to say", () => {
    /*
     * The board used to turn this drop away, because the table has no
     * Backlog → In QA step. It no longer does: somebody who has already
     * built, deployed and checked a change should be able to say so by
     * putting the card where the work actually is, rather than dragging it
     * through three columns to record a history that did not happen.
     *
     * The table is still consulted and still says no step exists — that fact
     * is unchanged, and it is what keeps Done → New meaning Reopened. What
     * changed is what the board does with the answer.
     */
    expect(canTransition("BACKLOG", "IN_QA")).toBe(false);
    expect(allowedTransitions("BACKLOG")).not.toContain("IN_QA");

    expect(dropStatusFor("BACKLOG", "IN_QA")).toBe("IN_QA");

    /*
     * And where the ordinary path *does* have something to say, it is still
     * what decides — which is the whole reason the table was kept rather
     * than deleted. Two cases, and they are the ones that would read wrong
     * if a drop were simply taken at face value everywhere:
     *
     *   Backlog → the Done column   that column also holds Rejected, and
     *                               unstarted work has nothing to have
     *                               finished; dragging it to the end of the
     *                               board means it was not work.
     *   Done → the New column       finished work dragged back is reopened,
     *                               not new.
     */
    expect(dropStatusFor("BACKLOG", "DONE")).toBe("REJECTED");
    expect(dropStatusFor("DONE", "TODO")).toBe("REOPENED");
  });

  it("still refuses a drop the person may not make", () => {
    /*
     * Order stopped being a refusal; authorization did not. A developer's
     * half of the job does not include declaring work tested, so the board
     * refuses that drop and `updateIssue` refuses the write behind it —
     * which is the distinction the requirement draws between removing a
     * transition matrix and removing authorization.
     */
    expect(canSetStatus("DEVELOPER", "BACKLOG", "IN_QA")).toBe(false);
    expect(canSetStatus("QA", "BACKLOG", "IN_QA")).toBe(true);
    expect(canSetStatus("ADMIN", "BACKLOG", "DONE")).toBe(true);
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
