import type { Prisma } from "@prisma/client";
import { CLOSED_STATUSES } from "@/lib/domain";
import { dueWindow } from "@/lib/format";

/**
 * The three due-date questions, asked once.
 *
 * Overdue, Due today and Due this week are each shown as a number somewhere
 * and as a list somewhere else, and the two used to be written out separately
 * at every call site. They drifted, which is the only way a card can say 2 and
 * open 3: the dashboard counted from this instant, the list counted from the
 * start of today, and "this week" meant a rolling seven days in one place and
 * the calendar week in another.
 *
 * These are the definitions, as Prisma `where` fragments, and every counter
 * and every list composes one of them with its own scope. A count and the list
 * it opens are then the same query with a different projection, which is what
 * makes `count === list.length` a property of the code rather than a thing to
 * keep checking.
 *
 * All three read the business day from the server's local clock, the same one
 * `dueWindow` has always used, so a due date is read the same way everywhere.
 * Every fragment excludes closed work: finished work is not due.
 */

const OPEN: Prisma.IssueWhereInput = {
  status: { notIn: [...CLOSED_STATUSES] },
};

/**
 * Past its due date, and still open.
 *
 * The boundary is the start of today, not this instant: something due today is
 * due today until the day is over, whatever the time on the clock. That is the
 * business date the rest of Prio reads, and it is why an issue never appears
 * in Overdue and Due today at once.
 */
export function overdueFilter(now?: Date): Prisma.IssueWhereInput {
  const { startOfToday } = dueWindow(now);
  return { ...OPEN, dueDate: { lt: startOfToday } };
}

/** Due on today's calendar date, and still open. */
export function dueTodayFilter(now?: Date): Prisma.IssueWhereInput {
  const { startOfToday, endOfToday } = dueWindow(now);
  return { ...OPEN, dueDate: { gte: startOfToday, lt: endOfToday } };
}

/**
 * Due in the current calendar week, and still open.
 *
 * `[startOfWeek, startOfNextWeek)` — the whole week the day belongs to, from
 * its first moment, not the remainder of it. Work due on Monday is due this
 * week when read on Wednesday; it is also overdue, and both are true. The
 * half-open upper bound is what keeps the first moment of next week out.
 */
export function dueThisWeekFilter(now?: Date): Prisma.IssueWhereInput {
  const { startOfWeek, endOfWeek } = dueWindow(now);
  return { ...OPEN, dueDate: { gte: startOfWeek, lt: endOfWeek } };
}
