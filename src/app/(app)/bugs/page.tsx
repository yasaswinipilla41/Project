import type { Metadata } from "next";
import { IssueFilters } from "@/components/issues/IssueFilters";
import { IssueTable } from "@/components/issues/IssueTable";
import { Stat } from "@/components/ui/primitives";
import { IconBug } from "@/components/ui/Icon";
import { filterOptions, listIssues } from "@/server/queries/issues";
import { parseIssueParams, type SearchParams } from "@/server/queries/params";
import { OPEN_STATUSES } from "@/lib/domain";
import { prisma } from "@/lib/prisma";
import { issueScope } from "@/lib/authz";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "Bugs" };
export const dynamic = "force-dynamic";

/**
 * The dedicated Bugs view (§12).
 *
 * A bug is `Issue.type = BUG` — the same table, the same list machinery, with
 * the type locked and severity given prominence.
 */
export default async function BugsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const user = await requireUser();
  const params = await searchParams;
  const filters = { ...parseIssueParams(params), lockedType: "BUG" as const };

  const scope = issueScope(user);

  const [result, options, total, open, critical, mine] = await Promise.all([
    listIssues(user, filters),
    filterOptions(user),
    prisma.issue.count({ where: { ...scope, type: "BUG" } }),
    prisma.issue.count({
      where: { ...scope, type: "BUG", status: { in: [...OPEN_STATUSES] } },
    }),
    prisma.issue.count({
      where: {
        ...scope,
        type: "BUG",
        severity: "CRITICAL",
        status: { in: [...OPEN_STATUSES] },
      },
    }),
    prisma.issue.count({
      where: {
        ...scope,
        type: "BUG",
        assigneeId: user.id,
        status: { in: [...OPEN_STATUSES] },
      },
    }),
  ]);

  return (
    <>
      <div className="prio-page-header">
        <div className="prio-page-header__text">
          <h1 className="prio-page-header__title">
            <IconBug />
            Bugs
          </h1>
          <p className="prio-page-header__subtitle">
            Every defect being tracked, with severity alongside priority.
          </p>
        </div>
      </div>

      <div className="row g-3" style={{ marginBottom: "var(--prio-space-6)" }}>
        <div className="col-6 col-xl-3">
          <Stat label="Total bugs" value={total} hint="All statuses" />
        </div>
        <div className="col-6 col-xl-3">
          <Stat label="Open" value={open} tone="brand" hint="Not resolved or cancelled" />
        </div>
        <div className="col-6 col-xl-3">
          <Stat
            label="Critical open"
            value={critical}
            tone={critical > 0 ? "danger" : "default"}
            hint="Severity Critical"
          />
        </div>
        <div className="col-6 col-xl-3">
          <Stat label="Assigned to me" value={mine} hint="Open bugs" />
        </div>
      </div>

      <IssueFilters
        projects={options.projects}
        people={options.people}
        labels={options.labels}
        showTypeFilter={false}
        currentUserId={user.id}
        total={result.total}
      />

      <IssueTable
        result={result}
        basePath="/bugs"
        searchParams={params}
        sort={filters.sort ?? "updated"}
        dir={filters.dir ?? "desc"}
        emptyTitle="No bugs found"
        emptyBody="No bug matches these filters. Create a bug to start tracking defects."
        currentUser={{ id: user.id, isAdmin: user.role === "ADMIN" }}
      />
    </>
  );
}
