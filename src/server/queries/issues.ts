import type { Prisma } from "@prisma/client";
import type { IssueType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  completedByFilter,
  completersFor,
} from "@/server/queries/completedWork";
import { issueScope, workRolesFor } from "@/lib/authz";
import { monthWindow } from "@/lib/format";
import {
  dueThisWeekFilter,
  dueTodayFilter,
  overdueFilter,
} from "@/server/queries/due";
import type { CurrentUser } from "@/lib/session";
import {
  CLOSED_STATUSES,
  OPEN_STATUSES,
  doesDeveloperWork,
  doesQaWork,
  isIssueStatus,
  isIssueType,
  isPriority,
} from "@/lib/domain";

/**
 * The one place issues are queried for list surfaces.
 *
 * `/issues`, `/bugs`, `/my-work` and `/search` all funnel through here so
 * filtering, sorting, pagination and — critically — the project-access scope
 * behave identically everywhere. Every query is scoped in SQL, never filtered
 * after the fact.
 */

export const SORT_FIELDS = [
  "updated",
  "created",
  "priority",
  "due",
  "status",
  "key",
  "title",
] as const;

export type SortField = (typeof SORT_FIELDS)[number];
export type SortDirection = "asc" | "desc";

export const PAGE_SIZES = [25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 25;

export interface IssueFilters {
  q?: string;
  projectIds?: string[];
  types?: string[];
  statuses?: string[];
  priorities?: string[];
  severities?: string[];
  assigneeIds?: string[];
  reporterIds?: string[];
  /**
   * Restricts to work these people completed — My Work's Completed tile.
   * Implies DONE; see `completedByFilter` for what counts as theirs.
   */
  completedByIds?: string[];
  labelIds?: string[];
  /**
   * Which sprints' work to show. `"none"` is a first-class value meaning the
   * backlog — work in no sprint at all — so "Backlog" is a choice rather than
   * the absence of a choice, exactly as `"none"` already works for assignee.
   */
  sprintIds?: string[];
  /** "open" | "closed" | undefined (all) */
  resolution?: string;
  /** Restricts to overdue items. */
  overdue?: boolean;
  /** Restricts to items due between the end of today and the end of the week. */
  dueWeek?: boolean;
  dueToday?: boolean;
  /**
   * Restricts to work *completed* within a calendar month — "month" for the
   * current one, "lastMonth" for the one before. Completed means DONE, the
   * same definition the dashboard counts, so the metric and this list cannot
   * disagree about what was finished.
   */
  completedWithin?: "month" | "lastMonth";
  environment?: string;
  affectedModule?: string;
  /** Forces a single type, e.g. the /bugs surface. */
  lockedType?: IssueType;
  sort?: SortField;
  dir?: SortDirection;
  page?: number;
  pageSize?: number;
}

export interface IssueListRow {
  id: string;
  key: string;
  type: IssueType;
  title: string;
  status: (typeof OPEN_STATUSES)[number] | (typeof CLOSED_STATUSES)[number];
  priority: "URGENT" | "HIGH" | "MEDIUM" | "LOW" | "NONE";
  dueDate: Date | null;
  createdAt: Date;
  updatedAt: Date;
  project: { key: string; name: string };
  assignee: { id: string; name: string; image: string | null } | null;
  reporter: { id: string; name: string; image: string | null };
  /**
   * Who actually moved this issue to Done, or `null` when it is not finished
   * or the trail does not say. Deliberately *not* the assignee: an issue is
   * often finished by somebody other than whoever holds it now.
   */
  completedBy: { id: string; name: string; image: string | null } | null;
  /** When it was finished, from the issue's own `completedAt`. */
  completedAt: Date | null;
  labels: { label: { id: string; name: string; color: string } }[];
  parent: { key: string } | null;
  _count: { children: number; comments: number };
}

/** Builds the Prisma `where` clause, already scoped to the caller's access. */
export function buildIssueWhere(
  user: CurrentUser,
  filters: IssueFilters,
): Prisma.IssueWhereInput {
  const where: Prisma.IssueWhereInput = { ...issueScope(user) };
  const and: Prisma.IssueWhereInput[] = [];

  if (filters.lockedType) {
    where.type = filters.lockedType;
  } else {
    const types = (filters.types ?? []).filter(isIssueType);
    if (types.length > 0) where.type = { in: types };
  }

  if (filters.projectIds?.length) {
    where.projectId = { in: filters.projectIds };
  }

  const statuses = (filters.statuses ?? []).filter(isIssueStatus);
  if (statuses.length > 0) {
    where.status = { in: statuses };
  } else if (filters.resolution === "open") {
    where.status = { in: [...OPEN_STATUSES] };
  } else if (filters.resolution === "closed") {
    where.status = { in: [...CLOSED_STATUSES] };
  }

  const priorities = (filters.priorities ?? []).filter(isPriority);
  if (priorities.length > 0) where.priority = { in: priorities };

  if (filters.assigneeIds?.length) {
    // "unassigned" is a first-class choice, not the absence of a filter.
    const ids = filters.assigneeIds.filter((id) => id !== "none");
    const wantsUnassigned = filters.assigneeIds.includes("none");
    if (ids.length > 0 && wantsUnassigned) {
      and.push({ OR: [{ assigneeId: { in: ids } }, { assigneeId: null }] });
    } else if (wantsUnassigned) {
      where.assigneeId = null;
    } else {
      where.assigneeId = { in: ids };
    }
  }

  if (filters.reporterIds?.length) {
    where.reporterId = { in: filters.reporterIds };
  }

  if (filters.completedByIds?.length) {
    /*
     * "Completed by me" — and only ever me.
     *
     * My Work's tile links here carrying the reader's own id, and the value
     * that arrives is deliberately ignored in favour of the session's. A URL is
     * something anybody can type, and whose work is finished is not a question
     * a query string gets to answer; an administrator opening their own tile
     * sees their own work rather than the organisation's.
     *
     * The parameter survives as the switch that turns the filter on, so the
     * figure and the rows it opens remain the same query — `completedByFilter`
     * is exactly what My Work counts with.
     */
    and.push(completedByFilter([user.id]));
  }

  if (filters.labelIds?.length) {
    // An issue matches if it carries any of the selected labels.
    where.labels = { some: { labelId: { in: filters.labelIds } } };
  }

  if (filters.sprintIds?.length) {
    /*
     * The backlog is a sprint choice, not the lack of one.
     *
     * `"none"` means "in no sprint", the same sentinel the assignee filter
     * above uses for unassigned work, and it composes with named sprints the
     * same way: picking Backlog and Sprint 4 shows both, rather than one
     * silently cancelling the other. Sprints are scoped to a project by the
     * schema, so filtering by one implicitly narrows to that project's work
     * without this needing to say so.
     */
    const ids = filters.sprintIds.filter((id) => id !== "none");
    const wantsBacklog = filters.sprintIds.includes("none");
    /*
     * A sprint's work is what is in it now, and — once it is completed —
     * everything its record says it held when it closed. Completing a sprint
     * carries unfinished issues out of it, so `sprintId` alone would show a
     * completed sprint as only its finished half. Only `completeSprint` writes
     * outcome rows, so a planned or active sprint matches exactly as before.
     */
    const inSprints: Prisma.IssueWhereInput = {
      OR: [
        { sprintId: { in: ids } },
        { sprintOutcomes: { some: { sprintId: { in: ids } } } },
      ],
    };
    if (ids.length > 0 && wantsBacklog) {
      and.push({ OR: [inSprints, { sprintId: null }] });
    } else if (wantsBacklog) {
      where.sprintId = null;
    } else {
      and.push(inSprints);
    }
  }

  if (filters.overdue) {
    // The one definition, shared with every counter that shows this number.
    and.push(overdueFilter());
  }

  if (filters.completedWithin) {
    /* The same boundaries and the same status the dashboard's "completed this
       month" counts on, from the one shared `monthWindow`, so clicking that
       figure opens exactly the issues it counted. */
    const { startOfMonth, startOfNextMonth, startOfLastMonth } = monthWindow();
    const [gte, lt] =
      filters.completedWithin === "month"
        ? [startOfMonth, startOfNextMonth]
        : [startOfLastMonth, startOfMonth];

    and.push({ status: "DONE", completedAt: { gte, lt } });
  }

  if (filters.dueToday) {
    /* Today's date, and the same fragment the number on Home is counted with,
       so the figure and the list it opens are one query. */
    and.push(dueTodayFilter());
  }

  if (filters.dueWeek) {
    /* The current calendar week, whole: `[startOfWeek, startOfNextWeek)`. The
       same fragment every "Due this week" number is counted with, so opening
       one shows exactly what it counted. An undated issue matches neither
       bound, so it is never in this list. */
    and.push(dueThisWeekFilter());
  }

  if (filters.environment) {
    where.environment = { contains: filters.environment, mode: "insensitive" };
  }

  if (filters.affectedModule) {
    where.affectedModule = {
      contains: filters.affectedModule,
      mode: "insensitive",
    };
  }

  const q = filters.q?.trim();
  if (q) {
    and.push(issueTextSearch(q));
  }

  if (and.length > 0) where.AND = and;
  return where;
}

/**
 * Free-text matching across everything §34 asks for. An exact issue key is
 * matched directly so `ENG-1` resolves, and a bare project key (`ENG`) is
 * matched too so it returns that project's issues rather than nothing.
 *
 * The retired reproduction fields are deliberately absent: searching columns
 * nobody can see or edit any more would surface matches a reader cannot then
 * find on the page.
 */
export function issueTextSearch(q: string): Prisma.IssueWhereInput {
  const insensitive = { contains: q, mode: "insensitive" as const };
  const upper = q.toUpperCase();

  /*
   * Issue keys are identifiers, so they are matched as identifiers.
   *
   * A substring match on the key is what made searching "1" return ENG-1,
   * ENG-10, ENG-11 and ENG-100 alike, and "ENG-1" return every ENG-1x — the
   * number is a suffix of longer numbers, so `contains` can never tell them
   * apart. Each shape is therefore matched by what it actually is:
   *
   *   "ENG-1"  a whole key      -> that key, exactly
   *   "1"      a whole number   -> issue 1 in any project the viewer can see
   *   "ENG"    a project prefix -> every key beginning with it
   *
   * Text search over titles, descriptions, labels and people is untouched:
   * those are prose, where a substring match is the right behaviour.
   */
  const wholeKey = /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(q);
  const wholeNumber = /^\d+$/.test(q);

  const identifier: Prisma.IssueWhereInput[] = wholeKey
    ? [{ key: { equals: upper } }]
    : wholeNumber
      ? [{ number: { equals: Number(q) } }]
      : [
          { key: { startsWith: upper } },
          { project: { key: { equals: upper } } },
        ];

  return {
    OR: [
      ...identifier,
      { title: insensitive },
      { description: insensitive },
      { environment: insensitive },
      { affectedModule: insensitive },
      { versionBuild: insensitive },
      { labels: { some: { label: { name: insensitive } } } },
      { assignee: { name: insensitive } },
      { reporter: { name: insensitive } },
      { project: { name: insensitive } },
    ],
  };
}

/**
 * Sort order. Priority is an enum whose declaration order runs from most to
 * least urgent, so Postgres sorts it meaningfully with no extra column:
 * ascending enum order === descending urgency.
 */
function buildOrderBy(
  sort: SortField,
  dir: SortDirection,
): Prisma.IssueOrderByWithRelationInput[] {
  const flip = (d: SortDirection): SortDirection => (d === "asc" ? "desc" : "asc");

  switch (sort) {
    case "created":
      return [{ createdAt: dir }];
    case "priority":
      // URGENT is first in the enum, so "desc" urgency is "asc" enum order.
      return [{ priority: dir === "desc" ? "asc" : "desc" }, { updatedAt: "desc" }];
    case "due":
      // Items without a due date sort last regardless of direction.
      return [{ dueDate: { sort: dir, nulls: "last" } }, { updatedAt: "desc" }];
    case "status":
      return [{ status: dir }, { updatedAt: "desc" }];
    case "key":
      return [{ project: { key: dir } }, { number: dir }];
    case "title":
      return [{ title: dir }];
    case "updated":
    default:
      return [{ updatedAt: dir }, { id: flip(dir) }];
  }
}

const LIST_SELECT = {
  id: true,
  key: true,
  type: true,
  title: true,
  status: true,
  priority: true,
  dueDate: true,
  completedAt: true,
  createdAt: true,
  updatedAt: true,
  project: { select: { key: true, name: true } },
  assignee: { select: { id: true, name: true, image: true } },
  reporter: { select: { id: true, name: true, image: true } },
  labels: {
    select: { label: { select: { id: true, name: true, color: true } } },
  },
  parent: { select: { key: true } },
  _count: { select: { children: true, comments: true } },
} satisfies Prisma.IssueSelect;

/**
 * `LIST_SELECT` plus every file attached to the issue, for the Excel export
 * only — the paginated `/issues` list never renders them, so it stays on
 * `LIST_SELECT` to avoid the extra read on every page view.
 *
 * Every file, including the ones posted on the issue's comments. This used to
 * filter to `commentId: null`, which quietly left out evidence attached to a
 * comment rather than to the issue itself — the screenshot somebody replied
 * with was simply missing from the sheet.
 *
 * No deduplication is needed, and none is done. A file uploaded to a comment
 * keeps the `issueId` it was uploaded against and gains a `commentId` when the
 * comment claims it, so it is one row reachable once through this relation.
 * Widening the select therefore adds the comment's files without repeating the
 * issue's own.
 */
const EXPORT_SELECT = {
  ...LIST_SELECT,
  attachments: {
    orderBy: { createdAt: "asc" },
    select: { id: true, filename: true, mimeType: true, storageKey: true },
  },
} satisfies Prisma.IssueSelect;

/**
 * Hard ceiling on a single export. Large enough for any real filtered view,
 * small enough that one request cannot be turned into a whole-database dump.
 */
export const EXPORT_LIMIT = 5000;

/**
 * Every issue matching the current filters, for the spreadsheet export.
 *
 * Deliberately built on the same `buildIssueWhere` the on-screen list uses,
 * so the export cannot widen what the caller is allowed to see: the project
 * scope is applied inside that function, not layered on afterwards where it
 * could be forgotten. The only difference from `listIssues` is that paging is
 * replaced by a bounded `take` — you export the whole filtered set, not the
 * page you happen to be looking at.
 */
export async function exportIssues(
  user: CurrentUser,
  filters: IssueFilters,
): Promise<IssueExportRow[]> {
  const rows = await prisma.issue.findMany({
    where: buildIssueWhere(user, filters),
    /* `EXPORT_SELECT` rather than `LIST_SELECT`: the spreadsheet carries each
       issue's attachments, which the on-screen list has no column for. The
       select and its row type already existed for exactly this and were simply
       never wired up. */
    select: EXPORT_SELECT,
    orderBy: buildOrderBy(filters.sort ?? "updated", filters.dir ?? "desc"),
    take: EXPORT_LIMIT,
  });
  /* The workbook has no "completed by" column, so the field is not looked up
     for an export — stated explicitly rather than left undefined behind a
     cast that claims otherwise. */
  return (rows as unknown as IssueExportRow[]).map((row) => ({
    ...row,
    completedBy: null,
  }));
}

export interface IssueListResult {
  rows: IssueListRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

/**
 * One page of issues plus the total. The count and the page are fetched in a
 * single round trip, and every relation the table renders is selected up front
 * so the list never triggers a per-row query.
 */
export async function listIssues(
  user: CurrentUser,
  filters: IssueFilters,
): Promise<IssueListResult> {
  const where = buildIssueWhere(user, filters);
  const sort = filters.sort ?? "updated";
  const dir = filters.dir ?? "desc";
  const pageSize = filters.pageSize ?? DEFAULT_PAGE_SIZE;
  const page = Math.max(1, filters.page ?? 1);

  /*
   * Deliberately not `$transaction`: `LIST_SELECT` carries nested relations
   * (project, assignee, labels, _count), and the query engine loads those as
   * separate sibling queries fired without waiting on one another. Off a
   * transaction, each gets its own pooled connection and that's harmless;
   * forced onto one shared connection *inside* a transaction, those sibling
   * queries collide on it — pg's "client.query() while already executing a
   * query" guard. A snapshot shared between the count and the page is a nicety
   * here, not a correctness requirement, so it is not worth working around an
   * engine bug for.
   */
  const [total, rows] = await Promise.all([
    prisma.issue.count({ where }),
    prisma.issue.findMany({
      where,
      select: LIST_SELECT,
      orderBy: buildOrderBy(sort, dir),
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  /*
   * Who finished each of the completed rows on this page, from the shared
   * `completersFor` — the same trail the project summary reads, so the two
   * surfaces always name the same person. One extra query per page, bounded
   * by the page size, and only for the rows that are actually Done.
   */
  const completers = await completersFor(
    rows.filter((row) => row.status === "DONE").map((row) => row.id),
  );

  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return {
    rows: (rows as unknown as IssueListRow[]).map((row) => ({
      ...row,
      completedBy: completers.get(row.id) ?? null,
    })),
    total,
    page: Math.min(page, pageCount),
    pageSize,
    pageCount,
  };
}

/**
 * Every issue matching `filters`, unpaginated, for the Excel export (§ Export
 * Issues to Excel). Scoped by the same `issueScope` as every other read path —
 * an export never contains a row the caller could not otherwise see.
 *
 * Capped well above any realistic organization's issue count so a runaway
 * request cannot exhaust memory generating the workbook.
 */
const EXPORT_ROW_LIMIT = 20_000;

export interface IssueExportRow extends IssueListRow {
  attachments: { id: string; filename: string; mimeType: string; storageKey: string }[];
}

export async function listIssuesForExport(
  user: CurrentUser,
  filters: IssueFilters,
): Promise<IssueExportRow[]> {
  const where = buildIssueWhere(user, filters);
  const rows = await prisma.issue.findMany({
    where,
    select: EXPORT_SELECT,
    orderBy: buildOrderBy(filters.sort ?? "updated", filters.dir ?? "desc"),
    take: EXPORT_ROW_LIMIT,
  });
  return rows as unknown as IssueExportRow[];
}

/** Counts grouped by status for the filter bar's summary chips. */
export async function countByStatus(
  user: CurrentUser,
  filters: IssueFilters,
): Promise<Record<string, number>> {
  const rows = await prisma.issue.groupBy({
    by: ["status"],
    where: buildIssueWhere(user, filters),
    _count: { _all: true },
  });

  const result: Record<string, number> = {};
  for (const row of rows) result[row.status] = row._count._all;
  return result;
}

/**
 * The option lists the filter bar offers: only projects the caller can see,
 * only people who are members of those projects, only labels and sprints in
 * them.
 */
export async function filterOptions(
  user: CurrentUser,
  scopeToProjectIds?: readonly string[],
) {
  const projects = await prisma.project.findMany({
    where: {
      isArchived: false,
      ...(user.role === "ADMIN" ? {} : { members: { some: { userId: user.id } } }),
    },
    select: { id: true, key: true, name: true },
    orderBy: { name: "asc" },
  });

  const projectIds = projects.map((p) => p.id);

  /*
   * Who the people menus may name.
   *
   * A project's own List tab passes that project, so its Assignee and Reporter
   * menus offer the people on it rather than everybody the reader could reach
   * from somewhere else. The global list passes nothing and keeps the scope it
   * always had.
   *
   * The narrowing is intersected with what the caller can already see, so a
   * project id in the request can only ever remove names from this list and
   * never add one: an id they have no access to matches nothing.
   */
  const peopleScope = scopeToProjectIds?.length
    ? projectIds.filter((id) => scopeToProjectIds.includes(id))
    : projectIds;

  const [people, labels, sprints, holdingRows, raisingRows] = await Promise.all([
    prisma.user.findMany({
      where: {
        isActive: true,
        projectMemberships: { some: { projectId: { in: peopleScope } } },
      },
      select: { id: true, name: true, image: true },
      orderBy: { name: "asc" },
    }),
    prisma.label.findMany({
      where: { projectId: { in: projectIds } },
      select: { id: true, name: true, color: true, projectId: true },
      orderBy: { name: "asc" },
    }),
    /* Scoped to the same projects as everything else here, so a sprint the
       caller could not open is never offered as something to filter by. The
       project's key travels with each one because two projects may both have
       a "Sprint 4", and a cross-project surface has to tell them apart. */
    prisma.sprint.findMany({
      where: { projectId: { in: projectIds } },
      select: {
        id: true,
        name: true,
        projectId: true,
        /* Read so a surface can mark a completed sprint as one — from the
           sprint's own status, never from its name. */
        status: true,
        /* The period it covers, so every surface that names a sprint can say
           which dates it means rather than leaving the reader to open it. */
        startDate: true,
        endDate: true,
        project: { select: { key: true } },
      },
      orderBy: [{ startDate: "desc" }, { name: "asc" }],
    }),
    /* Who actually holds and who actually raised work in scope. Grouped in the
       database rather than listed and de-duplicated here, so the cost does not
       grow with the number of issues. */
    prisma.issue.groupBy({
      by: ["assigneeId"],
      where: { projectId: { in: peopleScope }, assigneeId: { not: null } },
      _count: { _all: true },
    }),
    prisma.issue.groupBy({
      by: ["reporterId"],
      where: { projectId: { in: peopleScope } },
      _count: { _all: true },
    }),
  ]);

  /*
   * Assignee and Reporter name different populations, from the role model the
   * rest of Prio already reads — `workRolesFor`, the same derivation every
   * guard uses, never a name or an email.
   *
   *   Assignee   the people who build: developers and full stack developers
   *   Reporter   the people who check: QA members and full stack developers
   *
   * Plus, in both cases, anybody who genuinely holds or raised an issue in
   * scope. That union is deliberate. Prio hands work back to the tester who
   * raised it, so testers really do hold issues; and every role may raise
   * work, so reporters really are not only testers. Leaving those people out
   * would produce a filter that cannot select rows the table is showing.
   *
   * Administrators are not offered as a designation-based option — assigning
   * to an administrator is not what the create rules allow either — but an
   * administrator who does hold or raise something appears through the union,
   * for the same reason.
   */
  const roles = await workRolesFor(people.map((person) => person.id));
  const holdsWork = new Set(
    holdingRows
      .map((row) => row.assigneeId)
      .filter((id): id is string => id !== null),
  );
  const raisedWork = new Set(raisingRows.map((row) => row.reporterId));

  const assignees = people.filter((person) => {
    const role = roles.get(person.id);
    return (
      (role !== undefined && role !== "ADMIN" && doesDeveloperWork(role)) ||
      holdsWork.has(person.id)
    );
  });

  const reporters = people.filter((person) => {
    const role = roles.get(person.id);
    return (
      (role !== undefined && role !== "ADMIN" && doesQaWork(role)) ||
      raisedWork.has(person.id)
    );
  });

  return { projects, people, assignees, reporters, labels, sprints };
}

/**
 * Sub-issue progress for a page of issues, in one query.
 *
 * The same measure the dashboard already uses — closed children over total
 * children — rather than a second, differently-defined notion of "progress".
 * An issue with no sub-issues has no progress: it is absent from the map, and
 * callers show nothing rather than a misleading 0%.
 */
export async function loadIssueProgress(
  issueIds: string[],
): Promise<Map<string, { done: number; total: number }>> {
  const progress = new Map<string, { done: number; total: number }>();
  if (issueIds.length === 0) return progress;

  const rows = await prisma.issue.groupBy({
    by: ["parentId", "status"],
    where: { parentId: { in: issueIds } },
    _count: { _all: true },
  });

  for (const row of rows) {
    if (!row.parentId) continue;
    const entry = progress.get(row.parentId) ?? { done: 0, total: 0 };
    entry.total += row._count._all;
    if ((CLOSED_STATUSES as readonly string[]).includes(row.status)) {
      entry.done += row._count._all;
    }
    progress.set(row.parentId, entry);
  }

  return progress;
}
