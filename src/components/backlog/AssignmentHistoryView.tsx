import Link from "next/link";
import { Card, EmptyState } from "@/components/ui/primitives";
import { IconEmptyBox } from "@/components/ui/Icon";
import { IssueKey } from "@/components/ui/Indicators";
import { formatDateTime } from "@/lib/format";
import type { AssignmentHistoryResult } from "@/server/queries/assignmentHistory";
import {
  AssignmentHistoryFilters,
  type HistoryPerson,
} from "./AssignmentHistoryFilters";

/**
 * Backlog History: every hand-over of work, and who decided it.
 *
 * A table rather than a feed of sentences, because the questions asked of it
 * are comparative — who has been getting everything, how much of this is Prio
 * deciding rather than people, when did this start — and those are read down
 * a column, not along a paragraph.
 *
 * Six columns and no more (seven where the project has to be named). It is
 * deliberately not a second Work Items list:
 * the title is here to identify a row, not to be worked from, and everything
 * else about an item is one click away on the item itself.
 */

export function AssignmentHistoryView({
  result,
  people,
  showProject,
  basePath,
  searchParams,
}: {
  result: AssignmentHistoryResult;
  people: HistoryPerson[];
  /** Cross-project surfaces name the project; a project's own does not. */
  showProject: boolean;
  /** Where paging links point, without the query string. */
  basePath: string;
  /** What is already filtered, so paging keeps it. */
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const { rows, page, pageCount, total } = result;

  /*
   * Whether anything is narrowing the list.
   *
   * Read from the URL rather than from `total`, which is the count *after*
   * the filters have been applied — so a filter matching nothing gives
   * `total === 0` exactly as an empty project does, and the two situations
   * are indistinguishable from it. They need different sentences: one says
   * nothing has happened yet, the other says your filter is too narrow, and
   * showing the first to somebody who has just filtered is misleading.
   */
  const FILTER_KEYS = ["q", "kind", "user", "from", "to"] as const;
  const filtered = FILTER_KEYS.some((key) => {
    const value = searchParams[key];
    return Array.isArray(value) ? value.length > 0 : Boolean(value);
  });

  /*
   * A page link that keeps every filter that is already on.
   *
   * Paging that quietly cleared the filters would take somebody who had
   * narrowed to one person's week and, on page two, show them everything —
   * which reads as the filter having failed rather than as the link having
   * dropped it.
   */
  const hrefForPage = (next: number) => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(searchParams)) {
      if (key === "page" || value === undefined) continue;
      for (const one of Array.isArray(value) ? value : [value]) {
        query.append(key, one);
      }
    }
    if (next > 1) query.set("page", String(next));

    const text = query.toString();
    return text ? `${basePath}?${text}` : basePath;
  };

  return (
    <>
      <AssignmentHistoryFilters people={people} total={total} />

      {rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={<IconEmptyBox />}
            title="No assignments to show"
            body={
              filtered
                ? "No assignment matches these filters. Clear them to see the rest."
                : "Nothing has been assigned or reassigned here yet. When work changes hands — by somebody choosing, or by Prio returning it — the hand-over is recorded here."
            }
          />
        </Card>
      ) : (
        <Card>
          <div className="prio-table-wrap prio-scroll">
            <table className="prio-table">
              <thead>
                <tr>
                  <th scope="col">Work Item</th>
                  {showProject ? <th scope="col">Project</th> : null}
                  <th scope="col">Previous Assignee</th>
                  <th scope="col">Assigned To</th>
                  {/* Named in full. The requirement's column list calls it
                      Assignment Type, and "Type" beside a work item reads as
                      Task / Bug / Story, which is a different column this
                      table deliberately does not have. */}
                  <th scope="col">Assignment Type</th>
                  <th scope="col">Assigned By</th>
                  <th scope="col">Date &amp; Time</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      {/* The key and the title, and the key is the link — the
                          same way an item is identified everywhere else, and
                          through the same route. */}
                      <Link
                        href={`/issues/${row.issue.key.toLowerCase()}`}
                        className="prio-historylink"
                      >
                        <IssueKey issueKey={row.issue.key} />
                        <span className="prio-truncate">{row.issue.title}</span>
                      </Link>
                    </td>
                    {showProject ? (
                      <td className="prio-text-muted">{row.project.key}</td>
                    ) : null}
                    <td>
                      {row.previousAssignee ? (
                        row.previousAssignee.name
                      ) : (
                        <span className="prio-text-muted">Unassigned</span>
                      )}
                    </td>
                    <td>
                      {row.newAssignee ? (
                        row.newAssignee.name
                      ) : (
                        <span className="prio-text-muted">Unassigned</span>
                      )}
                    </td>
                    <td>
                      <span className="prio-badge" data-kind={row.kind}>
                        {row.kind}
                      </span>
                    </td>
                    {/* Who did it — never who received it. */}
                    <td>{row.actor.name}</td>
                    <td className="prio-col-date prio-text-muted">
                      {formatDateTime(row.at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {pageCount > 1 ? (
        <nav className="prio-pagination" aria-label="Pages">
          <PageLink
            href={hrefForPage(page - 1)}
            disabled={page <= 1}
            label="Previous"
          />
          <span className="prio-text-muted">
            Page {page} of {pageCount}
          </span>
          <PageLink
            href={hrefForPage(page + 1)}
            disabled={page >= pageCount}
            label="Next"
          />
        </nav>
      ) : null}
    </>
  );
}

/**
 * One step through the pages, keeping every filter that is already on.
 *
 * A link rather than a button: paging is navigation, and it should survive a
 * refresh, a middle click and a shared URL like the rest of this page.
 */
function PageLink({
  href,
  disabled,
  label,
}: {
  href: string;
  disabled: boolean;
  label: string;
}) {
  if (disabled) {
    return (
      <span className="prio-btn prio-btn--ghost prio-btn--sm" aria-disabled>
        {label}
      </span>
    );
  }

  return (
    <Link
      href={href}
      className="prio-btn prio-btn--ghost prio-btn--sm"
      scroll={false}
    >
      {label}
    </Link>
  );
}
