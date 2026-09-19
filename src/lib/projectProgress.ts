import type { IssueStatus } from "@prisma/client";
import { CLOSED_STATUSES, isClosedStatus } from "@/lib/domain";
import { percent } from "@/lib/format";

/**
 * How far through a project its work is — one definition, for every surface
 * that draws it.
 *
 * The directory at `/projects` is where this figure has always been right, and
 * it is the shape kept here: **completed is work in a closed status, total is
 * every issue in the project**, and the percentage is `percent` of the two.
 * Home used to count only `DONE`, so the same project read differently in two
 * places; there is one answer now and this module is it.
 *
 * Nothing here queries anything. The counts come from whichever authoritative
 * query the page already runs, and this turns them into the contract every
 * progress bar consumes — which is what keeps the component from working any
 * of it out for itself.
 */

/** What "completed" means for a project's progress, asked once. */
export function countsAsCompleted(status: IssueStatus): boolean {
  return isClosedStatus(status);
}

/**
 * The same rule, in the shape a database query needs.
 *
 * A page that counts with `prisma.issue.count` cannot call the predicate above
 * on each row, and writing the statuses out again beside the query is exactly
 * how two surfaces drift apart. Re-exported from here so both ways of asking
 * lead back to one definition.
 */
export const COMPLETED_STATUSES: readonly IssueStatus[] = CLOSED_STATUSES;

/**
 * The canonical progress of one project.
 *
 * `label` is display text and nothing reads it back; `isEmpty` is the
 * "no issues yet" case, which is a different statement from 0% and the reason
 * a project with nothing in it does not read as having failed to finish
 * anything.
 */
export interface ProjectProgress {
  projectId: string;
  percentage: number;
  completed: number;
  total: number;
  isEmpty: boolean;
  label: string;
}

/**
 * Builds the contract from counts the caller already holds.
 *
 * The wording is the directory's own, so a card on Home and a card on
 * `/projects` say the same thing about the same project.
 */
export function projectProgress(
  projectId: string,
  completed: number,
  total: number,
): ProjectProgress {
  const isEmpty = total <= 0;
  const percentage = isEmpty ? 0 : percent(completed, total);

  return {
    projectId,
    percentage,
    completed,
    total,
    isEmpty,
    label: isEmpty
      ? "No issues yet"
      : `${percentage}% complete · ${completed} of ${total}`,
  };
}
