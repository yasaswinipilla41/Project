import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { IssueFilters } from "@/components/issues/IssueFilters";
import { IssueTable } from "@/components/issues/IssueTable";
import { filterOptions, listIssues } from "@/server/queries/issues";
import { parseIssueParams, type SearchParams } from "@/server/queries/params";
import { projectScope, workRoleOf } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "List" };
export const dynamic = "force-dynamic";

/**
 * The project's issues, as a list.
 *
 * The List tab used to send people to `/issues?project=<id>` — the global list
 * with a filter — which meant leaving the project shell to see the project's
 * own issues. This is the same list, rendered inside the project instead: the
 * same `IssueFilters` and `IssueTable` the global page uses, reading the same
 * `listIssues` query. Nothing about the list is reimplemented here.
 *
 * The project is pinned into the filters rather than offered as one, so this
 * view can only ever show the project whose tab it sits under. Everything else
 * — status, assignee, labels, sort, paging — still comes from the URL exactly
 * as it does on the global page.
 */
export default async function ProjectListPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { key } = await params;
  const user = await requireUser();
  const query = await searchParams;

  const project = await prisma.project.findFirst({
    where: { key: key.toUpperCase(), ...projectScope(user) },
    select: { id: true, key: true },
  });
  if (!project) notFound();

  /* The project is fixed by the route, so it overrides whatever the query
     string says — a hand-edited `?project=` cannot widen this view. */
  const filters = { ...parseIssueParams(query), projectIds: [project.id] };

  const [result, options] = await Promise.all([
    listIssues(user, filters),
    filterOptions(user),
  ]);

  return (
    <>
      <IssueFilters
        projects={options.projects}
        /* The project is fixed by the route, so the bar does not offer one to
           choose. Every other control on it — search, status, type, priority,
           assignee, reporter, labels, resolution — is untouched. */
        showProjectFilter={false}
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
        basePath={`/projects/${project.key.toLowerCase()}/list`}
        searchParams={query}
        sort={filters.sort ?? "updated"}
        dir={filters.dir ?? "desc"}
        emptyTitle="No issues found"
        emptyBody="No issue in this project matches these filters. Clear them to see everything here."
        currentUser={{
          id: user.id,
          isAdmin: user.role === "ADMIN",
          workRole: await workRoleOf(user),
        }}
      />
    </>
  );
}
