import type { IssueStatus } from "@prisma/client";

/**
 * The Flow Board's column statuses, in board order.
 *
 * Backlog leads the board rather than being left off it. Work that has been
 * filed but not yet planned -- which is most of what arrives unassigned --
 * only ever holds this status, so excluding the column did not tidy the board
 * so much as hide a queue: those issues existed, were reachable from the issue
 * list, and were invisible on the surface a project is actually run from.
 *
 * The column is a column and nothing more. It carries no rule of its own: what
 * may leave it, and where for, comes from `STATUS_TRANSITIONS` in `lib/domain`
 * exactly as it does for every other column, which is what stops Backlog being
 * quietly treated as a review or QA queue. That table allows Backlog to reach
 * Todo, In Progress and Cancelled -- and nothing else, so a card cannot be
 * dragged from Backlog straight into In QA or Done.
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
  "REOPENED",
  "REJECTED",
  "CANCELLED",
];
