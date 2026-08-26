import type { Metadata } from "next";
import Link from "next/link";
import { ActivityFeed } from "@/components/activity/ActivityFeed";
import { ActivityFilters } from "@/components/activity/ActivityFilters";
import { filterOptions } from "@/server/queries/issues";
import {
  listActivity,
  type ActivityFilters as ActivityQueryFilters,
} from "@/server/queries/activity";
import { ACTIVITY_TYPES, type ActivityType } from "@/lib/activity";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "Activity" };
export const dynamic = "force-dynamic";

/**
 * The Activity feed (§ activity follow-up): who assigned what to whom, and
 * every status change, across every project the caller can see. Reads the
 * same `ActivityLogEntry` trail every other activity surface in Prio already
 * reads — nothing is recorded here, only displayed.
 */

type SearchParams = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parseFilters(params: SearchParams): ActivityQueryFilters {
  const typeRaw = one(params.type);
  const type = (ACTIVITY_TYPES as readonly string[]).includes(typeRaw ?? "")
    ? (typeRaw as ActivityType)
    : undefined;

  const pageRaw = Number(one(params.page) ?? "1");
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;

  return {
    q: one(params.q),
    projectId: one(params.project),
    userId: one(params.user),
    type,
    page,
  };
}

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const filters = parseFilters(params);

  const [result, options] = await Promise.all([
    listActivity(user, filters),
    filterOptions(user),
  ]);

  const buildPageHref = (page: number) => {
    const next = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) for (const v of value) next.append(key, v);
      else next.set(key, value);
    }
    if (page <= 1) next.delete("page");
    else next.set("page", String(page));
    const qs = next.toString();
    return qs ? `/activity?${qs}` : "/activity";
  };

  return (
    <>
      <div className="prio-page-header">
        <div className="prio-page-header__text">
          <h1 className="prio-page-header__title">Activity</h1>
          <p className="prio-page-header__subtitle">
            Track project and task activity.
          </p>
        </div>
      </div>

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
