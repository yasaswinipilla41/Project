import type { Metadata } from "next";
import { Card, EmptyState } from "@/components/ui/primitives";
import { IconEmptyBox, IconReports } from "@/components/ui/Icon";
import { InsightsPanel } from "@/components/reports/InsightsPanel";
import { accessibleProjectIds } from "@/lib/authz";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "Reports" };
export const dynamic = "force-dynamic";

/**
 * Reports across every project the caller can see.
 *
 * The aggregations themselves live in `InsightsPanel`, because the Flow Board
 * shows the same thing for a single project and there is no reason for two
 * copies of it. This page is the org-wide scope, its heading, and the empty
 * state for somebody who is not yet in a project.
 */
export default async function ReportsPage() {
  const user = await requireUser();
  const projectIds = await accessibleProjectIds(user);

  return (
    <>
      <div className="prio-page-header">
        <div className="prio-page-header__text">
          <h1 className="prio-page-header__title">
            <IconReports />
            Reports
          </h1>
          {projectIds.length > 0 ? (
            <p className="prio-page-header__subtitle">
              Live aggregations across the {projectIds.length}{" "}
              {projectIds.length === 1 ? "project" : "projects"} you can see.
            </p>
          ) : null}
        </div>
      </div>

      {projectIds.length === 0 ? (
        <Card>
          <EmptyState
            icon={<IconEmptyBox />}
            title="No projects yet"
            body="Reports appear once you are a member of a project with issues in it."
          />
        </Card>
      ) : (
        <InsightsPanel projectIds={projectIds} />
      )}
    </>
  );
}
