import type { ReactNode } from "react";
import { Card, CardBody } from "@/components/ui/primitives";
import { IconCalendar, IconUsers } from "@/components/ui/Icon";
import { ISSUE_STATUSES, STATUS_LABEL as ISSUE_STATUS_LABEL } from "@/lib/domain";
import { formatDateCompact, workingDaysBetween } from "@/lib/format";
import type { SprintView } from "@/server/queries/sprints";

const STATUS_LABEL: Record<SprintView["status"], string> = {
  PLANNED: "Planned",
  ACTIVE: "Active",
  COMPLETED: "Completed",
};

/**
 * A sprint's details, read only: its own card (name, status, goal, dates,
 * stats, progress) plus an isometric bar chart of its issues by status.
 *
 * Shared by both places a sprint has a dedicated details page — reached from
 * the Projects directory's Iterations/Sprints block, and from a project's own
 * Sprints page — so the two never draw a sprint's details differently. Every
 * field is `loadSprints`'s own `SprintView`, the same query the full Sprint
 * Planning page reads; this adds nothing to that shape, only a read-only
 * subset of it and a chart of the same issues. Where the two pages differ —
 * the Back link's destination — is each page's own, not this component's.
 */
export function SprintDetailsView({
  sprint,
  children,
}: {
  sprint: SprintView;
  /** Drawn between the sprint's own card and its chart — the project's
   *  details page puts the sprint's issues here, grouped by status. */
  children?: ReactNode;
}) {
  const total = sprint.stats.total;
  const workingDays = workingDaysBetween(sprint.startDate, sprint.endDate);
  const statusCounts = new Map<string, number>();
  for (const issue of sprint.issues) {
    statusCounts.set(issue.status, (statusCounts.get(issue.status) ?? 0) + 1);
  }
  /* The tallest bar is the busiest status; every other bar is drawn against
     it, from a zero baseline, so heights compare honestly. */
  const maxCount = Math.max(0, ...statusCounts.values());

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
                {/* Working days, not calendar days: a fortnight's sprint is
                    ten days of work because nobody works the weekends in
                    it. One shared `workingDaysBetween` decides this. */}
                <span className="prio-text-muted">
                  {" "}
                  · {workingDays} working {workingDays === 1 ? "day" : "days"}
                </span>
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

          <div className="prio-sprint__progressrow">
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
            <span className="prio-sprint__progresslabel" aria-hidden>
              {sprint.stats.progress}%
            </span>
          </div>
        </CardBody>
      </section>

      {children}

      <Card style={{ marginTop: "var(--prio-space-4)" }}>
        <CardBody>
          <h2 className="prio-issue__section-title">Issues by status</h2>
          {total === 0 ? (
            <p className="prio-text-muted">No issues in this sprint yet.</p>
          ) : (
            /* One isometric bar per status, every status always shown —
               an empty one is a flat tile on the floor, not a gap. Each
               column is a list item carrying its own spoken label, and its
               title is the hover read-out. */
            <div className="prio-isochart__scroll">
              <ul className="prio-isochart" aria-label="Issues by status">
                {ISSUE_STATUSES.map((status) => {
                  const count = statusCounts.get(status) ?? 0;
                  const label = ISSUE_STATUS_LABEL[status];
                  const summary = `${label}: ${count} ${count === 1 ? "issue" : "issues"}`;
                  return (
                    <li
                      key={status}
                      className="prio-isochart__col"
                      data-status={status}
                      data-empty={count === 0 ? "true" : undefined}
                      title={summary}
                      aria-label={summary}
                    >
                      <span className="prio-isochart__plot" aria-hidden>
                        <span
                          className="prio-isochart__bar"
                          style={{
                            height: `${maxCount === 0 ? 0 : (count / maxCount) * 100}%`,
                          }}
                        >
                          {/* Inside the bar so it rides on its top face,
                              whatever the bar's height. */}
                          <span className="prio-isochart__value">
                            <span className="prio-isochart__dot" />
                            {count}
                          </span>
                        </span>
                      </span>
                      <span className="prio-isochart__label" aria-hidden>
                        {label}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </CardBody>
      </Card>
    </>
  );
}
