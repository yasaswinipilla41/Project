/**
 * Presentation helpers shared by every surface so dates, names and counts read
 * the same on the board, the table, the detail page and reports.
 */

/*
 * One convention for every date Prio prints: `Aug 8, 2026` for a day, and
 * `Jul 14, 2026, 10:15 AM` when the time matters.
 *
 * Defined once here and nowhere else, so the work item table, the issue page,
 * the activity trail and every card read the same way. Changing the shape of a
 * date is a change to these three formatters and to nothing else.
 *
 * The timezone is untouched: no `timeZone` is set, so every date is rendered
 * in the reader's own, exactly as before.
 */
const DATE_FMT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

const DATE_SHORT_FMT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
});

const DATETIME_FMT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

export function formatDate(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  return DATE_FMT.format(date);
}

/**
 * A sprint's own date form: `01 Sep 2026`.
 *
 * Day first, and the year always present. A sprint is a period rather than a
 * moment, and a range whose year is dropped inside the current year — as
 * `formatDateCompact` does — reads as a different kind of fact from the one
 * beside it the moment a sprint crosses a December.
 */
export function formatDayMonthYear(
  value: Date | string | null | undefined,
): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";

  const day = String(date.getDate()).padStart(2, "0");
  const month = MONTH_SHORT[date.getMonth()];
  return `${day} ${month} ${date.getFullYear()}`;
}

const MONTH_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

const MONTH_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

/**
 * The long form a sprint's own fields are written in: `11th October 2026`.
 *
 * Spelled out because these are the two dates a team commits to, read once
 * and remembered — `11/10/26` is ambiguous between two continents and `Oct 11`
 * loses the year the moment a sprint is looked at again next January.
 */
export function formatOrdinalDate(
  value: Date | string | null | undefined,
): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";

  return `${ordinal(date.getDate())} ${MONTH_LONG[date.getMonth()]} ${date.getFullYear()}`;
}

/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th — the teens are the exceptions. */
function ordinal(day: number): string {
  const tens = day % 100;
  if (tens >= 11 && tens <= 13) return `${day}th`;
  if (day % 10 === 1) return `${day}st`;
  if (day % 10 === 2) return `${day}nd`;
  if (day % 10 === 3) return `${day}rd`;
  return `${day}th`;
}

/**
 * The period a sprint covers, as it is shown beside the sprint's name:
 * `01 Sep 2026 - 07 Sep 2026`.
 *
 * One helper rather than four sites each spelling out their own separator,
 * which is how the board, the list, the details page and the iterations row
 * came to disagree about what a date range looks like.
 */
export function formatDateRange(
  start: Date | string | null | undefined,
  end: Date | string | null | undefined,
): string {
  return `${formatDayMonthYear(start)} - ${formatDayMonthYear(end)}`;
}

/** Omits the year for dates inside the current year (board cards, tables). */
export function formatDateCompact(
  value: Date | string | null | undefined,
): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  return date.getFullYear() === new Date().getFullYear()
    ? DATE_SHORT_FMT.format(date)
    : DATE_FMT.format(date);
}

export function formatDateTime(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  return DATETIME_FMT.format(date);
}

/** "just now", "4h ago", "3d ago", then falls back to an absolute date. */
export function formatRelative(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";

  const diffMs = Date.now() - date.getTime();
  const future = diffMs < 0;
  const abs = Math.abs(diffMs);

  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (abs < minute) return "just now";
  if (abs < hour) {
    const n = Math.floor(abs / minute);
    return future ? `in ${n}m` : `${n}m ago`;
  }
  if (abs < day) {
    const n = Math.floor(abs / hour);
    return future ? `in ${n}h` : `${n}h ago`;
  }
  if (abs < 7 * day) {
    const n = Math.floor(abs / day);
    return future ? `in ${n}d` : `${n}d ago`;
  }
  return formatDateCompact(date);
}

/** Whole days until a due date; negative when overdue. */
export function daysUntil(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return null;

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const target = new Date(date);
  target.setHours(0, 0, 0, 0);

  return Math.round((target.getTime() - startOfToday.getTime()) / 86_400_000);
}

/** Saturday or Sunday — the two days a sprint's working length skips. */
export function isWeekend(value: Date): boolean {
  const day = value.getDay();
  return day === 0 || day === 6;
}

/**
 * Working days from `start` to `end`, both ends included, weekends excluded.
 *
 * A fortnight's sprint measures ten working days, not fourteen: Saturday and
 * Sunday are in the calendar span but nobody is working them, so counting
 * them would overstate every sprint's capacity by two days a week. Both ends
 * count because a sprint that starts and ends on the same weekday is one
 * working day of work, not none.
 *
 * Defined here, once, beside the other date helpers, because two different
 * answers to "how long is this sprint" would drift apart — the same reason
 * `dueWindow` and `monthWindow` live here rather than at their call sites.
 * Dates are normalised to local midnight before counting, exactly as
 * `daysUntil` does, so a time of day cannot change the answer.
 *
 * Returns 0 when the range is inverted or either end is unreadable, so a
 * half-entered form never shows a negative length.
 */
export function workingDaysBetween(
  start: Date | string | null | undefined,
  end: Date | string | null | undefined,
): number {
  if (!start || !end) return 0;

  const from = typeof start === "string" ? new Date(start) : new Date(start);
  const to = typeof end === "string" ? new Date(end) : new Date(end);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return 0;

  from.setHours(0, 0, 0, 0);
  to.setHours(0, 0, 0, 0);
  if (from.getTime() > to.getTime()) return 0;

  let days = 0;
  const cursor = new Date(from);
  while (cursor.getTime() <= to.getTime()) {
    if (!isWeekend(cursor)) days += 1;
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

export function isOverdue(
  dueDate: Date | string | null | undefined,
  isClosed: boolean,
): boolean {
  if (!dueDate || isClosed) return false;
  const days = daysUntil(dueDate);
  return days !== null && days < 0;
}

/** Two-letter monogram for avatars: "Rahul Menon" -> "RM". */
export function initials(name: string | null | undefined): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) {
    return (parts[0] ?? "").slice(0, 2).toUpperCase();
  }
  const first = parts[0]?.[0] ?? "";
  const last = parts[parts.length - 1]?.[0] ?? "";
  return `${first}${last}`.toUpperCase();
}

export function pluralize(count: number, singular: string, plural?: string): string {
  return count === 1 ? singular : (plural ?? `${singular}s`);
}

export function countLabel(
  count: number,
  singular: string,
  plural?: string,
): string {
  return `${count} ${pluralize(count, singular, plural)}`;
}

/** Percentage rounded to a whole number, guarding division by zero. */
export function percent(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 100);
}

/**
 * Width for a distribution bar.
 *
 * `percent` rounds, so a real but small share — one issue in four hundred —
 * comes back as 0 and draws nothing at all. A bar of no width beside a count
 * that says "1" reads as "none", which is the one thing the number next to it
 * proves is false. Any non-zero count therefore keeps at least a sliver; a
 * genuine zero still draws nothing.
 */
export function barWidth(part: number, total: number): string {
  if (part <= 0 || total <= 0) return "0%";
  return `max(2px, ${percent(part, total)}%)`;
}

/** Date input value (yyyy-mm-dd) in local time, for <input type="date">. */
export function toDateInputValue(
  value: Date | string | null | undefined,
): string {
  if (!value) return "";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "";
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Truncates on a word boundary for previews and notification text. */
export function truncate(text: string, max = 120): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * One-line description of an activity entry for compact feeds (the admin audit
 * list), where the full before/after rendering of the issue page is too much.
 */
export function humanizeActivity(
  action: string,
  field: string | null,
): string {
  if (action === "issue.created") return "created";
  if (action === "bug.created") return "reported";
  if (action === "comment.created") return "commented on";
  if (!field) return "updated";

  const labels: Record<string, string> = {
    status: "changed the status of",
    priority: "changed the priority of",
    severity: "changed the severity of",
    assigneeId: "reassigned",
    dueDate: "changed the due date of",
    title: "renamed",
    description: "edited the description of",
    parentId: "changed the parent of",
  };

  return labels[field] ?? `updated the ${field} of`;
}

/**
 * The day boundaries the due-date buckets are cut on.
 *
 * One definition, because "due this week" is asked in two places that must
 * agree: the dashboard counts the issues, and the issue list has to show
 * exactly those issues when the count is clicked. A second calculation, even a
 * correct-looking one, is how a figure and the list behind it drift apart.
 *
 * "This week" is the *current calendar week*, not a rolling seven days, and it
 * runs `[startOfToday, endOfWeek)`:
 *
 *   - it starts at the beginning of today, so work due today is due this week.
 *     Today used to be excluded so the today/this-week counts could not
 *     overlap, which made "Due this week" answer a question nobody asks —
 *     everything due this week *except* the part due first.
 *   - it ends when the week does. A rolling seven days from today spills into
 *     next week for most of the week, so an issue due next Tuesday showed up
 *     under "this week" whenever today was a Wednesday or later.
 *   - anything before today is overdue, and overdue is its own bucket, so it
 *     is never in this window.
 *
 * Weeks start on Monday, the same convention the project calendar uses.
 */
export function dueWindow(now: Date = new Date()): {
  now: Date;
  startOfToday: Date;
  endOfToday: Date;
  /** Start of the current calendar week — inclusive lower bound for "this week". */
  startOfWeek: Date;
  /** Start of the *next* calendar week — exclusive upper bound for "this week". */
  endOfWeek: Date;
} {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  const endOfToday = new Date(startOfToday);
  endOfToday.setDate(endOfToday.getDate() + 1);

  /* Monday-first: `getDay()` is Sunday-based, so shift it before measuring how
     far into the week today already is. Both ends of the week are derived from
     that one measurement, so they can never describe different weeks. */
  const dayOfWeek = (startOfToday.getDay() + 6) % 7;

  const startOfWeek = new Date(startOfToday);
  startOfWeek.setDate(startOfWeek.getDate() - dayOfWeek);

  const endOfWeek = new Date(startOfToday);
  endOfWeek.setDate(endOfWeek.getDate() + (7 - dayOfWeek));

  return { now, startOfToday, endOfToday, startOfWeek, endOfWeek };
}

/**
 * The current and previous calendar months, as half-open ranges.
 *
 * Shared by the dashboard's "completed this month" count and by the issue
 * list's `completedWithin` filter, for the same reason `dueWindow` is shared:
 * the number on a card and the list that opens when it is clicked must be cut
 * on exactly the same boundaries, and two calculations are free to disagree.
 *
 * Local-time boundaries, matching `dueWindow` and the rest of Prio. Every
 * month bound is therefore read the same way a due date is, so there is no
 * mixed convention to reason about.
 */
export function monthWindow(now: Date = new Date()): {
  /** Inclusive lower bound for "this month". */
  startOfMonth: Date;
  /** Exclusive upper bound for "this month" — the start of the next one. */
  startOfNextMonth: Date;
  /** Inclusive lower bound for "last month"; its upper bound is `startOfMonth`. */
  startOfLastMonth: Date;
} {
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  return { startOfMonth, startOfNextMonth, startOfLastMonth };
}

/* ------------------------------------------------------------- durations */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * How long something took, in the largest units that still say something.
 *
 * Distinct from `formatRelative` above, which answers "how long ago" against
 * the clock and stops at a date once a week has passed. This answers "how
 * long" between two fixed instants, so it never stops being a duration — a
 * piece of work open for three months reads as days rather than turning into
 * a calendar date.
 *
 * Days and hours, plus minutes while the whole thing is still under a day:
 * "2d 4h" is what somebody wants to know about a fortnight's work, and
 * "2d 4h 30m" is false precision on it. Under an hour it falls to minutes,
 * and anything under a minute is "0m" rather than a count of seconds nobody
 * asked for.
 *
 * Negative input reads as "0m". It should not happen — it would mean something
 * finished before it began — but a clock skew on the writing server is not a
 * reason to print "-3h" on somebody's screen.
 */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0m";

  const days = Math.floor(ms / DAY_MS);
  const hours = Math.floor((ms % DAY_MS) / HOUR_MS);
  const minutes = Math.floor((ms % HOUR_MS) / MINUTE_MS);

  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${minutes}m`;
}

/**
 * The span between two instants, or null when it cannot be one.
 *
 * Returns null rather than zero for missing ends, because "not finished" and
 * "finished instantly" are different facts and a caller has to be able to tell
 * them apart — the one thing the interface must never do is print a completion
 * time for work that has not completed.
 */
export function elapsedBetween(
  from: Date | string | null | undefined,
  to: Date | string | null | undefined,
): number | null {
  if (!from || !to) return null;

  const start = typeof from === "string" ? new Date(from) : from;
  const end = typeof to === "string" ? new Date(to) : to;
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;

  return end.getTime() - start.getTime();
}

/**
 * Whole hours since an instant, for the "(24 hrs ago)" beside a relative time.
 *
 * Rounded down and deliberately coarse: it sits next to "1 day ago" as the
 * same fact in the unit people compare work in, not as a second, more precise
 * reading that would invite somebody to notice the two disagree.
 */
export function hoursAgo(value: Date | string | null | undefined): number | null {
  if (!value) return null;
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return null;

  return Math.max(0, Math.floor((Date.now() - date.getTime()) / HOUR_MS));
}
