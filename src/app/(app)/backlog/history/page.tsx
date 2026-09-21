import type { Metadata } from "next";
import { AssignmentHistoryView } from "@/components/backlog/AssignmentHistoryView";
import { requireUser } from "@/lib/session";
import { listAssignmentHistory } from "@/server/queries/assignmentHistory";
import { filterOptions } from "@/server/queries/issues";
import { parseAssignmentHistoryParams } from "@/server/queries/params";
import type { SearchParams } from "@/server/queries/params";

export const metadata: Metadata = { title: "Backlog History" };
export const dynamic = "force-dynamic";

/**
 * Backlog History across every project the reader can open.
 *
 * The same view and the same query as a project's own history page; what
 * differs is only the scope it is asked for and the project column it
 * therefore shows. Scope is the database's — `listAssignmentHistory` bounds
 * every row by `issueScope` — so this page cannot show a hand-over in a
 * project somebody was never given.
 */
export default async function BacklogHistoryPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireUser();
  const query = await searchParams;

  const [result, options] = await Promise.all([
    listAssignmentHistory(user, parseAssignmentHistoryParams(query)),
    filterOptions(user),
  ]);

  return (
    <>
      <div className="prio-page-header">
        <div className="prio-page-header__text">
          <h1 className="prio-page-header__title">Backlog History</h1>
          <p className="prio-page-header__subtitle">
            Every time work changed hands across your projects — who it came
            from, who it went to, and whether a person or Prio decided.
          </p>
        </div>
      </div>

      <AssignmentHistoryView
        result={result}
        people={options.people}
        showProject
        basePath="/backlog/history"
        searchParams={query}
      />
    </>
  );
}
