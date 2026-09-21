import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZES,
  SORT_FIELDS,
  type IssueFilters,
  type SortDirection,
  type SortField,
} from "@/server/queries/issues";
import type { AssignmentHistoryFilters } from "@/server/queries/assignmentHistory";

/** Next gives repeated query params as string[] and single ones as string. */
export type SearchParams = Record<string, string | string[] | undefined>;

function many(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function one(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Turns URL search params into filters. Unknown or malformed values are
 * dropped rather than trusted — this is user-controlled input that reaches a
 * database query.
 */
export function parseIssueParams(params: SearchParams): IssueFilters {
  const sortRaw = one(params.sort);
  const sort = (SORT_FIELDS as readonly string[]).includes(sortRaw ?? "")
    ? (sortRaw as SortField)
    : "updated";

  const dirRaw = one(params.dir);
  const dir: SortDirection = dirRaw === "asc" ? "asc" : "desc";

  const pageRaw = Number(one(params.page) ?? "1");
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;

  const sizeRaw = Number(one(params.pageSize) ?? DEFAULT_PAGE_SIZE);
  const pageSize = (PAGE_SIZES as readonly number[]).includes(sizeRaw)
    ? sizeRaw
    : DEFAULT_PAGE_SIZE;

  const resolution = one(params.resolution);

  /* Only the two windows the dashboard actually links to; anything else is
     dropped like every other unrecognised value here. */
  const completedRaw = one(params.completedWithin);
  const completedWithin =
    completedRaw === "month" || completedRaw === "lastMonth"
      ? completedRaw
      : undefined;

  return {
    q: one(params.q),
    projectIds: many(params.project),
    types: many(params.type),
    statuses: many(params.status),
    priorities: many(params.priority),
    assigneeIds: many(params.assignee),
    reporterIds: many(params.reporter),
    completedByIds: many(params.completedBy),
    labelIds: many(params.label),
    sprintIds: many(params.sprint),
    resolution:
      resolution === "open" || resolution === "closed" ? resolution : undefined,
    overdue: one(params.overdue) === "1",
    dueWeek: one(params.dueWeek) === "1",
    dueToday: one(params.dueToday) === "1",
    completedWithin,
    environment: one(params.environment),
    affectedModule: one(params.module),
    sort,
    dir,
    page,
    pageSize,
  };
}

/**
 * Backlog History's own filters, read from the URL.
 *
 * Same discipline as `parseIssueParams`: unrecognised values are dropped
 * rather than trusted, because this is user-controlled input that reaches a
 * database query. The project is deliberately absent — a project-scoped
 * history page fixes its project from the route, so accepting one here would
 * be a way to ask about a different project's work.
 */
export function parseAssignmentHistoryParams(
  params: SearchParams,
): AssignmentHistoryFilters {
  const kindRaw = one(params.kind);
  const kind =
    kindRaw === "Manual" || kindRaw === "Automatic" ? kindRaw : undefined;

  const pageRaw = Number(one(params.page) ?? "1");
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;

  /** Only a plain `yyyy-mm-dd`; anything else is no filter at all. */
  const day = (value: string | undefined) =>
    value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : undefined;

  return {
    q: one(params.q),
    kind,
    userId: one(params.user),
    from: day(one(params.from)),
    to: day(one(params.to)),
    page,
  };
}
