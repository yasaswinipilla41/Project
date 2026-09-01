import type { IssueType, Prisma } from "@prisma/client";
import { issueScope } from "@/lib/authz";
import {
  COMMENT_ACTIONS,
  isCommentAction,
  type ActivityType,
  type CommentAction,
} from "@/lib/activity";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";

/**
 * The Activity feed's data (§ activity follow-up).
 *
 * Sourced entirely from the existing immutable `ActivityLogEntry` trail
 * (§31) — the same table `updateIssue` already writes to on every field
 * change, and the same table the dashboard, admin and project-detail activity
 * lists already read. Nothing here writes a new kind of record; this only
 * reads that trail, restricted to the event kinds the feed renders as a
 * sentence: an issue being (re)assigned, its status changing, and a comment
 * being written, edited or deleted on it.
 */

export const PAGE_SIZE = 25;

export interface ActivityFilters {
  q?: string;
  projectId?: string;
  /** Matches either who performed the action or, for an assignment, who received it. */
  userId?: string;
  type?: ActivityType;
  page?: number;
}

export interface ActivityEntry {
  id: string;
  kind: ActivityType;
  createdAt: Date;
  actor: { id: string; name: string; image: string | null };
  issue: { key: string; title: string; type: IssueType };
  project: { id: string; key: string; name: string };
  /** Set when `kind === "assignment"`. */
  assigneeName?: string;
  /** Set when `kind === "status"`. */
  fromStatus?: string | null;
  toStatus?: string | null;
  /** Set when `kind === "comment"` -- which of the three things happened. */
  commentAction?: CommentAction;
}

export interface ActivityListResult {
  rows: ActivityEntry[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

/*
 * The three event kinds the feed can render as a sentence.
 *
 * Assignments and status changes are field changes on the issue, so they are
 * recognised by `field`. A comment changes no field of the issue, so it is
 * recognised by `action` instead. Keeping the three conditions in one place is
 * what stops the unfiltered feed and the per-type filters drifting apart --
 * "All activity" is exactly the union of the kinds the feed knows how to say.
 */
const ASSIGNMENT_WHERE: Prisma.ActivityLogEntryWhereInput = {
  field: "assigneeId",
  newValue: { not: null },
};
const STATUS_WHERE: Prisma.ActivityLogEntryWhereInput = { field: "status" };
const COMMENT_WHERE: Prisma.ActivityLogEntryWhereInput = {
  action: { in: [...COMMENT_ACTIONS] },
};

function typeCondition(type: ActivityType | undefined): Prisma.ActivityLogEntryWhereInput {
  if (type === "assignment") return ASSIGNMENT_WHERE;
  if (type === "status") return STATUS_WHERE;
  if (type === "comment") return COMMENT_WHERE;
  return { OR: [ASSIGNMENT_WHERE, STATUS_WHERE, COMMENT_WHERE] };
}

export async function listActivity(
  user: CurrentUser,
  filters: ActivityFilters,
): Promise<ActivityListResult> {
  const page = filters.page && filters.page > 0 ? Math.floor(filters.page) : 1;
  const pageSize = PAGE_SIZE;

  const conditions: Prisma.ActivityLogEntryWhereInput[] = [
    { issue: issueScope(user) },
    typeCondition(filters.type),
  ];

  if (filters.projectId) {
    conditions.push({ issue: { projectId: filters.projectId } });
  }

  if (filters.userId) {
    conditions.push({
      OR: [{ actorId: filters.userId }, { newValue: filters.userId }],
    });
  }

  if (filters.q) {
    const q = filters.q;
    conditions.push({
      OR: [
        { actor: { name: { contains: q, mode: "insensitive" } } },
        { issue: { title: { contains: q, mode: "insensitive" } } },
        { issue: { key: { contains: q, mode: "insensitive" } } },
        { issue: { project: { name: { contains: q, mode: "insensitive" } } } },
      ],
    });
  }

  const where: Prisma.ActivityLogEntryWhereInput = { AND: conditions };

  const [total, entries] = await Promise.all([
    prisma.activityLogEntry.count({ where }),
    prisma.activityLogEntry.findMany({
      where,
      select: {
        id: true,
        action: true,
        field: true,
        oldValue: true,
        newValue: true,
        createdAt: true,
        actor: { select: { id: true, name: true, image: true } },
        issue: {
          select: {
            key: true,
            title: true,
            type: true,
            project: { select: { id: true, key: true, name: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  // `newValue` on an assigneeId change is the new assignee's raw user id, not
  // a name — resolved here rather than denormalized onto the activity row.
  const assigneeIds = [
    ...new Set(
      entries
        .filter((entry) => entry.field === "assigneeId")
        .map((entry) => entry.newValue)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const assigneeUsers =
    assigneeIds.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: assigneeIds } },
          select: { id: true, name: true },
        })
      : [];
  const assigneeNameById = new Map(assigneeUsers.map((u) => [u.id, u.name]));

  const rows: ActivityEntry[] = entries.map((entry) => {
    /* Ordered so a comment row is never mistaken for an assignment: comment
       entries carry no `field` at all, and the old "status or else
       assignment" test would have called every one of them an assignment. */
    /* Bound to a const first: TypeScript narrows through an aliased type
       guard only when what was tested cannot have changed since, which a
       mutable property of `entry` could have. */
    const action = entry.action;
    const comment = isCommentAction(action);
    const kind: ActivityType = comment
      ? "comment"
      : entry.field === "status"
        ? "status"
        : "assignment";
    return {
      id: entry.id,
      kind,
      commentAction: comment ? action : undefined,
      createdAt: entry.createdAt,
      actor: entry.actor,
      issue: { key: entry.issue.key, title: entry.issue.title, type: entry.issue.type },
      project: entry.issue.project,
      assigneeName:
        kind === "assignment"
          ? (entry.newValue && assigneeNameById.get(entry.newValue)) || "someone"
          : undefined,
      fromStatus: kind === "status" ? entry.oldValue : undefined,
      toStatus: kind === "status" ? entry.newValue : undefined,
    };
  });

  return {
    rows,
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}
