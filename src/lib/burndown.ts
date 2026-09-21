import type { IssueStatus } from "@prisma/client";
import { isClosedStatus } from "@/lib/domain";

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
  /**
   * The status it is in now.
   *
   * Closed work has nothing left to burn whatever its remainder says, and
   * that is the whole reason this is here: finishing an issue in Prio does
   * not touch its remaining hours, so a burndown read from remainders alone
   * ran flat across a sprint that was being finished.
   *
   * Optional, and absent means "not known to the caller", which is treated as
   * open — the behaviour before statuses were read at all.
   */
  status?: IssueStatus;
}

/**
 * A recorded status change, from the issue's own trail.
 *
 * `from` is what it was before, which is what makes the days before the first
 * recorded change knowable rather than guessed.
 */
export interface StatusChange {
  /** When the change was recorded. */
  at: Date;
  /** The item it belongs to. */
  issueId: string;
  /** The status it left, where the trail says. */
  from: IssueStatus | null;
  /** The status it moved to. */
  to: IssueStatus;
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
  /**
   * Every recorded status change for the sprint's items - the same trail the
   * remainders come from. Without it a closed item reads as closed for the
   * whole sprint, because nothing says when it closed; with it the actual
   * line falls on the day the work was actually finished.
   */
  statusHistory?: StatusChange[];
  now: Date;
}): Burndown {
  const { startDate, endDate, items, history, now } = params;
  const statusHistory = params.statusHistory ?? [];

  const totalEffort = items.reduce(
    (sum, item) => sum + (item.effortHours ?? 0),
    0,
  );
  const unestimated = items.filter((item) => item.effortHours === null).length;

  /*
   * ---------------------------------------------------------------- the rule
   *
   * What one item has left, at a given moment:
   *
   *   1. **Nothing, if it was closed then.** Done, Reject / Not an Issue and
   *      Cancelled are all work the sprint no longer has to do, whatever
   *      anybody last said was remaining on them. Finishing an issue in Prio
   *      does not touch its remaining hours, so a burndown that read only
   *      remainders ran flat across a sprint that was being finished.
   *   2. Otherwise the most recent remainder recorded *since the work last
   *      became open*. A figure recorded while an item was finished says
   *      nothing about it once it has been reopened, so a reopened item does
   *      not keep the nought it was closed on.
   *   3. Otherwise its whole estimate: it is in the sprint, it is open, and
   *      nothing says any of it is done.
   *
   * An item with no estimate and no remainder contributes nothing, because
   * there is nothing to contribute - it is counted in `unestimated` instead.
   */
  const changesFor = new Map<string, StatusChange[]>();
  for (const change of [...statusHistory].sort(
    (a, b) => a.at.getTime() - b.at.getTime(),
  )) {
    const list = changesFor.get(change.issueId);
    if (list) list.push(change);
    else changesFor.set(change.issueId, [change]);
  }

  const readingsFor = new Map<string, RemainingChange[]>();
  for (const reading of [...history].sort(
    (a, b) => a.at.getTime() - b.at.getTime(),
  )) {
    const list = readingsFor.get(reading.issueId);
    if (list) list.push(reading);
    else readingsFor.set(reading.issueId, [reading]);
  }

  /** The status an item was in at `cutoff`, as far as the record says. */
  function statusAt(item: BurndownItem, cutoff: number): IssueStatus | null {
    const changes = changesFor.get(item.issueId) ?? [];
    let latest: IssueStatus | null = null;
    let seen = false;

    for (const change of changes) {
      if (change.at.getTime() >= cutoff) break;
      latest = change.to;
      seen = true;
    }
    if (seen) return latest;

    /* Before the first recorded change the item was whatever that change says
       it left; with no trail at all, the status it is in now is the only thing
       there is to go on. */
    return changes[0]?.from ?? item.status ?? null;
  }

  /**
   * When the item last became open, as of `cutoff` - `-Infinity` when it has
   * been open all along, which is the ordinary case.
   */
  function openedAt(item: BurndownItem, cutoff: number): number {
    let opened = -Infinity;
    for (const change of changesFor.get(item.issueId) ?? []) {
      if (change.at.getTime() >= cutoff) break;
      const wasClosed = change.from !== null && isClosedStatus(change.from);
      if (wasClosed && !isClosedStatus(change.to)) opened = change.at.getTime();
    }
    return opened;
  }

  /** The rule above, for one item at one moment. */
  function remainderAt(
    item: BurndownItem,
    cutoff: number,
    /** Whether the item's own live remainder counts as evidence - it does for
     *  "right now", and never for a past day, which has readings of its own. */
    live: boolean,
  ): number {
    const status = statusAt(item, cutoff);
    if (status !== null && isClosedStatus(status)) return 0;

    const since = openedAt(item, cutoff);
    let reading: number | undefined;
    for (const entry of readingsFor.get(item.issueId) ?? []) {
      const when = entry.at.getTime();
      if (when >= cutoff) break;
      if (when >= since) reading = entry.remainingHours;
    }
    if (reading !== undefined) return reading;

    /* The live column is the same kind of evidence as a reading, and is where
       an edit made before the trail existed lands - but it is unusable once
       the work has been reopened, for the reason step 2 gives. */
    if (live && item.remainingHours !== null && since === -Infinity) {
      return item.remainingHours;
    }

    return item.effortHours ?? 0;
  }

  /* What is left right now, by that rule. */
  const remaining = items.reduce(
    (sum, item) => sum + remainderAt(item, now.getTime() + 1, true),
    0,
  );

  const days = daysBetween(startDate, endDate);
  const lastIdeal = days.length - 1;
  const today = startOfDay(now).getTime();

  const points: BurndownPoint[] = days.map((date, index) => {
    const ideal =
      lastIdeal <= 0
        ? 0
        : totalEffort - (totalEffort * index) / lastIdeal;

    /*
     * A day the sprint has not reached has no actual value — not zero, and
     * not the last known figure carried forward. Drawing either would claim
     * the future.
     */
    if (date.getTime() > today) {
      return { date, ideal, actual: null };
    }

    /* What was outstanding at the end of this day, by the same rule that
       decides what is outstanding now. */
    const actual = items.reduce(
      (sum, item) => sum + remainderAt(item, date.getTime() + DAY, false),
      0,
    );

    return { date, ideal: Math.max(0, ideal), actual };
  });

  return { totalEffort, remaining, unestimated, points };
}
