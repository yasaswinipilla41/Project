import type { IssueStatus } from "@prisma/client";

/**
 * The Flow Board's column statuses. Deliberately not `ISSUE_STATUSES` from
 * `lib/domain` — Backlog is excluded, matching the approved Flow Board design.
 *
 * Lives outside `FlowBoard.tsx` on purpose: that file is `"use client"`, and a
 * Server Component importing any export from a client module gets a client
 * reference back rather than the real value — fine for components, silently
 * wrong for a plain constant like this one (Prisma would receive a function,
 * not an array). Both the board's server page and its client component import
 * this instead.
 */
export const BOARD_STATUSES: IssueStatus[] = [
  "TODO",
  "IN_PROGRESS",
  "IN_REVIEW",
  "DONE",
  "CANCELLED",
];
