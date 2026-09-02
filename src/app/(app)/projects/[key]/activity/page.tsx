import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActivityFeed } from "@/components/activity/ActivityFeed";
import { ActivityFilters } from "@/components/activity/ActivityFilters";
import { filterOptions } from "@/server/queries/issues";
import { listActivity } from "@/server/queries/activity";
import { ACTIVITY_TYPES, type ActivityType } from "@/lib/activity";
import { projectScope } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "Activity" };
export const dynamic = "force-dynamic";

/**
 * The project's activity.
 *
 * The Activity tab used to send people to `/activity?project=<id>` — the
 * global feed with a filter — which meant leaving the project to read its own
 * history. This is the same feed inside the project: the same `listActivity`
 * query and the same `ActivityFilters` and `ActivityFeed` the global page
 * renders, with the project fixed by the route rather than chosen in a menu.
 */

type SearchParams = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ProjectActivityPage({
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

  const typeRaw = one(query.type);
  const type = (ACTIVITY_TYPES as readonly string[]).includes(typeRaw ?? "")
    ? (typeRaw as ActivityType)
    : undefined;

  const pageRaw = Number(one(query.page) ?? "1");
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;

  const [result, options] = await Promise.all([
    listActivity(user, {
      q: one(query.q),
      // Fixed by the route, so this feed can only ever be this project's.
      projectId: project.id,
      userId: one(query.user),
      type,
      page,
    }),
    filterOptions(user),
  ]);

  const base = `/projects/${project.key.toLowerCase()}/activity`;
  const buildPageHref = (next: number) => {
    const search = new URLSearchParams();
    for (const [k, value] of Object.entries(query)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) for (const v of value) search.append(k, v);
      else search.set(k, value);
    }
    if (next <= 1) search.delete("page");
    else search.set("page", String(next));
    const qs = search.toString();
    return qs ? `${base}?${qs}` : base;
  };

  return (
    <>
      <ActivityFilters
        projects={options.projects}
        people={options.people}
        total={result.total}
      />

      <ActivityFeed entries={result.rows} />

      {result.pageCount > 1 ? (
        <nav className="prio-pagination" aria-label="Pagination">
          <span className="prio-pagination__summary">
            {(result.page - 1) * result.pageSize + 1}–
            {Math.min(result.total, result.page * result.pageSize)} of {result.total}
          </span>

          <div className="prio-pagination__controls">
            <Link
              href={buildPageHref(Math.max(1, result.page - 1))}
              className="prio-btn prio-btn--secondary prio-btn--sm"
              aria-disabled={result.page <= 1}
              tabIndex={result.page <= 1 ? -1 : undefined}
              scroll={false}
            >
              Previous
            </Link>

            <span className="prio-pagination__page">
              Page {result.page} of {result.pageCount}
            </span>

            <Link
              href={buildPageHref(Math.min(result.pageCount, result.page + 1))}
              className="prio-btn prio-btn--secondary prio-btn--sm"
              aria-disabled={result.page >= result.pageCount}
              tabIndex={result.page >= result.pageCount ? -1 : undefined}
              scroll={false}
            >
              Next
            </Link>
          </div>
        </nav>
      ) : null}
    </>
  );
}
