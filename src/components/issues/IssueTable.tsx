import Link from "next/link";
import { Avatar, EmptyState } from "@/components/ui/primitives";
import {
  IssueKey,
  IssueTypeIcon,
  LabelChip,
  PriorityIndicator,
  SeverityChip,
  StatusPill,
} from "@/components/ui/Indicators";
import {
  IconChevronDown,
  IconChevronUp,
  IconComment,
  IconEmptyBox,
  IconParent,
  IconSubIssue,
} from "@/components/ui/Icon";
import { isClosedStatus } from "@/lib/domain";
import { formatDateCompact, formatRelative, isOverdue } from "@/lib/format";
import type { IssueListResult, SortField } from "@/server/queries/issues";
import { IssueRowActions } from "@/components/issues/IssueRowActions";

/**
 * The issue table (§27), shared by /issues, /bugs, /my-work and /search.
 *
 * Server-rendered: sorting and paging are links, so the list works without
 * JavaScript and every view is addressable by URL.
 */

interface Column {
  field: SortField | null;
  label: string;
  className?: string;
}

const COLUMNS: Column[] = [
  { field: "key", label: "Key", className: "prio-col-key" },
  { field: "title", label: "Summary" },
  { field: "status", label: "Status", className: "prio-col-status" },
  { field: "priority", label: "Priority", className: "prio-col-priority" },
  { field: "severity", label: "Severity", className: "prio-col-severity" },
  { field: null, label: "Assignee", className: "prio-col-person" },
  { field: null, label: "Reporter", className: "prio-col-person" },
  { field: "due", label: "Due", className: "prio-col-date" },
  { field: "updated", label: "Updated", className: "prio-col-date" },
  { field: null, label: "", className: "prio-col-actions" },
];

function buildHref(
  basePath: string,
  searchParams: Record<string, string | string[] | undefined>,
  overrides: Record<string, string | undefined>,
): string {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(searchParams)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) params.append(key, v);
    else params.set(key, value);
  }

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) params.delete(key);
    else params.set(key, value);
  }

  const qs = params.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

export interface IssueTableProps {
  result: IssueListResult;
  basePath: string;
  searchParams: Record<string, string | string[] | undefined>;
  sort: SortField;
  dir: "asc" | "desc";
  /** Hides the severity column on surfaces with no bugs. */
  showSeverity?: boolean;
  emptyTitle?: string;
  emptyBody?: string;
  emptyAction?: React.ReactNode;
  /**
   * Who is looking at the table, so each row's ⋮ menu can decide for itself
   * whether Delete belongs on it — the reporter and an administrator get it,
   * everyone else gets Open/Edit only. Optional because a handful of surfaces
   * that reuse this table (search results, for instance) render outside a
   * signed-in context where row actions do not apply.
   */
  currentUser?: { id: string; isAdmin: boolean };
}

export function IssueTable({
  result,
  basePath,
  searchParams,
  sort,
  dir,
  showSeverity = true,
  emptyTitle = "No issues found",
  emptyBody = "Create an issue to start tracking work.",
  emptyAction,
  currentUser,
}: IssueTableProps) {
  if (result.rows.length === 0) {
    return (
      <div className="prio-card">
        <EmptyState
          icon={<IconEmptyBox />}
          title={emptyTitle}
          body={emptyBody}
          actions={emptyAction}
        />
      </div>
    );
  }

  const columns = COLUMNS.filter(
    (c) => showSeverity || c.field !== "severity",
  );

  return (
    <>
      <div className="prio-table-wrap prio-scroll">
        <table className="prio-table prio-table--compact">
          <thead>
            <tr>
              {columns.map((column) => {
                if (!column.field) {
                  return (
                    <th key={column.label} className={column.className} scope="col">
                      {column.label || (
                        <span className="prio-visually-hidden">Actions</span>
                      )}
                    </th>
                  );
                }

                const active = sort === column.field;
                const nextDir = active && dir === "desc" ? "asc" : "desc";

                return (
                  <th key={column.label} className={column.className} scope="col"
                      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}>
                    <Link
                      href={buildHref(basePath, searchParams, {
                        sort: column.field,
                        dir: nextDir,
                        page: undefined,
                      })}
                      className="prio-table__sort"
                      scroll={false}
                    >
                      {column.label}
                      {active ? (
                        dir === "asc" ? (
                          <IconChevronUp size={11} />
                        ) : (
                          <IconChevronDown size={11} />
                        )
                      ) : null}
                    </Link>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((issue) => {
              const closed = isClosedStatus(issue.status);
              const overdue = isOverdue(issue.dueDate, closed);
              const mine = issue.assignee?.id === currentUser?.id;

              return (
                <tr key={issue.id} data-mine={mine || undefined}>
                  <td className="prio-col-key">
                    <Link
                      href={`/issues/${issue.key.toLowerCase()}`}
                      className="prio-issuelink"
                    >
                      <IssueTypeIcon type={issue.type} size={17} />
                      <IssueKey issueKey={issue.key} />
                    </Link>
                  </td>

                  <td>
                    <Link
                      href={`/issues/${issue.key.toLowerCase()}`}
                      className="prio-issuetitle"
                    >
                      {issue.title}
                    </Link>
                    <span className="prio-issuemeta">
                      {issue.parent ? (
                        <span
                          className="prio-issuemeta__item"
                          title={`Sub-issue of ${issue.parent.key}`}
                        >
                          <IconParent size={11} />
                          {issue.parent.key}
                        </span>
                      ) : null}
                      {issue._count.children > 0 ? (
                        <span
                          className="prio-issuemeta__item"
                          title={`${issue._count.children} sub-issues`}
                        >
                          <IconSubIssue size={11} />
                          {issue._count.children}
                        </span>
                      ) : null}
                      {issue._count.comments > 0 ? (
                        <span
                          className="prio-issuemeta__item"
                          title={`${issue._count.comments} comments`}
                        >
                          <IconComment size={11} />
                          {issue._count.comments}
                        </span>
                      ) : null}
                      {issue.labels.map(({ label }) => (
                        <LabelChip
                          key={label.id}
                          name={label.name}
                          color={label.color}
                        />
                      ))}
                    </span>
                  </td>

                  <td className="prio-col-status">
                    <StatusPill status={issue.status} />
                  </td>

                  <td className="prio-col-priority">
                    <PriorityIndicator priority={issue.priority} />
                  </td>

                  {showSeverity ? (
                    <td className="prio-col-severity">
                      {issue.severity ? (
                        <SeverityChip severity={issue.severity} />
                      ) : (
                        <span className="prio-text-disabled">—</span>
                      )}
                    </td>
                  ) : null}

                  <td className="prio-col-person">
                    {issue.assignee ? (
                      <span className="prio-person">
                        <Avatar
                          name={issue.assignee.name}
                          image={issue.assignee.image}
                          size="xs"
                        />
                        <span className="prio-truncate">
                          {issue.assignee.name}
                        </span>
                        {mine ? (
                          <span
                            className="prio-badge prio-badge--pill"
                            data-tone="brand"
                          >
                            You
                          </span>
                        ) : null}
                      </span>
                    ) : (
                      <span className="prio-person">
                        <Avatar name={null} size="xs" empty />
                        <span className="prio-text-disabled">Unassigned</span>
                      </span>
                    )}
                  </td>

                  {/* Who raised it. `reporterId` is required on an issue and
                      the relation is never optional, so there is no
                      "unreported" state to render — but the name is shown
                      defensively in case the account was removed. */}
                  <td className="prio-col-person">
                    <span className="prio-person">
                      <Avatar
                        name={issue.reporter?.name ?? null}
                        image={issue.reporter?.image ?? null}
                        size="xs"
                        empty={!issue.reporter}
                      />
                      <span className="prio-truncate">
                        {issue.reporter?.name ?? "Unknown"}
                      </span>
                    </span>
                  </td>

                  <td className="prio-col-date">
                    {issue.dueDate ? (
                      <span className={overdue ? "prio-due--overdue" : undefined}>
                        {formatDateCompact(issue.dueDate)}
                      </span>
                    ) : (
                      <span className="prio-text-disabled">—</span>
                    )}
                  </td>

                  <td className="prio-col-date prio-text-muted">
                    {formatRelative(issue.updatedAt)}
                  </td>

                  <td className="prio-col-actions">
                    {currentUser ? (
                      <IssueRowActions
                        issueId={issue.id}
                        issueKey={issue.key}
                        reporterId={issue.reporter.id}
                        currentUserId={currentUser.id}
                        isAdmin={currentUser.isAdmin}
                      />
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Pagination
        result={result}
        basePath={basePath}
        searchParams={searchParams}
      />
    </>
  );
}

function Pagination({
  result,
  basePath,
  searchParams,
}: {
  result: IssueListResult;
  basePath: string;
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const { page, pageCount, total, pageSize } = result;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(total, page * pageSize);

  return (
    <nav className="prio-pagination" aria-label="Pagination">
      <span className="prio-pagination__summary">
        {first}–{last} of {total}
      </span>

      <div className="prio-pagination__controls">
        <Link
          href={buildHref(basePath, searchParams, {
            page: String(Math.max(1, page - 1)),
          })}
          className="prio-btn prio-btn--secondary prio-btn--sm"
          aria-disabled={page <= 1}
          tabIndex={page <= 1 ? -1 : undefined}
          scroll={false}
        >
          Previous
        </Link>

        <span className="prio-pagination__page">
          Page {page} of {pageCount}
        </span>

        <Link
          href={buildHref(basePath, searchParams, {
            page: String(Math.min(pageCount, page + 1)),
          })}
          className="prio-btn prio-btn--secondary prio-btn--sm"
          aria-disabled={page >= pageCount}
          tabIndex={page >= pageCount ? -1 : undefined}
          scroll={false}
        >
          Next
        </Link>
      </div>

      <div className="prio-pagination__size">
        <span className="prio-text-muted">Per page</span>
        {[25, 50, 100].map((size) => (
          <Link
            key={size}
            href={buildHref(basePath, searchParams, {
              pageSize: String(size),
              page: undefined,
            })}
            className="prio-segmented__item"
            data-active={pageSize === size}
            scroll={false}
          >
            {size}
          </Link>
        ))}
      </div>
    </nav>
  );
}
