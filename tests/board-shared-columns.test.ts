import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IssueStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createIssue, updateIssue } from "@/server/issues";
import { actAs, projectByKey } from "./helpers";
import {
  BOARD_STATUSES,
  BOARD_VISIBLE_STATUSES,
  COLUMN_ALSO_HOLDS,
  boardColumnFor,
  dropStatusFor,
  statusesInColumn,
} from "@/lib/board";
import {
  canTransition,
  ISSUE_STATUSES,
  STATUS_LABEL,
} from "@/lib/domain";

/**
 * Two columns hold more than one status.
 *
 * Reopen and Reject / Not an Issue are statuses, not places: Reopen is drawn
 * in **New** and Reject in **Done**. The property worth defending is that this
 * stays one fact rather than two — where a card is grouped, and what dropping
 * one there means, both read from `COLUMN_ALSO_HOLDS`, so the board cannot
 * draw an issue in one column and move it into another.
 *
 * The other property, and the one most at risk from a change like this, is
 * that nothing which already worked changed. Every drop the board accepted
 * before must still resolve to exactly the status it resolved to before; the
 * new statuses may only fill in drops that were previously refused outright.
 */

describe("the columns themselves", () => {
  it("gained no new columns", () => {
    expect(BOARD_STATUSES).toEqual([
      "BACKLOG",
      "TODO",
      "IN_PROGRESS",
      "IN_REVIEW",
      "IN_QA",
      "DONE",
      "CANCELLED",
    ]);
  });

  it("has no Reopen or Reject column", () => {
    expect(BOARD_STATUSES).not.toContain("REOPENED");
    expect(BOARD_STATUSES).not.toContain("REJECTED");
  });

  it("still shows every status somewhere", () => {
    for (const status of ISSUE_STATUSES) {
      expect(BOARD_STATUSES).toContain(boardColumnFor(status));
      expect(BOARD_VISIBLE_STATUSES).toContain(status);
    }
  });
});

describe("which column a status is drawn in", () => {
  it("puts Reopen in New and Reject in Done", () => {
    expect(boardColumnFor("REOPENED")).toBe("TODO");
    expect(STATUS_LABEL.TODO).toBe("New");

    expect(boardColumnFor("REJECTED")).toBe("DONE");
    expect(STATUS_LABEL.REJECTED).toBe("Reject / Not an Issue");
    expect(STATUS_LABEL.REOPENED).toBe("Reopen");
  });

  it("leaves every other status in the column it names", () => {
    for (const status of ISSUE_STATUSES) {
      if (status === "REOPENED" || status === "REJECTED") continue;
      expect(boardColumnFor(status)).toBe(status);
    }
  });

  it("derives grouping from the same table the drops read", () => {
    for (const [column, also] of Object.entries(COLUMN_ALSO_HOLDS)) {
      for (const status of also ?? []) {
        expect(boardColumnFor(status)).toBe(column);
        expect(statusesInColumn(column as IssueStatus)).toContain(status);
      }
    }
    // A column always leads with its own status.
    for (const column of BOARD_STATUSES) {
      expect(statusesInColumn(column)[0]).toBe(column);
    }
  });
});

describe("what dropping a card on a column means", () => {
  it("prefers the column's own status wherever the workflow allows it", () => {
    for (const from of ISSUE_STATUSES) {
      for (const column of BOARD_STATUSES) {
        if (!canTransition(from, column)) continue;
        expect(
          dropStatusFor(from, column),
          `${from} -> ${column} must still mean ${column}`,
        ).toBe(column);
      }
    }
  });

  it("changes nothing about the drops that already worked", () => {
    /* The rule the board used before was exactly `canTransition(from,
       column)`. Every pair it accepted must resolve to the same status now —
       this is the regression guard for "existing drag and drop is not
       broken". */
    for (const from of ISSUE_STATUSES) {
      for (const column of BOARD_STATUSES) {
        if (canTransition(from, column)) {
          expect(dropStatusFor(from, column)).toBe(column);
        }
      }
    }
  });

  it("reopens finished work dragged back into New", () => {
    // Done cannot become New...
    expect(canTransition("DONE", "TODO")).toBe(false);
    // ...so the New column takes it as Reopen, which is drawn in New.
    expect(dropStatusFor("DONE", "TODO")).toBe("REOPENED");
    expect(boardColumnFor("REOPENED")).toBe("TODO");
  });

  it("rejects unreviewed work dragged to Done", () => {
    for (const from of ["BACKLOG", "TODO", "IN_PROGRESS"] as const) {
      // Nothing reaches Done without review — that rule is untouched.
      expect(canTransition(from, "DONE")).toBe(false);
      // The Done column takes it as Reject / Not an Issue instead.
      expect(dropStatusFor(from, "DONE")).toBe("REJECTED");
    }
    expect(boardColumnFor("REJECTED")).toBe("DONE");
  });

  it("keeps Done meaning Done for work that has been reviewed", () => {
    expect(dropStatusFor("IN_REVIEW", "DONE")).toBe("DONE");
    expect(dropStatusFor("IN_QA", "DONE")).toBe("DONE");
  });

  it("keeps New meaning New for work that may simply go there", () => {
    expect(dropStatusFor("BACKLOG", "TODO")).toBe("TODO");
    expect(dropStatusFor("IN_PROGRESS", "TODO")).toBe("TODO");
  });

  it("refuses a drop the workflow has no answer for", () => {
    // Backlog is not a review queue, and neither status Done's column holds
    // is reachable from Ready for QA's own column going backwards.
    expect(dropStatusFor("IN_QA", "BACKLOG")).toBeNull();
    expect(dropStatusFor("BACKLOG", "IN_REVIEW")).toBeNull();
  });

  it("only ever chooses a status the workflow already permits", () => {
    for (const from of ISSUE_STATUSES) {
      for (const column of BOARD_STATUSES) {
        const to = dropStatusFor(from, column);
        if (to === null) continue;
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(true);
        // And whatever it chose is drawn in the column it was dropped on.
        expect(boardColumnFor(to)).toBe(column);
      }
    }
  });
});

/* ------------------------------------------------------------ persistence */

describe("setting these statuses through the ordinary write path", () => {
  const created: string[] = [];

  beforeAll(async () => {
    await actAs("admin@symbiosystech.com");
  });

  afterAll(async () => {
    if (created.length > 0) {
      await prisma.issue.deleteMany({ where: { id: { in: created } } });
    }
    await prisma.$disconnect();
  });

  async function anIssue(status: IssueStatus, title: string): Promise<string> {
    const project = await projectByKey("ENG");
    const result = await createIssue({
      projectId: project.id,
      type: "TASK",
      title,
      description: "Created by the integration suite.",
      status,
    });
    if (!result.ok) throw new Error(`fixture failed: ${result.error}`);
    created.push(result.data.id);
    return result.data.id;
  }

  /** The board page's own query, and the column it would draw the issue in. */
  async function columnOnBoard(issueId: string): Promise<IssueStatus | null> {
    const project = await projectByKey("ENG");
    const rows = await prisma.issue.findMany({
      where: { projectId: project.id, status: { in: BOARD_VISIBLE_STATUSES } },
      select: { id: true, status: true },
    });
    const row = rows.find((r) => r.id === issueId);
    return row ? boardColumnFor(row.status) : null;
  }

  it("persists Reopen, and the board draws it in New", async () => {
    const issueId = await anIssue("DONE", "Shared column fixture: reopen");

    const result = await updateIssue({ issueId, status: "REOPENED" });
    expect(result.ok).toBe(true);

    /* Re-read, which is what a refresh does. Nothing about this is client
       state: the status is a column in the database and the column it is
       drawn in is derived from it on every read. */
    const after = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: { status: true },
    });
    expect(after.status).toBe("REOPENED");
    expect(STATUS_LABEL[after.status]).toBe("Reopen");
    expect(await columnOnBoard(issueId)).toBe("TODO");
  });

  it("persists Reject / Not an Issue, and the board draws it in Done", async () => {
    const issueId = await anIssue("TODO", "Shared column fixture: reject");

    const result = await updateIssue({ issueId, status: "REJECTED" });
    expect(result.ok).toBe(true);

    const after = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: { status: true },
    });
    expect(after.status).toBe("REJECTED");
    expect(STATUS_LABEL[after.status]).toBe("Reject / Not an Issue");
    expect(await columnOnBoard(issueId)).toBe("DONE");
  });

  it("writes what a drop onto New resolves to, for each card's own status", async () => {
    /* The drop resolver and the write path, together: a finished issue
       dragged onto New is reopened, and an in-progress one simply moves. */
    const finished = await anIssue("DONE", "Shared column fixture: drop done->new");
    const working = await anIssue(
      "IN_PROGRESS",
      "Shared column fixture: drop wip->new",
    );

    for (const issueId of [finished, working]) {
      const before = await prisma.issue.findUniqueOrThrow({
        where: { id: issueId },
        select: { status: true },
      });
      const to = dropStatusFor(before.status, "TODO");
      expect(to).not.toBeNull();
      expect((await updateIssue({ issueId, status: to! })).ok).toBe(true);
    }

    expect(
      (
        await prisma.issue.findUniqueOrThrow({
          where: { id: finished },
          select: { status: true },
        })
      ).status,
    ).toBe("REOPENED");
    expect(
      (
        await prisma.issue.findUniqueOrThrow({
          where: { id: working },
          select: { status: true },
        })
      ).status,
    ).toBe("TODO");

    // Both are drawn in New, which is the point of the column holding two.
    expect(await columnOnBoard(finished)).toBe("TODO");
    expect(await columnOnBoard(working)).toBe("TODO");
  });

  it("writes what a drop onto Done resolves to, for each card's own status", async () => {
    const reviewed = await anIssue(
      "IN_REVIEW",
      "Shared column fixture: drop review->done",
    );
    const unstarted = await anIssue(
      "TODO",
      "Shared column fixture: drop new->done",
    );

    for (const issueId of [reviewed, unstarted]) {
      const before = await prisma.issue.findUniqueOrThrow({
        where: { id: issueId },
        select: { status: true },
      });
      const to = dropStatusFor(before.status, "DONE");
      expect(to).not.toBeNull();
      expect((await updateIssue({ issueId, status: to! })).ok).toBe(true);
    }

    expect(
      (
        await prisma.issue.findUniqueOrThrow({
          where: { id: reviewed },
          select: { status: true },
        })
      ).status,
    ).toBe("DONE");
    expect(
      (
        await prisma.issue.findUniqueOrThrow({
          where: { id: unstarted },
          select: { status: true },
        })
      ).status,
    ).toBe("REJECTED");

    expect(await columnOnBoard(reviewed)).toBe("DONE");
    expect(await columnOnBoard(unstarted)).toBe("DONE");
  });
});
