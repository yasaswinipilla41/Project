"use client";

import Link from "next/link";
import { Fragment, useState } from "react";
import { Avatar, EmptyState } from "@/components/ui/primitives";
import {
  IssueKey,
  IssueTypeIcon,
  LabelChip,
  PriorityIndicator,
  StatusPill,
} from "@/components/ui/Indicators";
import {
  IconChevronDown,
  IconChevronRight,
  IconChevronUp,
  IconEmptyBox,
} from "@/components/ui/Icon";
import { IssueRowActions } from "@/components/issues/IssueRowActions";
import { formatDateCompact, formatRelative, isOverdue } from "@/lib/format";
import { ISSUE_TYPE_LABEL, isClosedStatus, type WorkRole } from "@/lib/domain";
import type { IssueListRow, SortField } from "@/server/queries/issues";

export interface WorkTableRow extends IssueListRow {
  /** Closed sub-issues over total, or null where an issue has no sub-issues. */
  progress: { done: number; total: number } | null;
  description: string | null;
}

interface Column {
  field: SortField | null;
  label: string;
  className?: string;
}

/*
 * One header row, fixed column widths, and every cell in a column aligned the
 * same way down the table. Only the columns that genuinely sort carry a link —
 * a header that looks clickable and does nothing is worse than a plain one.
 */
const COLUMNS: Column[] = [
  { field: null, label: "", className: "prio-col-expand" },
  { field: "key", label: "Work item" },
  { field: "status", label: "Status", className: "prio-col-status" },
  { field: null, label: "Progress", className: "prio-col-progress" },
  { field: "due", label: "Due", className: "prio-col-date" },
  { field: null, label: "Assignee", className: "prio-col-person" },
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

/**
 * A project's work items as one scannable table.
 *
 * Built on the same `listIssues` result the Issues page uses, so sorting,
 * filtering and access scoping are the existing ones rather than a second
 * implementation. Sorting travels in the URL, which keeps a sorted view
 * shareable and working without JavaScript; only the expanded/collapsed state
 * is client-side, because it is a per-person reading preference rather than
 * something worth putting in a link.
 */
export function ProjectWorkTable({
  rows,
  basePath,
  searchParams,
  sort,
  dir,
  currentUserId,
  isAdmin,
  workRole,
}: {
  rows: WorkTableRow[];
  basePath: string;
  searchParams: Record<string, string | string[] | undefined>;
  sort: SortField;
  dir: "asc" | "desc";
  currentUserId: string;
  isAdmin: boolean;
  /** Cloning from a row files new work; the dialog follows the job. */
  workRole: WorkRole;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  if (rows.length === 0) {
    return (
      <div className="prio-worktable__empty">
        <EmptyState
          icon={<IconEmptyBox />}
          title="No work items yet"
          body="Work assigned to you or created in this project will appear here."
        />
      </div>
    );
  }

  return (
    <div className="prio-table-wrap prio-scroll">
      <table className="prio-table prio-worktable">
        <thead>
          <tr>
            {COLUMNS.map((column) => {
              if (!column.field) {
                return (
                  <th
                    key={column.label || column.className}
                    className={column.className}
                    scope="col"
                  >
                    {column.label || (
                      <span className="prio-visually-hidden">
                        {column.className === "prio-col-expand"
                          ? "Expand"
                          : "Actions"}
                      </span>
                    )}
                  </th>
                );
              }

              const active = sort === column.field;
              const nextDir = active && dir === "desc" ? "asc" : "desc";

              return (
                <th
                  key={column.label}
                  className={column.className}
                  scope="col"
                  aria-sort={
                    active
                      ? dir === "asc"
                        ? "ascending"
                        : "descending"
                      : "none"
                  }
                >
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
          {rows.map((issue) => {
            const open = expanded.has(issue.id);
            const closed = isClosedStatus(issue.status);
            const overdue = isOverdue(issue.dueDate, closed);
            const pct = issue.progress
              ? Math.round((issue.progress.done / issue.progress.total) * 100)
              : null;

            return (
              /* The key belongs on the fragment: each item renders two rows,
                 and React reconciles the pair, not the first of them. */
              <Fragment key={issue.id}>
                <tr className="prio-worktable__row">
                  <td className="prio-col-expand">
                    <button
                      type="button"
                      className="prio-worktable__expand"
                      aria-expanded={open}
                      aria-label={`${open ? "Collapse" : "Expand"} ${issue.key}`}
                      onClick={() => toggle(issue.id)}
                    >
                      {open ? (
                        <IconChevronDown size={14} />
                      ) : (
                        <IconChevronRight size={14} />
                      )}
                    </button>
                  </td>

                  <td>
                    <span className="prio-worktable__item">
                      <IssueTypeIcon type={issue.type} size={15} />
                      <Link
                        href={`/issues/${issue.key.toLowerCase()}`}
                        className="prio-worktable__key"
                      >
                        <IssueKey issueKey={issue.key} />
                      </Link>
                      <Link
                        href={`/issues/${issue.key.toLowerCase()}`}
                        className="prio-worktable__title prio-truncate"
                      >
                        {issue.title}
                      </Link>
                    </span>
                  </td>

                  <td className="prio-col-status">
                    <StatusPill status={issue.status} />
                  </td>

                  <td className="prio-col-progress">
                    {/* Only where sub-issues exist. An issue with none has no
                        progress to report, and 0% would be a claim. */}
                    {issue.progress && pct !== null ? (
                      <span
                        className="prio-worktable__progress"
                        title={`${issue.progress.done} of ${issue.progress.total} sub-issues done`}
                      >
                        <span className="prio-progress" aria-hidden>
                          <span
                            className="prio-progress__bar"
                            style={{ width: `${pct}%` }}
                          />
                        </span>
                        <span className="prio-worktable__pct">{pct}%</span>
                      </span>
                    ) : (
                      <span className="prio-text-muted">—</span>
                    )}
                  </td>

                  <td className="prio-col-date">
                    {issue.dueDate ? (
                      <span data-overdue={overdue || undefined}>
                        {formatDateCompact(issue.dueDate)}
                      </span>
                    ) : (
                      <span className="prio-text-muted">—</span>
                    )}
                  </td>

                  <td className="prio-col-person">
                    {issue.assignee ? (
                      <span className="prio-worktable__person">
                        <Avatar
                          name={issue.assignee.name}
                          image={issue.assignee.image}
                          size="xs"
                        />
                        <span className="prio-truncate">
                          {issue.assignee.name}
                        </span>
                      </span>
                    ) : (
                      <span className="prio-text-muted">Unassigned</span>
                    )}
                  </td>

                  <td className="prio-col-date">
                    {formatRelative(issue.updatedAt)}
                  </td>

                  <td className="prio-col-actions">
                    <IssueRowActions
                      issueId={issue.id}
                      issueKey={issue.key}
                      reporterId={issue.reporter.id}
                      currentUserId={currentUserId}
                      isAdmin={isAdmin}
                      workRole={workRole}
                    />
                  </td>
                </tr>

                {open ? (
                  <tr className="prio-worktable__detailrow">
                    <td />
                    <td colSpan={COLUMNS.length - 1}>
                      <div className="prio-worktable__detail">
                        <dl className="prio-worktable__facts">
                          <div>
                            <dt>Type</dt>
                            <dd>{ISSUE_TYPE_LABEL[issue.type]}</dd>
                          </div>
                          <div>
                            <dt>Priority</dt>
                            <dd>
                              <PriorityIndicator priority={issue.priority} />
                            </dd>
                          </div>
                          <div>
                            <dt>Reporter</dt>
                            <dd>{issue.reporter.name}</dd>
                          </div>
                          {issue.parent ? (
                            <div>
                              <dt>Parent</dt>
                              <dd>
                                <Link
                                  href={`/issues/${issue.parent.key.toLowerCase()}`}
                                >
                                  <IssueKey issueKey={issue.parent.key} />
                                </Link>
                              </dd>
                            </div>
                          ) : null}
                        </dl>

                        {issue.labels.length > 0 ? (
                          <div className="prio-worktable__labels">
                            {issue.labels.map(({ label }) => (
                              <LabelChip
                                key={label.id}
                                name={label.name}
                                color={label.color}
                              />
                            ))}
                          </div>
                        ) : null}

                        {issue.description ? (
                          <p className="prio-worktable__desc">
                            {issue.description}
                          </p>
                        ) : (
                          <p className="prio-worktable__desc prio-text-muted">
                            No description.
                          </p>
                        )}
                      </div>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
