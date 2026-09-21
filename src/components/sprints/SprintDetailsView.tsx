import type { ReactNode } from "react";
import { Card, CardBody } from "@/components/ui/primitives";
import { IconCalendar } from "@/components/ui/Icon";
import { SprintSummaryStrip } from "@/components/sprints/SprintSummaryStrip";
import {
  ISSUE_STATUSES,
  SPRINT_STATUS_LABEL,
  STATUS_LABEL as ISSUE_STATUS_LABEL,
} from "@/lib/domain";
import {
  formatDateRange,
  formatOrdinalDate,
  workingDaysBetween,
} from "@/lib/format";
import type { SprintView } from "@/server/queries/sprints";

/**
 * A sprint's details: its own card (name, status, goal, dates, figures and
 * progress) plus an isometric bar chart of its issues by status.
 *
 * The five figures open the work they count, in place — see
 * `SprintSummaryStrip`. Everything else here is read only.
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
                <span className="prio-sprint__range">
                  ({formatDateRange(sprint.startDate, sprint.endDate)})
                </span>
                <span className="prio-sprint__status" data-status={sprint.status}>
                  {SPRINT_STATUS_LABEL[sprint.status]}
                </span>
              </h1>
              {sprint.goal ? (
                <p className="prio-sprint__goal">{sprint.goal}</p>
              ) : null}
              <p className="prio-sprint__dates">
                <IconCalendar size={13} />
                Start Date: {formatOrdinalDate(sprint.startDate)} · End Date:{" "}
                {formatOrdinalDate(sprint.endDate)}
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
                    · closed {formatOrdinalDate(sprint.completedAt)}
                  </span>
                ) : null}
              </p>
            </div>
          </header>

          {/* The five figures, and the work behind whichever one is
              opened. A client component because opening a figure is local to
              this page: nothing is fetched and nothing is navigated, so Back
              leaves this view exactly as it was. The progress bar travels
              with it, so the card's order is unchanged. */}
          <SprintSummaryStrip sprint={sprint} />
        </CardBody>
      </section>

      {children}

      <Card style={{ marginTop: "var(--prio-space-4)" }}>
        <CardBody>
          {/*
            * The chart's heading, and how much work the chart is drawing.
            *
            * `stats.total` is every issue in the sprint whatever its status —
            * the same figure the summary strip above counts, read from the
            * same `loadSprints` query, so the two can never disagree and no
            * second count is fetched. Moving an issue between sprints changes
            * only `sprintId`, so both sprints' totals follow from the next
            * read of this page, which `router.refresh()` already triggers.
            */}
          <div className="prio-sprint__charthead">
            <h2 className="prio-issue__section-title">Issues by status</h2>
            <p className="prio-sprint__total">
              Total Issues: <strong>{total}</strong>
            </p>
          </div>
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
