import { Card, CardBody } from "@/components/ui/primitives";
import { IconCalendar, IconUsers } from "@/components/ui/Icon";
import { StatusPill } from "@/components/ui/Indicators";
import { ISSUE_STATUSES } from "@/lib/domain";
import { barWidth, formatDateCompact } from "@/lib/format";
import type { SprintView } from "@/server/queries/sprints";

const STATUS_LABEL: Record<SprintView["status"], string> = {
  PLANNED: "Planned",
  ACTIVE: "Active",
  COMPLETED: "Completed",
};

/**
 * A sprint's details, read only: its own card (name, status, goal, dates,
 * stats, progress) plus a bar chart of its issues by status.
 *
 * Shared by both places a sprint has a dedicated details page — reached from
 * the Projects directory's Iterations/Sprints block, and from a project's own
 * Sprints page — so the two never draw a sprint's details differently. Every
 * field is `loadSprints`'s own `SprintView`, the same query the full Sprint
 * Planning page reads; this adds nothing to that shape, only a read-only
 * subset of it and a chart of the same issues. Where the two pages differ —
 * the Back link's destination — is each page's own, not this component's.
 */
export function SprintDetailsView({ sprint }: { sprint: SprintView }) {
  const total = sprint.stats.total;
  const statusCounts = new Map<string, number>();
  for (const issue of sprint.issues) {
    statusCounts.set(issue.status, (statusCounts.get(issue.status) ?? 0) + 1);
  }

  return (
    <>
      <section className="prio-card prio-sprint" data-status={sprint.status}>
        <CardBody>
          <header className="prio-sprint__head">
            <div className="prio-sprint__identity">
              <h1 className="prio-sprint__name">
                {sprint.name}
                <span className="prio-sprint__status" data-status={sprint.status}>
                  {STATUS_LABEL[sprint.status]}
                </span>
              </h1>
              {sprint.goal ? (
                <p className="prio-sprint__goal">{sprint.goal}</p>
              ) : null}
              <p className="prio-sprint__dates">
                <IconCalendar size={13} />
                {formatDateCompact(sprint.startDate)} →{" "}
                {formatDateCompact(sprint.endDate)}
                {sprint.completedAt ? (
                  <span className="prio-text-muted">
                    {" "}
                    · closed {formatDateCompact(sprint.completedAt)}
                  </span>
                ) : null}
              </p>
            </div>
          </header>

          <div className="prio-sprint__summary">
            <span className="prio-sprint__stat">
              <span className="prio-sprint__statvalue">{sprint.stats.total}</span>
              <span className="prio-sprint__statlabel">Total</span>
            </span>
            <span className="prio-sprint__stat" data-tone="success">
              <span className="prio-sprint__statvalue">
                {sprint.stats.completed}
              </span>
              <span className="prio-sprint__statlabel">Completed</span>
            </span>
            <span className="prio-sprint__stat">
              <span className="prio-sprint__statvalue">
                {sprint.stats.remaining}
              </span>
              <span className="prio-sprint__statlabel">Remaining</span>
            </span>
            <span className="prio-sprint__stat">
              <span className="prio-sprint__statvalue">
                {sprint.stats.progress}%
              </span>
              <span className="prio-sprint__statlabel">Progress</span>
            </span>
            <span className="prio-sprint__stat">
              <span className="prio-sprint__statvalue">
                <IconUsers size={13} /> {sprint.stats.assignees}
              </span>
              <span className="prio-sprint__statlabel">Assignees</span>
            </span>
          </div>

          <div
            className="prio-progress"
            role="img"
            aria-label={`${sprint.stats.progress}% of this sprint's work is finished`}
          >
            <div
              className="prio-progress__bar"
              style={{ width: `${sprint.stats.progress}%` }}
            />
          </div>
        </CardBody>
      </section>

      <Card style={{ marginTop: "var(--prio-space-4)" }}>
        <CardBody>
          <h2 className="prio-issue__section-title">Issues by status</h2>
          {total === 0 ? (
            <p className="prio-text-muted">No issues in this sprint yet.</p>
          ) : (
            <ul className="prio-distribution">
              {ISSUE_STATUSES.map((status) => {
                const count = statusCounts.get(status) ?? 0;
                return (
                  <li key={status} className="prio-distribution__row">
                    <span className="prio-distribution__label">
                      <StatusPill status={status} />
                    </span>
                    <span className="prio-distribution__track" aria-hidden>
                      <span
                        className="prio-distribution__bar"
                        data-status={status}
                        style={{ width: barWidth(count, total) }}
                      />
                    </span>
                    <span className="prio-distribution__value">{count}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </CardBody>
      </Card>
    </>
  );
}
