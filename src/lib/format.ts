/**
 * Presentation helpers shared by every surface so dates, names and counts read
 * the same on the board, the table, the detail page and reports.
 */

const DATE_FMT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

const DATE_SHORT_FMT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
});

const DATETIME_FMT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

export function formatDate(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  return DATE_FMT.format(date);
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
 * `thisWeek` deliberately starts at the end of today rather than at the start
 * of the week: anything already past its date is overdue, and overdue is its
 * own bucket. So the two never overlap and nothing is counted twice.
 */
export function dueWindow(now: Date = new Date()): {
  now: Date;
  startOfToday: Date;
  endOfToday: Date;
  endOfWeek: Date;
} {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  const endOfToday = new Date(startOfToday);
  endOfToday.setDate(endOfToday.getDate() + 1);

  const endOfWeek = new Date(startOfToday);
  endOfWeek.setDate(endOfWeek.getDate() + 7);

  return { now, startOfToday, endOfToday, endOfWeek };
}
