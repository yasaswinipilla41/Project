/**
 * A sprint's burndown: what was committed, and what is left.
 *
 * Deliberately a pure function over plain data — no database, no clock of its
 * own, no chart library. Two reasons, and both matter:
 *
 *  - **It can be checked.** A burndown is an argument about whether a team is
 *    going to finish, and an argument nobody can examine is decoration. Given
 *    the same sprint and the same recorded history this returns the same two
 *    lines every time, and a test can state exactly where they run.
 *  - **Nothing is invented.** The ideal line is arithmetic: total effort down
 *    to zero across the sprint's own dates. The actual line is read from what
 *    was recorded, and stops at the last day there is a reading for. Where
 *    there is no history there is no line, rather than a plausible-looking one.
 */

/** One work item's contribution, as the sprint currently holds it. */
export interface BurndownItem {
  /** Which item this is, so its recorded history can be matched to it. */
  issueId: string;
  /** What it was estimated to need. Null when nobody estimated it. */
  effortHours: number | null;
  /** What is thought to be left. Null when nobody has said. */
  remainingHours: number | null;
}

/** A recorded change to one item's remaining hours. */
export interface RemainingChange {
  /** When the change was recorded. */
  at: Date;
  /** The item it belongs to, so the latest reading per item can be found. */
  issueId: string;
  /** Hours remaining after the change. */
  remainingHours: number;
}

export interface BurndownPoint {
  /** Midnight at the start of this day, in the server's own calendar. */
  date: Date;
  /** Where a sprint that burned evenly would be. */
  ideal: number;
  /**
   * Where it actually was at the end of this day, or null for a day the
   * sprint has not reached yet. Null is drawn as a gap, never as zero.
   */
  actual: number | null;
}

export interface Burndown {
  /** The sum of every estimate committed to the sprint. */
  totalEffort: number;
  /** What is left across the sprint right now. */
  remaining: number;
  /** How many of the sprint's items carry no estimate at all. */
  unestimated: number;
  points: BurndownPoint[];
}

/** Midnight at the start of the day a date falls in. */
function startOfDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

const DAY = 24 * 60 * 60 * 1000;

/** Every day from start to end inclusive, as midnights. */
function daysBetween(start: Date, end: Date): Date[] {
  const days: Date[] = [];
  const last = startOfDay(end).getTime();
  for (
    let day = startOfDay(start);
    day.getTime() <= last;
    day = new Date(day.getTime() + DAY)
  ) {
    days.push(day);
    /* A sprint is a fortnight or two; this guard is only here so a corrupt
       pair of dates cannot spin forever. */
    if (days.length > 400) break;
  }
  return days;
}

/**
 * The two lines, for one sprint.
 *
 * `history` is every recorded change to any of the sprint's items' remaining
 * hours — the trail, not a second table. `now` is passed in rather than read,
 * so a test can stand anywhere in the sprint and the answer does not depend on
 * when it was run.
 */
export function burndown(params: {
  startDate: Date;
  endDate: Date;
  items: BurndownItem[];
  history: RemainingChange[];
  now: Date;
}): Burndown {
  const { startDate, endDate, items, history, now } = params;

  const totalEffort = items.reduce(
    (sum, item) => sum + (item.effortHours ?? 0),
    0,
  );
  const unestimated = items.filter((item) => item.effortHours === null).length;

  /*
   * What is left right now.
   *
   * An item nobody has given a remainder to counts as all of its estimate
   * still outstanding: it was committed to the sprint and nothing says any of
   * it is done. An item with neither number contributes nothing, because
   * there is nothing to contribute.
   */
  const remaining = items.reduce(
    (sum, item) => sum + (item.remainingHours ?? item.effortHours ?? 0),
    0,
  );

  const days = daysBetween(startDate, endDate);
  const lastIdeal = days.length - 1;
  const today = startOfDay(now).getTime();

  /* The latest reading per item at the end of each day, walked forward once
     rather than re-scanned per day. */
  const ordered = [...history].sort((a, b) => a.at.getTime() - b.at.getTime());
  const latest = new Map<string, number>();
  let cursor = 0;

  const points: BurndownPoint[] = days.map((date, index) => {
    const ideal =
      lastIdeal <= 0
        ? 0
        : totalEffort - (totalEffort * index) / lastIdeal;

    const endOfDay = date.getTime() + DAY;
    while (cursor < ordered.length && ordered[cursor]!.at.getTime() < endOfDay) {
      const change = ordered[cursor]!;
      latest.set(change.issueId, change.remainingHours);
      cursor += 1;
    }

    /*
     * A day the sprint has not reached has no actual value — not zero, and
     * not the last known figure carried forward. Drawing either would claim
     * the future.
     */
    if (date.getTime() > today) {
      return { date, ideal, actual: null };
    }

    /*
     * What was outstanding at the end of this day: the latest reading for
     * every item that has one, plus the full estimate of every item that does
     * not, because nothing has yet said any of it is done.
     */
    const actual = items.reduce((sum, item) => {
      const reading = latest.get(item.issueId);
      if (reading !== undefined) return sum + reading;
      return sum + (item.effortHours ?? 0);
    }, 0);

    return { date, ideal: Math.max(0, ideal), actual };
  });

  return { totalEffort, remaining, unestimated, points };
}
