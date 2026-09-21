import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { issueScope } from "@/lib/authz";
import {
  assignmentKindOf,
  AUTOMATIC_ASSIGNMENT_ACTION,
  type AssignmentKind,
} from "@/lib/activity";
import type { CurrentUser } from "@/lib/session";

/**
 * Who work was handed to, by whom, and whether Prio decided it.
 *
 * Read from the activity trail rather than from a table of its own. Every
 * change of assignee is already written there by the one path assignments go
 * through, so a second store would be a copy that has to be kept in step —
 * and the first time it was not, the history would be wrong in the one place
 * people go to find out what happened.
 *
 * Two things this deliberately does differently from the Activity feed:
 *
 *  - **Unassignments are included.** The feed filters to `newValue: not null`,
 *    so taking work off somebody was recorded and then never shown. "Who took
 *    this off me?" is exactly the question this page exists to answer.
 *  - **The actor is never guessed from the recipient.** It is the `actorId` on
 *    the row, and whether the decision was a person's or Prio's is read from
 *    the recorded action — not inferred from who ended up with the work.
 */

export const PAGE_SIZE = 25;

export interface AssignmentHistoryFilters {
  /** Work item key, title, or a person's name. */
  q?: string;
  /** One project, or every project the reader may see. */
  projectId?: string;
  /** Manual, Automatic, or both. */
  kind?: AssignmentKind;
  /** Anybody involved: who received it, who lost it, or who did it. */
  userId?: string;
  /** Inclusive day bounds, as `yyyy-mm-dd`. */
  from?: string;
  to?: string;
  page?: number;
}

export interface AssignmentHistoryRow {
  id: string;
  at: Date;
  kind: AssignmentKind;
  issue: { id: string; key: string; title: string };
  project: { key: string; name: string };
  /** Null means the work had nobody before this. */
  previousAssignee: { id: string; name: string } | null;
  /** Null means the work was taken off somebody and given to nobody. */
  newAssignee: { id: string; name: string } | null;
  /** Who performed or caused it. Never the recipient by default. */
  actor: { id: string; name: string };
}

export interface AssignmentHistoryResult {
  rows: AssignmentHistoryRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

/** Midnight at the start of a `yyyy-mm-dd`, or null if it is not one. */
function dayStart(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function listAssignmentHistory(
  user: CurrentUser,
  filters: AssignmentHistoryFilters,
): Promise<AssignmentHistoryResult> {
  const page = Math.max(1, Math.floor(filters.page ?? 1));

  /*
   * Scope first, and in the database.
   *
   * `issueScope` is the same fragment every other list is bounded by, so a
   * history row can only ever be about work the reader could already open.
   * Nothing below can widen it: every other clause is an AND.
   */
  const where: Prisma.ActivityLogEntryWhereInput = {
    field: "assigneeId",
    issue: issueScope(user),
  };
  const and: Prisma.ActivityLogEntryWhereInput[] = [];

  if (filters.projectId) {
    and.push({ issue: { projectId: filters.projectId } });
  }

  if (filters.kind === "Automatic") {
    and.push({ action: AUTOMATIC_ASSIGNMENT_ACTION });
  } else if (filters.kind === "Manual") {
    and.push({ NOT: { action: AUTOMATIC_ASSIGNMENT_ACTION } });
  }

  /* Anybody involved in the handover, not only the recipient: the row that
     matters to somebody is as often the one where work left them. */
  if (filters.userId) {
    and.push({
      OR: [
        { actorId: filters.userId },
        { newValue: filters.userId },
        { oldValue: filters.userId },
      ],
    });
  }

  const from = dayStart(filters.from);
  const to = dayStart(filters.to);
  if (from || to) {
    and.push({
      createdAt: {
        ...(from ? { gte: from } : {}),
        /* Inclusive of the chosen day: somebody asking for the 19th means the
           whole of it, not everything before it began. */
        ...(to ? { lt: new Date(to.getTime() + 24 * 60 * 60 * 1000) } : {}),
      },
    });
  }

  if (filters.q?.trim()) {
    const q = filters.q.trim();
    and.push({
      OR: [
        { issue: { key: { contains: q, mode: "insensitive" } } },
        { issue: { title: { contains: q, mode: "insensitive" } } },
        { actor: { name: { contains: q, mode: "insensitive" } } },
      ],
    });
  }

  if (and.length > 0) where.AND = and;

  const [total, entries] = await prisma.$transaction([
    prisma.activityLogEntry.count({ where }),
    prisma.activityLogEntry.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        action: true,
        oldValue: true,
        newValue: true,
        createdAt: true,
        actor: { select: { id: true, name: true } },
        issue: {
          select: {
            id: true,
            key: true,
            title: true,
            project: { select: { key: true, name: true } },
          },
        },
      },
    }),
  ]);

  /*
   * The two assignees, resolved in one query rather than per row.
   *
   * They are stored as bare ids — the trail is one shared shape for every
   * kind of field — so the names are looked up here. A person who has since
   * been deleted leaves an id with no name, and the page says "Unknown"
   * rather than dropping the row: the handover still happened.
   */
  const ids = [
    ...new Set(
      entries.flatMap((entry) =>
        [entry.oldValue, entry.newValue].filter(
          (value): value is string => typeof value === "string" && value !== "",
        ),
      ),
    ),
  ];
  const people = ids.length
    ? await prisma.user.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true },
      })
    : [];
  const nameOf = new Map(people.map((person) => [person.id, person.name]));

  const who = (id: string | null) =>
    id ? { id, name: nameOf.get(id) ?? "Unknown" } : null;

  return {
    rows: entries.map((entry) => ({
      id: entry.id,
      at: entry.createdAt,
      kind: assignmentKindOf(entry.action),
      issue: {
        id: entry.issue.id,
        key: entry.issue.key,
        title: entry.issue.title,
      },
      project: entry.issue.project,
      previousAssignee: who(entry.oldValue),
      newAssignee: who(entry.newValue),
      actor: entry.actor,
    })),
    total,
    page,
    pageSize: PAGE_SIZE,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  };
}
