import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AssignmentHistoryView } from "@/components/backlog/AssignmentHistoryView";
import { BackLink } from "@/components/shell/BackLink";
import { projectScope } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { listAssignmentHistory } from "@/server/queries/assignmentHistory";
import { filterOptions } from "@/server/queries/issues";
import { parseAssignmentHistoryParams } from "@/server/queries/params";
import type { SearchParams } from "@/server/queries/params";

export const metadata: Metadata = { title: "Backlog History" };
export const dynamic = "force-dynamic";

/**
 * One project's Backlog History.
 *
 * The project is fixed by the route rather than offered as a filter, so this
 * view can only ever show the project whose page it sits under — a
 * hand-edited `?project=` cannot widen it, because the id is not read from the
 * query string at all. Everything else — search, type, person, dates, paging —
 * comes from the URL exactly as it does on the cross-project page.
 */
export default async function ProjectBacklogHistoryPage({
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
    select: { id: true, key: true, name: true },
  });
  if (!project) notFound();

  const [result, options] = await Promise.all([
    listAssignmentHistory(user, {
      ...parseAssignmentHistoryParams(query),
      projectId: project.id,
    }),
    filterOptions(user, [project.id]),
  ]);

  const base = `/projects/${project.key.toLowerCase()}`;

  return (
    <>
      <BackLink href={`${base}/list`} label={`Back to ${project.name}`} />

      <div className="prio-page-header" style={{ marginTop: "var(--prio-space-3)" }}>
        <div className="prio-page-header__text">
          <h1 className="prio-page-header__title">Backlog History</h1>
          <p className="prio-page-header__subtitle">
            Every time work in {project.name} changed hands — who it came from,
            who it went to, and whether a person or Prio decided.
          </p>
        </div>
      </div>

      <AssignmentHistoryView
        result={result}
        people={options.people}
        showProject={false}
        basePath={`${base}/backlog/history`}
        searchParams={query}
      />
    </>
  );
}
