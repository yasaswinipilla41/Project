"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { Avatar } from "@/components/ui/primitives";
import { IconChevronLeft, IconUsers } from "@/components/ui/Icon";
import { IssueKey, IssueTypeIcon, StatusPill } from "@/components/ui/Indicators";
import { isClosedStatus } from "@/lib/domain";
import type { SprintIssueSummary, SprintView } from "@/server/queries/sprints";

/**
 * A sprint's five figures, and the work behind each one.
 *
 * The figures are what they always were — counted from the sprint's own
 * issues, in the same strip, with the same design. What is new is that each
 * one opens, in place, the work it counts: Total every issue in the sprint,
 * Completed the finished ones, Remaining what is left, Progress how the
 * percentage is made up, Assignees who is carrying it.
 *
 * Nothing is fetched and nothing is navigated. The view is drawn from the
 * `SprintView` this page already read, and opening or closing one is local
 * state — so Back leaves the page exactly as it was, with the sprint, the
 * chart below and the issues section all untouched and in place. The division
 * between finished and unfinished is `isClosedStatus`, the same one `stats`
 * counts with, so a figure and the list it opens can never disagree.
 */

type View = "total" | "completed" | "remaining" | "progress" | "assignees";

const VIEW_TITLE: Record<View, string> = {
  total: "All issues in this sprint",
  completed: "Completed",
  remaining: "Remaining",
  progress: "Progress",
  assignees: "Assignees",
};

/** One issue, as this panel lists it. */
function IssueRow({ issue }: { issue: SprintIssueSummary }) {
  return (
    <li className="prio-sprint__issue">
      <Link
        href={`/issues/${issue.key.toLowerCase()}`}
        className="prio-sprint__issuelink"
      >
        <IssueTypeIcon type={issue.type} size={13} />
        <IssueKey issueKey={issue.key} />
        <span className="prio-sprint__issuetitle prio-truncate">
          {issue.title}
        </span>
      </Link>
      <StatusPill status={issue.status} />
      {issue.assignee ? (
        <Avatar name={issue.assignee.name} image={issue.assignee.image} />
      ) : (
        <Avatar name={null} empty title="Unassigned" />
      )}
    </li>
  );
}

function IssueList({
  issues,
  empty,
}: {
  issues: SprintIssueSummary[];
  empty: string;
}) {
  if (issues.length === 0) {
    return <p className="prio-text-muted">{empty}</p>;
  }
  return (
    <ul className="prio-sprint__issues">
      {issues.map((issue) => (
        <IssueRow key={issue.id} issue={issue} />
      ))}
    </ul>
  );
}

/**
 * One figure, which opens its own view in place.
 *
 * Declared here rather than inside the strip: a component created during a
 * render is a new component every time, and React would throw its state away
 * on each keystroke elsewhere on the page.
 */
function Stat({
  name,
  label,
  value,
  tone,
  open,
  panelId,
  sprintName,
  onToggle,
}: {
  name: View;
  label: string;
  value: React.ReactNode;
  tone?: "success";
  open: boolean;
  panelId: string;
  sprintName: string;
  onToggle: (name: View) => void;
}) {
  return (
    <button
      type="button"
      className="prio-sprint__stat prio-sprint__stat--button"
      data-tone={tone}
      data-open={open || undefined}
      aria-expanded={open}
      aria-controls={panelId}
      onClick={() => onToggle(name)}
      title={`Show ${label.toLowerCase()} for ${sprintName}`}
    >
      <span className="prio-sprint__statvalue">{value}</span>
      <span className="prio-sprint__statlabel">{label}</span>
    </button>
  );
}

export function SprintSummaryStrip({ sprint }: { sprint: SprintView }) {
  const [view, setView] = useState<View | null>(null);
  const panelId = useId();
  const { stats, issues } = sprint;

  const toggle = (name: View) => setView((open) => (open === name ? null : name));
  const statProps = (name: View) => ({
    name,
    open: view === name,
    panelId,
    sprintName: sprint.name,
    onToggle: toggle,
  });

  const completed = issues.filter((issue) => isClosedStatus(issue.status));
  const remaining = issues.filter((issue) => !isClosedStatus(issue.status));

  /* One entry per person, plus the unassigned pile last — its key is the
     highest code point there is, so one sort puts it there. */
  const byPerson = new Map<
    string,
    { name: string; image: string | null; issues: SprintIssueSummary[] }
  >();
  for (const issue of issues) {
    const key = issue.assignee?.id ?? "￿";
    const entry = byPerson.get(key);
    if (entry) {
      entry.issues.push(issue);
      continue;
    }
    byPerson.set(key, {
      name: issue.assignee?.name ?? "Unassigned",
      image: issue.assignee?.image ?? null,
      issues: [issue],
    });
  }
  const people = [...byPerson.entries()].sort(([aKey, a], [bKey, b]) => {
    if (aKey === "￿") return 1;
    if (bKey === "￿") return -1;
    return b.issues.length - a.issues.length || a.name.localeCompare(b.name);
  });

  return (
    <>
      {/* The strip itself: the same five figures, in the same order, with the
          same markup and styling they have always had. */}
      <div className="prio-sprint__summary">
        <Stat {...statProps("total")} label="Total" value={stats.total} />
        <Stat
          {...statProps("completed")}
          label="Completed"
          value={stats.completed}
          tone="success"
        />
        <Stat
          {...statProps("remaining")}
          label="Remaining"
          value={stats.remaining}
        />
        <Stat
          {...statProps("progress")}
          label="Progress"
          value={`${stats.progress}%`}
        />
        <Stat
          {...statProps("assignees")}
          label="Assignees"
          value={
            <>
              <IconUsers size={13} /> {stats.assignees}
            </>
          }
        />
      </div>

      <div className="prio-sprint__progressrow">
        <div
          className="prio-progress"
          role="img"
          aria-label={`${stats.progress}% of this sprint's work is finished`}
        >
          <div
            className="prio-progress__bar"
            style={{ width: `${stats.progress}%` }}
          />
        </div>
        <span className="prio-sprint__progresslabel" aria-hidden>
          {stats.progress}%
        </span>
      </div>

      {/* The opened figure's own view, inside the sprint's card rather than on
          a page of its own, so Back is a return to this page as it was and
          not a navigation away from it. */}
      <section
        id={panelId}
        className="prio-summaryview"
        hidden={view === null}
        aria-label={view ? VIEW_TITLE[view] : undefined}
      >
        {view ? (
          <>
            <header className="prio-summaryview__head">
              <h3 className="prio-summaryview__title">{VIEW_TITLE[view]}</h3>
              <button
                type="button"
                className="prio-backlink prio-backlink--sprint prio-summaryview__back"
                onClick={() => setView(null)}
              >
                <IconChevronLeft size={13} />
                Back
              </button>
            </header>

            {view === "total" ? (
              <IssueList
                issues={issues}
                empty="No issues in this sprint yet."
              />
            ) : null}

            {view === "completed" ? (
              <>
                <p className="prio-summaryview__figure">
                  {stats.completed} of {stats.total} finished — Done, Cancelled
                  and Reject / Not an Issue all count as finished with.
                </p>
                <IssueList
                  issues={completed}
                  empty="Nothing in this sprint has been finished yet."
                />
              </>
            ) : null}

            {view === "remaining" ? (
              <>
                <p className="prio-summaryview__figure">
                  {stats.remaining} of {stats.total} still open.
                </p>
                <IssueList
                  issues={remaining}
                  empty="Every issue in this sprint is finished."
                />
              </>
            ) : null}

            {view === "progress" ? (
              <>
                <p className="prio-summaryview__figure">
                  {stats.progress}% — {stats.completed} finished of{" "}
                  {stats.total}, {stats.remaining} to go.
                </p>
                <div className="prio-sprint__progressrow">
                  <div
                    className="prio-progress"
                    role="img"
                    aria-label={`${stats.progress}% of this sprint's work is finished`}
                  >
                    <div
                      className="prio-progress__bar"
                      style={{ width: `${stats.progress}%` }}
                    />
                  </div>
                  <span className="prio-sprint__progresslabel" aria-hidden>
                    {stats.progress}%
                  </span>
                </div>
                {/* What stands between the figure and 100%. */}
                <h4 className="prio-summaryview__subtitle">
                  What is left to finish
                </h4>
                <IssueList
                  issues={remaining}
                  empty="Nothing — this sprint's work is all finished."
                />
              </>
            ) : null}

            {view === "assignees" ? (
              people.length === 0 ? (
                <p className="prio-text-muted">No issues in this sprint yet.</p>
              ) : (
                <>
                  <p className="prio-summaryview__figure">
                    {stats.assignees}{" "}
                    {stats.assignees === 1 ? "person is" : "people are"}{" "}
                    carrying this sprint&rsquo;s {stats.total}{" "}
                    {stats.total === 1 ? "issue" : "issues"}.
                  </p>
                  {people.map(([key, person]) => {
                    const done = person.issues.filter((issue) =>
                      isClosedStatus(issue.status),
                    ).length;
                    return (
                      <div key={key} className="prio-summaryview__group">
                        <div className="prio-summaryview__person">
                          <Avatar
                            name={key === "￿" ? null : person.name}
                            image={person.image}
                            empty={key === "￿"}
                          />
                          <span className="prio-memberpicker__text">
                            <span className="prio-memberpicker__name">
                              {person.name}
                            </span>
                            <span className="prio-memberpicker__meta">
                              {person.issues.length}{" "}
                              {person.issues.length === 1 ? "issue" : "issues"}{" "}
                              · {done} finished ·{" "}
                              {person.issues.length - done} left
                            </span>
                          </span>
                        </div>
                        <IssueList issues={person.issues} empty="" />
                      </div>
                    );
                  })}
                </>
              )
            ) : null}
          </>
        ) : null}
      </section>
    </>
  );
}
