import type { IssueStatus } from "@prisma/client";
import { canTransition, ISSUE_STATUSES } from "@/lib/domain";

/**
 * The Flow Board's columns, in board order.
 *
 * Backlog leads the board rather than being left off it. Work that has been
 * filed but not yet planned -- which is most of what arrives unassigned --
 * only ever holds this status, so excluding the column did not tidy the board
 * so much as hide a queue.
 *
 * Reopened and Rejected are deliberately absent. They are statuses an issue
 * can hold, and they appear in every status menu, but they are not places on
 * the board: reopened work belongs with the rest of the work waiting to be
 * picked up, and a rejected issue is finished with. `COLUMN_ALSO_HOLDS` below
 * is what puts them in New and Done respectively -- a status is not a column,
 * and adding one of these to this list would make it one.
 *
 * The column is a column and nothing more. What may leave it, and where for,
 * comes from `STATUS_TRANSITIONS` in `lib/domain` exactly as it does for every
 * other column, which is what stops Backlog being quietly treated as a review
 * or QA queue.
 *
 * Lives outside `FlowBoard.tsx` on purpose: that file is `"use client"`, and a
 * Server Component importing any export from a client module gets a client
 * reference back rather than the real value -- fine for components, silently
 * wrong for a plain constant like this one (Prisma would receive a function,
 * not an array). Both the board's server page and its client component import
 * this instead.
 */
export const BOARD_STATUSES: IssueStatus[] = [
  "BACKLOG",
  "TODO",
  "IN_PROGRESS",
  "IN_REVIEW",
  "IN_QA",
  "DONE",
  "CANCELLED",
];

/**
 * The statuses a column holds besides the one it is named for.
 *
 * This is the single table behind everything a shared column has to do:
 * grouping a card into it, deciding what a drop onto it means, and listing what
 * the column can hold. Two columns carry a second status:
 *
 *   New  also holds Reopen                  work that has come back is work to
 *                                           be picked up again
 *   Done also holds Reject / Not an Issue   it is closed; why is on the issue,
 *                                           not on the board
 *
 * Order matters: a drop prefers the column's own status and falls back to what
 * follows, so nothing about the existing columns changes for the statuses that
 * were already theirs.
 */
export const COLUMN_ALSO_HOLDS: Partial<Record<IssueStatus, readonly IssueStatus[]>> = {
  TODO: ["REOPENED"],
  DONE: ["REJECTED"],
};

/** Every status drawn in this column, its own first. */
export function statusesInColumn(column: IssueStatus): IssueStatus[] {
  return [column, ...(COLUMN_ALSO_HOLDS[column] ?? [])];
}

/**
 * Which column an issue of this status is drawn in.
 *
 * Every status the project has maps onto one of the columns above, so nothing
 * an issue can be is invisible on the board. Derived from `COLUMN_ALSO_HOLDS`
 * rather than restating it, so a status cannot be grouped into one column and
 * dropped into another.
 *
 * One function, used by the page that queries and by the board that groups, so
 * the two cannot disagree about where an issue belongs.
 */
export function boardColumnFor(status: IssueStatus): IssueStatus {
  for (const [column, also] of Object.entries(COLUMN_ALSO_HOLDS)) {
    if (also?.includes(status)) return column as IssueStatus;
  }
  return status;
}

/**
 * What dropping an issue onto a column means. Every drop means something.
 *
 * A column named for a status can still hold another, so "where does this card
 * go" is not always the column's own name. The rule is: **the column's own
 * status when the workflow allows it, and only otherwise the status it also
 * holds.** That ordering is what keeps every drop that already worked working
 * exactly as it did -- Backlog to New is still New, Ready for QA to Done is
 * still Done -- while giving the drops that were simply refused a meaning:
 *
 *   Done -> New     Done cannot become New, but it can be Reopened, and Reopen
 *                   is drawn in New. Dragging finished work back onto the board
 *                   is how it is reopened.
 *   Todo -> Done    unstarted work cannot be Done -- nothing was reviewed --
 *                   but it can be Rejected, which is what dragging it to the
 *                   end of the board actually means: it was not work.
 *
 * **A drop is never refused.** `STATUS_TRANSITIONS` still decides which of a
 * column's statuses is the apt one — that is what keeps Done → New meaning
 * Reopened rather than New — but where it has nothing to say, the card lands
 * in the column's own status instead of being turned away. Work is finished
 * out of order often enough that a board refusing to record it is the thing
 * that is wrong: somebody who has already built, deployed and checked a change
 * should be able to drag it to Ready for QA, and a cancelled requirement
 * should be able to go straight to Cancelled from wherever it is.
 *
 * Who may do it is a separate question, asked separately: the board checks
 * `canSetStatus` against the reader's work role, and `updateIssue` checks it
 * again on the server. This function answers only *what a drop means*.
 */
export function dropStatusFor(
  from: IssueStatus,
  column: IssueStatus,
): IssueStatus {
  for (const candidate of statusesInColumn(column)) {
    if (canTransition(from, candidate)) return candidate;
  }
  /* Nothing in the ordinary path connects these two, so the drop is taken at
     face value: the column the card was let go over. */
  return column;
}

/**
 * Every status the board displays -- which is every status, since each one
 * maps onto a column. This is what the board's query asks for; narrowing it to
 * `BOARD_STATUSES` would leave reopened and rejected issues out of the columns
 * they belong to.
 */
export const BOARD_VISIBLE_STATUSES: IssueStatus[] = ISSUE_STATUSES.filter(
  (status) => BOARD_STATUSES.includes(boardColumnFor(status)),
);
