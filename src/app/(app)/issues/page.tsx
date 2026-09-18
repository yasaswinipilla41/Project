import type { Metadata } from "next";
import { cookies } from "next/headers";
import { BackLink } from "@/components/shell/BackLink";
import { IssueFilters } from "@/components/issues/IssueFilters";
import { IssueTable } from "@/components/issues/IssueTable";
import { filterOptions, listIssues } from "@/server/queries/issues";
import { parseIssueParams, type SearchParams } from "@/server/queries/params";
import { requireUser } from "@/lib/session";
import { workRoleOf } from "@/lib/authz";
import { COLUMN_COOKIE, parseColumnPreference } from "@/lib/tableColumns";

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

  /* Read here so the table below is rendered with the right columns rather
     than rendered whole and trimmed in the browser — see `lib/tableColumns`. */
  const columns = parseColumnPreference(
    (await cookies()).get(COLUMN_COOKIE)?.value,
  );

  const [result, options] = await Promise.all([
    listIssues(user, filters),
    filterOptions(user),
  ]);

  return (
    <>
      {/* Reached from Administration's Users/Projects/Issues/Bugs blocks,
          which say so in the query string. Shown only then: this page is
          reached from the sidebar too, where there is no Administration to go
          back to and a control claiming otherwise would be a lie. */}
      {params.from === "admin" ? (
        <BackLink href="/admin" label="Back to Administration" />
      ) : null}

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
        enableImport
        enableShare
        isAdmin={user.role === "ADMIN"}
        columns={columns}
      />

      <IssueTable
        result={result}
        basePath="/issues"
        searchParams={params}
        sort={filters.sort ?? "updated"}
        dir={filters.dir ?? "desc"}
        emptyTitle="No issues found"
        emptyBody="No issue matches these filters. Clear them, or create an issue to start tracking work."
        visibleColumns={columns}
        currentUser={{
          id: user.id,
          isAdmin: user.role === "ADMIN",
          workRole: await workRoleOf(user),
        }}
      />
    </>
  );
}
