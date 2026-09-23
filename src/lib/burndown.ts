import type { IssueStatus } from "@prisma/client";
import { isClosedStatus } from "@/lib/domain";

/**
 * A sprint's burndown: what was committed, what is left, and why it moved.
 *
 * Deliberately a pure function over plain data — no database, no clock of its
 * own, no chart library. Two reasons, and both matter:
 *
 *  - **It can be checked.** A burndown is an argument about whether a team is
 *    going to finish, and an argument nobody can examine is decoration. Given
 *    the same sprint and the same recorded history this returns the same lines
 *    every time, and a test can state exactly where they run.
 *  - **Nothing is invented.** The ideal line is arithmetic: total effort down
 *    to zero across the sprint's own dates. The actual line is read from what
 *    was recorded, and stops at the last day there is a reading for. Where
 *    there is no history there is no line, rather than a plausible-looking one.
 *
 * Each day also carries what made it up — the open issues and what each still
 * owes — and what changed that day, with the reason: an issue finished,
 * reopened, added, taken out, re-estimated, or a remainder written down. Every
 * one of those figures is derived from the same per-item rule as the line, so
 * a day's detail and the point it belongs to cannot disagree.
 */

/** One work item's contribution, as the sprint currently holds it. */
export interface BurndownItem {
  /** Which item this is, so its recorded history can be matched to it. */
  issueId: string;
  /** Its key, for naming it in a day's detail. Falls back to the id. */
  key?: string;
  /** Its title, for the same reason. */
  title?: string;
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
  /**
   * Whether the item is in the sprint *now*. Defaults to true.
   *
   * False for one that has been moved out: it still belongs in the history,
   * because the sprint carried its weight up to the day it left.
   */
  member?: boolean;
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

/** A recorded change to one item's estimate. */
export interface EstimateChange {
  at: Date;
  issueId: string;
  /** The estimate before, where the trail says; null when there was none. */
  from: number | null;
  /** The estimate after; null when it was cleared. */
  to: number | null;
}

/** An item joining or leaving the sprint. */
export interface MembershipChange {
  at: Date;
  issueId: string;
  /** True when it came in, false when it went out. */
  joined: boolean;
}

/** One issue still owing work, as a day's detail lists it. */
export interface BurndownIssue {
  issueId: string;
  key: string;
  title: string;
  /** The status it was in that day, where the record says. */
  status: IssueStatus | null;
  /** What it still owed that day. */
  effortHours: number;
}

/** Why a day's remaining effort moved. */
export type BurndownReason =
  | "completed"
  | "reopened"
  | "added"
  | "removed"
  | "estimate"
  | "remainder";

export interface BurndownChange {
  at: Date;
  issueId: string;
  key: string;
  title: string;
  reason: BurndownReason;
  /** The hours this moved the remaining effort by: negative burns down. */
  delta: number;
  /** For an estimate or a remainder: what it was, and what it became. */
  from?: number | null;
  to?: number | null;
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
  /** The open issues that made up `actual`, and what each still owed. */
  remainingIssues: BurndownIssue[];
  /** How many of the sprint's issues were still open at the end of the day. */
  remainingCount: number;
  /** How many were finished with. */
  completedCount: number;
  /** The estimate the sprint held that day — what `completedEffort` and
   *  `actual` add up to. */
  committedEffort: number;
  /** Effort finished by the end of the day: committed, less what was left. */
  completedEffort: number;
  /** What changed that day, and why. Empty on a quiet day. */
  changes: BurndownChange[];
}

export interface Burndown {
  /** The sum of every estimate committed to the sprint. */
  totalEffort: number;
  /** What is left across the sprint right now. */
  remaining: number;
  /** What has been finished: the commitment, less what is left. */
  completedEffort: number;
  /** How many of the sprint's items carry no estimate at all. */
  unestimated: number;
  /** How many issues the sprint holds now. */
  totalIssues: number;
  /** How many of them are finished with. */
  completedIssues: number;
  /** How many are still open. */
  remainingIssues: number;
  /** Where today falls in `points`, or null when the sprint does not cover
   *  today. */
  todayIndex: number | null;
  /** Whether the sprint is the one being worked, which is what makes a marker
   *  for today worth drawing. */
  active: boolean;
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

function byTime<T extends { at: Date; issueId: string }>(
  events: T[],
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const event of [...events].sort(
    (a, b) => a.at.getTime() - b.at.getTime(),
  )) {
    const list = grouped.get(event.issueId);
    if (list) list.push(event);
    else grouped.set(event.issueId, [event]);
  }
  return grouped;
}

/**
 * The two lines, and what each day is made of, for one sprint.
 *
 * Every `history` argument is the issues' own trail — not a second table.
 * `now` is passed in rather than read, so a test can stand anywhere in the
 * sprint and the answer does not depend on when it was run.
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
  /** Recorded estimate changes, so a day's commitment is the estimate the
   *  sprint actually held then rather than the one it holds now. */
  estimateHistory?: EstimateChange[];
  /** Issues joining and leaving the sprint, so a day counts the work the
   *  sprint was carrying on that day. */
  membershipHistory?: MembershipChange[];
  /** Whether this sprint is the one being worked. */
  active?: boolean;
  now: Date;
}): Burndown {
  const { startDate, endDate, items, history, now } = params;
  const statusHistory = params.statusHistory ?? [];
  const estimateHistory = params.estimateHistory ?? [];
  const membershipHistory = params.membershipHistory ?? [];

  const statusFor = byTime(statusHistory);
  const readingsFor = byTime(history);
  const estimatesFor = byTime(estimateHistory);
  const membershipFor = byTime(membershipHistory);

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
   *   3. Otherwise its whole estimate, as the estimate stood then.
   *
   * An item with no estimate and no remainder contributes nothing, because
   * there is nothing to contribute - it is counted in `unestimated` instead.
   * And an item the sprint was not holding that day contributes nothing to
   * that day, whatever state it was in.
   */

  /** The status an item was in at `cutoff`, as far as the record says. */
  function statusAt(item: BurndownItem, cutoff: number): IssueStatus | null {
    const changes = statusFor.get(item.issueId) ?? [];
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

  /** The estimate an item carried at `cutoff`. */
  function estimateAt(item: BurndownItem, cutoff: number): number {
    const changes = estimatesFor.get(item.issueId) ?? [];
    let latest: number | null | undefined;

    for (const change of changes) {
      if (change.at.getTime() >= cutoff) break;
      latest = change.to;
    }
    if (latest !== undefined) return latest ?? 0;

    /* Before the first recorded change it carried whatever that change says
       it left; with no trail, the estimate it carries now. */
    if (changes.length > 0) return changes[0]!.from ?? 0;
    return item.effortHours ?? 0;
  }

  /** Whether the sprint was holding the item at `cutoff`. */
  function memberAt(item: BurndownItem, cutoff: number): boolean {
    const changes = membershipFor.get(item.issueId) ?? [];
    let latest: boolean | undefined;

    for (const change of changes) {
      if (change.at.getTime() >= cutoff) break;
      latest = change.joined;
    }
    if (latest !== undefined) return latest;

    /* Before the first recorded move it was the opposite of what that move
       made it; with no trail, whatever it is now. */
    if (changes.length > 0) return !changes[0]!.joined;
    return item.member ?? true;
  }

  /**
   * When the item last became open, as of `cutoff` - `-Infinity` when it has
   * been open all along, which is the ordinary case.
   */
  function openedAt(item: BurndownItem, cutoff: number): number {
    let opened = -Infinity;
    for (const change of statusFor.get(item.issueId) ?? []) {
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

    return estimateAt(item, cutoff);
  }

  /** What the item owed the sprint at `cutoff`: nothing, if it was not in it. */
  function owedAt(item: BurndownItem, cutoff: number, live: boolean): number {
    if (!memberAt(item, cutoff)) return 0;
    return remainderAt(item, cutoff, live);
  }

  const nameOf = (item: BurndownItem) => ({
    key: item.key ?? item.issueId,
    title: item.title ?? "",
  });

  /* ------------------------------------------------------------- right now */

  const nowCutoff = now.getTime() + 1;
  const held = items.filter((item) => memberAt(item, nowCutoff));

  const totalEffort = held.reduce(
    (sum, item) => sum + estimateAt(item, nowCutoff),
    0,
  );
  const unestimated = held.filter(
    (item) => estimateAt(item, nowCutoff) === 0 && item.effortHours === null,
  ).length;
  const remaining = held.reduce(
    (sum, item) => sum + owedAt(item, nowCutoff, true),
    0,
  );
  const completedIssues = held.filter((item) => {
    const status = statusAt(item, nowCutoff);
    return status !== null && isClosedStatus(status);
  }).length;

  /* ------------------------------------------------------------- the days */

  const days = daysBetween(startDate, endDate);
  const lastIdeal = days.length - 1;
  const today = startOfDay(now).getTime();

  /** Every recorded event, as one list, so a day's changes are one pass. */
  const events: { at: Date; item: BurndownItem; reason: BurndownReason; from?: number | null; to?: number | null }[] =
    [];
  for (const item of items) {
    for (const change of statusFor.get(item.issueId) ?? []) {
      const closing = isClosedStatus(change.to);
      const wasClosed = change.from !== null && isClosedStatus(change.from);
      if (closing && !wasClosed) {
        events.push({ at: change.at, item, reason: "completed" });
      } else if (!closing && wasClosed) {
        events.push({ at: change.at, item, reason: "reopened" });
      }
    }
    for (const change of membershipFor.get(item.issueId) ?? []) {
      events.push({
        at: change.at,
        item,
        reason: change.joined ? "added" : "removed",
      });
    }
    for (const change of estimatesFor.get(item.issueId) ?? []) {
      events.push({
        at: change.at,
        item,
        reason: "estimate",
        from: change.from,
        to: change.to,
      });
    }
    for (const change of readingsFor.get(item.issueId) ?? []) {
      events.push({
        at: change.at,
        item,
        reason: "remainder",
        to: change.remainingHours,
      });
    }
  }
  events.sort((a, b) => a.at.getTime() - b.at.getTime());

  const points: BurndownPoint[] = days.map((date, index) => {
    const ideal =
      lastIdeal <= 0 ? 0 : totalEffort - (totalEffort * index) / lastIdeal;

    /*
     * A day the sprint has not reached has no actual value — not zero, and
     * not the last known figure carried forward. Drawing either would claim
     * the future.
     */
    if (date.getTime() > today) {
      return {
        date,
        ideal,
        actual: null,
        remainingIssues: [],
        remainingCount: 0,
        completedCount: 0,
        committedEffort: 0,
        completedEffort: 0,
        changes: [],
      };
    }

    /* What the sprint was holding at the end of this day, by the same rule
       that decides what it is holding now. */
    const endOfDay = date.getTime() + DAY;
    const holding = items.filter((item) => memberAt(item, endOfDay));

    const remainingIssues: BurndownIssue[] = [];
    let actual = 0;
    let committedEffort = 0;
    let completedCount = 0;

    for (const item of holding) {
      const owed = remainderAt(item, endOfDay, false);
      const status = statusAt(item, endOfDay);
      committedEffort += estimateAt(item, endOfDay);
      actual += owed;

      if (status !== null && isClosedStatus(status)) {
        completedCount += 1;
        continue;
      }
      remainingIssues.push({
        issueId: item.issueId,
        ...nameOf(item),
        status,
        effortHours: owed,
      });
    }

    /* The heaviest first: what a reader wants from this list is what is
       holding the sprint up. */
    remainingIssues.sort(
      (a, b) => b.effortHours - a.effortHours || a.key.localeCompare(b.key),
    );

    /* Why the line moved today. The difference each event made is read the
       same way the line is — what the item owed a moment before, against what
       it owed a moment after — so the reasons listed for a day always add up
       to the step the line took. */
    const changes: BurndownChange[] = [];
    for (const event of events) {
      const at = event.at.getTime();
      if (at < date.getTime() || at >= endOfDay) continue;
      const delta =
        owedAt(event.item, at + 1, false) - owedAt(event.item, at, false);
      if (delta === 0 && event.reason !== "estimate") continue;
      changes.push({
        at: event.at,
        issueId: event.item.issueId,
        ...nameOf(event.item),
        reason: event.reason,
        delta,
        ...(event.from === undefined ? {} : { from: event.from }),
        ...(event.to === undefined ? {} : { to: event.to }),
      });
    }

    return {
      date,
      ideal: Math.max(0, ideal),
      actual,
      remainingIssues,
      remainingCount: remainingIssues.length,
      completedCount,
      committedEffort,
      completedEffort: Math.max(0, committedEffort - actual),
      changes,
    };
  });

  const todayIndex = days.findIndex((date) => date.getTime() === today);

  return {
    totalEffort,
    remaining,
    completedEffort: Math.max(0, totalEffort - remaining),
    unestimated,
    totalIssues: held.length,
    completedIssues,
    remainingIssues: held.length - completedIssues,
    todayIndex: todayIndex === -1 ? null : todayIndex,
    active: params.active ?? false,
    points,
  };
}
