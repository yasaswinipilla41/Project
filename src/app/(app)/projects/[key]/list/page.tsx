import type { Metadata } from "next";
import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { IssueFilters } from "@/components/issues/IssueFilters";
import { IssueTable } from "@/components/issues/IssueTable";
import { filterOptions, listIssues } from "@/server/queries/issues";
import { parseIssueParams, type SearchParams } from "@/server/queries/params";
import { projectScope, workRoleOf } from "@/lib/authz";
import { COLUMN_COOKIE, parseColumnPreference } from "@/lib/tableColumns";
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

  /* Read server-side, so this table is rendered with the columns somebody
     chose rather than rendered whole and trimmed afterwards — the sort and
     page links stay plain links, and the list still works without
     JavaScript. */
  const columns = parseColumnPreference((await cookies()).get(COLUMN_COOKIE)?.value);

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
        /* This project's own sprints, by their plain names: the route already
           fixes the project, so prefixing its key would only repeat it. A
           completed one is flagged from its real status, and the dropdown
           marks it with a check. */
        sprints={options.sprints
          .filter((sprint) => sprint.projectId === project.id)
          .map((sprint) => ({
            id: sprint.id,
            name: sprint.name,
            completed: sprint.status === "COMPLETED",
          }))}
        currentUserId={user.id}
        total={result.total}
        enableExport
        enableImport
        enableShare
        isAdmin={user.role === "ADMIN"}
        /* The same chooser and the same cookie the global list uses, so a
           person who hid Reporter there does not meet it again here. */
        columns={columns}
        /* The project is in the route, not the query string. Export sends it
           so the file matches this table rather than every project, and
           Import files the spreadsheet here rather than wherever it says. */
        project={project}
      />

      <IssueTable
        result={result}
        basePath={`/projects/${project.key.toLowerCase()}/list`}
        searchParams={query}
        sort={filters.sort ?? "updated"}
        dir={filters.dir ?? "desc"}
        emptyTitle="No issues found"
        emptyBody="No issue in this project matches these filters. Clear them to see everything here."
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
