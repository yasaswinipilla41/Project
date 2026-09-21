import type { SprintStatus } from "@prisma/client";

/**
 * Whether "Move to · Next sprint" has anywhere to go.
 *
 * The rule belongs to `moveIssueToSprint` in `server/sprints`, which answers
 * it with a query: the soonest sprint in this project that is still open,
 * that is not the one the issue is in, and that does not start before it.
 * When there is none it refuses — "No future Sprint is available."
 *
 * That refusal is correct and stays. What was missing was the same answer
 * before the item is drawn: the menu offered Next sprint on every card, so on
 * a project running its only sprint — which is most projects, most of the
 * time — the entry was there, looked available, and failed every time it was
 * used. Restore beside it is already offered only when there is somewhere to
 * restore to; this is the same courtesy for its neighbour.
 *
 * Two expressions of one rule is a real risk, and it is handled the two ways
 * available: the conditions below are written in the same order and the same
 * words as the query they mirror, and `tests/sprint-move-availability.test.ts`
 * checks this predicate against what `moveIssueToSprint` actually answers over
 * the cases that tell them apart — including two sprints that start on the
 * same day, which is why the comparison is `>=` and not `>`.
 *
 * This is a courtesy, not a gate. The server re-derives all of it on every
 * call and refuses regardless of what any menu decided to show.
 */

/** Sprints that can still receive work. A completed sprint is a closed record. */
const OPEN: readonly SprintStatus[] = ["PLANNED", "ACTIVE"];

export interface MovableSprint {
  id: string;
  status: SprintStatus;
  startDate: Date;
}

/**
 * The sprint `NEXT_SPRINT` would choose, or null when there is none.
 *
 * `from` is the sprint the issue is in now; pass null for an issue in the
 * backlog, which reaches for the soonest open sprint in the project rather
 * than for one on or after any particular date.
 */
export function nextOpenSprint<T extends MovableSprint>(
  sprints: readonly T[],
  from: MovableSprint | null,
): T | null {
  return (
    sprints
      .filter((sprint) => OPEN.includes(sprint.status))
      .filter((sprint) => from === null || sprint.id !== from.id)
      /* `>=`, not `>`: two sprints planned across the same fortnight are an
         ordinary way to split work, and an issue in the first of them can
         still be moved to the second. */
      .filter(
        (sprint) =>
          from === null ||
          sprint.startDate.getTime() >= from.startDate.getTime(),
      )
      .sort((a, b) => a.startDate.getTime() - b.startDate.getTime())[0] ?? null
  );
}

/** Whether the menu should offer the move at all. */
export function canMoveToNextSprint(
  sprints: readonly MovableSprint[],
  from: MovableSprint | null,
): boolean {
  return nextOpenSprint(sprints, from) !== null;
}
