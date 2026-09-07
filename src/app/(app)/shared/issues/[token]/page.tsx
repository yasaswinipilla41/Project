import type { Metadata } from "next";
import { IssueFilters } from "@/components/issues/IssueFilters";
import { IssueTable } from "@/components/issues/IssueTable";
import { Card, EmptyState, ButtonLink } from "@/components/ui/primitives";
import { IconLink, IconWarning } from "@/components/ui/Icon";
import { AuthorizationError, NotFoundError } from "@/lib/authz";
import { requireUser } from "@/lib/session";
import { assertShareAccess } from "@/server/shares";
import { filterOptions, listIssues } from "@/server/queries/issues";
import { parseIssueParams, type SearchParams } from "@/server/queries/params";

export const metadata: Metadata = { title: "Shared Issues Sheet" };
export const dynamic = "force-dynamic";

/**
 * The shared, view-only Issues Sheet (§ Share Issue Sheet). Reachable only by
 * an administrator or someone explicitly granted access — see
 * `assertShareAccess`. Every other visitor gets an access-denied state with
 * no issue data anywhere in the response, not even in a hidden field.
 *
 * The list itself is `listIssues`/`filterOptions` called exactly as `/issues`
 * calls them, scoped by the *viewer's own* role and project memberships —
 * this link never shows anyone a project they could not already open. The
 * table renders without `currentUser`, which hides row actions (§27), so the
 * shared view cannot be used to edit, delete or reassign anything.
 */
export default async function SharedIssuesPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { token } = await params;
  const user = await requireUser(`/shared/issues/${token}`);

  try {
    await assertShareAccess(user, token);
  } catch (error) {
    if (error instanceof AuthorizationError || error instanceof NotFoundError) {
      return (
        <Card>
          <EmptyState
            icon={<IconWarning />}
            title="You don't have access to this shared sheet"
            body="Ask whoever shared it with you for a new link, or head back to Prio."
            actions={
              <ButtonLink href="/issues" variant="brand">
                Back to Prio
              </ButtonLink>
            }
          />
        </Card>
      );
    }
    throw error;
  }

  const sp = await searchParams;
  const filters = parseIssueParams(sp);
  const basePath = `/shared/issues/${token}`;

  const [result, options] = await Promise.all([
    listIssues(user, filters),
    filterOptions(user),
  ]);

  return (
    <>
      <div className="prio-page-header">
        <div className="prio-page-header__text">
          <h1 className="prio-page-header__title">
            <IconLink />
            Shared Issues Sheet
          </h1>
          <p className="prio-page-header__subtitle">
            A view-only copy of the live Issues Sheet, shared with you.
          </p>
        </div>
      </div>

      {/*
       * The sheet somebody was given, with the download that makes it a sheet.
       *
       * `enableExport` turns on the Export Excel control `/issues` already
       * has — the same button, the same `/api/issues/export` route, the same
       * workbook. Sharing an Issues Sheet and then offering no way to take it
       * away was the gap; this closes it by opting in rather than by building
       * a second export.
       *
       * Safe to switch on here because the route authorizes for itself: it
       * resolves the caller server-side and builds its rows through the same
       * `buildIssueWhere` this page's `listIssues` uses, so a recipient
       * downloads exactly the issues they may already read on this page and
       * nothing else. Being on the share does not widen that.
       */}
      <IssueFilters
        projects={options.projects}
        people={options.people}
        labels={options.labels}
        currentUserId={user.id}
        total={result.total}
        enableExport
      />

      <IssueTable
        result={result}
        basePath={basePath}
        searchParams={sp}
        sort={filters.sort ?? "updated"}
        dir={filters.dir ?? "desc"}
        emptyTitle="No issues found"
        emptyBody="No issue matches these filters."
      />
    </>
  );
}
