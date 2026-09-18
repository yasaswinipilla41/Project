import Link from "next/link";
import { Card, CardBody, EmptyState } from "@/components/ui/primitives";
import { IconEmptyBox } from "@/components/ui/Icon";
import { formatDateCompact } from "@/lib/format";
import type { SprintView } from "@/server/queries/sprints";

const STATUS_LABEL: Record<SprintView["status"], string> = {
  PLANNED: "Planned",
  ACTIVE: "Active",
  COMPLETED: "Completed",
};

/**
 * The directory's Iterations/Sprints block: one project's sprints, read only.
 *
 * Reuses `SprintView` exactly as `loadSprints` returns it — the same shape
 * the full Sprint Planning page reads — so there is no second notion of what
 * a sprint's stats are. Each row opens the new, lighter Sprint Details page
 * rather than the Planning page: this block is for finding a sprint, not for
 * shaping one, and every role that can see the project may open any row.
 */
export function ProjectSprintsBlock({
  sprints,
  projectName,
  sprintHref = (sprintId) => `/sprints/${sprintId}`,
}: {
  sprints: SprintView[];
  projectName: string;
  /**
   * Where a row leads. Defaults to the standalone `/sprints/:id` page the
   * Projects directory has always used; the project's own Iterations /
   * Sprints page keeps the reader inside the project instead.
   */
  sprintHref?: (sprintId: string) => string;
}) {
  if (sprints.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<IconEmptyBox />}
          title="No sprints yet"
          body={`${projectName} has no sprints planned yet.`}
        />
      </Card>
    );
  }

  return (
    <Card>
      <CardBody>
        <ul className="prio-archivedlist">
          {sprints.map((sprint) => (
            <li key={sprint.id} className="prio-memberrow">
              <span className="prio-sprint__status" data-status={sprint.status}>
                {STATUS_LABEL[sprint.status]}
              </span>
              <span className="prio-memberpicker__text">
                <span className="prio-memberpicker__name">{sprint.name}</span>
                <span className="prio-memberpicker__meta">
                  {formatDateCompact(sprint.startDate)} →{" "}
                  {formatDateCompact(sprint.endDate)} · {sprint.stats.progress}%
                  complete · {sprint.stats.total}{" "}
                  {sprint.stats.total === 1 ? "issue" : "issues"}
                </span>
              </span>
              <Link
                href={sprintHref(sprint.id)}
                className="prio-btn prio-btn--ghost prio-btn--sm"
              >
                View
              </Link>
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}
