import type { Metadata } from "next";
import { IssueFilters } from "@/components/issues/IssueFilters";
import { IssueTable } from "@/components/issues/IssueTable";
import { filterOptions, listIssues } from "@/server/queries/issues";
import { parseIssueParams, type SearchParams } from "@/server/queries/params";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "Issues" };
export const dynamic = "force-dynamic";

/**
 * The global issue list (§27). Every task, story and bug the caller can see,
 * filtered and sorted entirely server-side from the URL.
 */
export default async function IssuesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const filters = parseIssueParams(params);

  const [result, options] = await Promise.all([
    listIssues(user, filters),
    filterOptions(user),
  ]);

  return (
    <>
      <div className="prio-page-header">
        <div className="prio-page-header__text">
          <h1 className="prio-page-header__title">Issues</h1>
          <p className="prio-page-header__subtitle">
            Tasks, stories and bugs across every project you can see.
          </p>
        </div>
      </div>

      <IssueFilters
        projects={options.projects}
        people={options.people}
        labels={options.labels}
        currentUserId={user.id}
        total={result.total}
        enableExport
        enableShare
        isAdmin={user.role === "ADMIN"}
      />

      <IssueTable
        result={result}
        basePath="/issues"
        searchParams={params}
        sort={filters.sort ?? "updated"}
        dir={filters.dir ?? "desc"}
        emptyTitle="No issues found"
        emptyBody="No issue matches these filters. Clear them, or create an issue to start tracking work."
        currentUser={{ id: user.id, isAdmin: user.role === "ADMIN" }}
      />
    </>
  );
}
