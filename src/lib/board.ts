import type { IssueStatus } from "@prisma/client";
import { ISSUE_STATUSES } from "@/lib/domain";

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
 * picked up, and a rejected issue is finished with. `boardColumnFor` below is
 * what puts them there.
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
 * Which column an issue of this status is drawn in.
 *
 * Every status the project has maps onto one of the columns above, so nothing
 * an issue can be is invisible on the board. Two of them are not columns of
 * their own:
 *
 *   Reopened -> New   work that has come back is work to be picked up again
 *   Rejected -> Done  it is closed; the reason is on the issue, not the board
 *
 * One function, used by the page that queries and by the board that groups, so
 * the two cannot disagree about where an issue belongs.
 */
export function boardColumnFor(status: IssueStatus): IssueStatus {
  if (status === "REOPENED") return "TODO";
  if (status === "REJECTED") return "DONE";
  return status;
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
