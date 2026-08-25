"use client";

import { useEffect, useState } from "react";
import {
  BOARD_CARDS,
  BOARD_COLUMNS,
  ISSUE_DETAIL,
  WORKFLOW_STEPS,
} from "@/lib/marketing-content";
import { Reveal, useInView, usePrefersReducedMotion } from "./primitives";
import { SectionHeading } from "./Sections";
import { Avatar, PriorityMeter, StatusDot, TypeGlyph } from "./ui-atoms";

/**
 * The three product-storytelling blocks: the board, a single issue, and the
 * workflow the two of them move through.
 */

/* ----------------------------------------------------------- kanban board */

/**
 * Board showcase (§17).
 *
 * One card is animated across a column boundary on a loop so the board
 * demonstrates movement rather than describing it. The card is moved with a
 * transform between two rendered positions, so nothing reflows.
 */
export function KanbanPreview() {
  const reduced = usePrefersReducedMotion();
  const { ref, inView } = useInView<HTMLDivElement>({ threshold: 0.25 });
  const [moved, setMoved] = useState(false);

  useEffect(() => {
    if (!inView || reduced) return;
    const timer = window.setInterval(() => setMoved((m) => !m), 3200);
    return () => window.clearInterval(timer);
  }, [inView, reduced]);

  return (
    <section className="site-section site-section--dark" id="board">
      <div className="site-container">
        <SectionHeading
          eyebrow="Boards"
          title="See your entire workflow at a glance."
          body="Backlog to Done, with every card carrying its key, priority and owner."
        />

        <Reveal direction="scale">
          <div ref={ref} className="site-board" data-cursor="ui" data-cursor-label="Explore">
            {BOARD_COLUMNS.map((column, columnIndex) => (
              <div key={column.id} className="site-board__col">
                <div className="site-board__col-head">
                  <StatusDot status={column.id} />
                  <span>{column.label}</span>
                  <span className="site-board__count">
                    {BOARD_CARDS.filter((c) => c.column === column.id).length}
                  </span>
                </div>

                <div className="site-board__cards">
                  {BOARD_CARDS.filter((card) => card.column === column.id).map(
                    (card) => {
                      /*
                       * PRIO-204 is the travelling card: it lives in "To Do"
                       * and shifts one column right while the loop runs.
                       */
                      const travels = card.key === "PRIO-204";
                      return (
                        <article
                          key={card.key}
                          className="site-board__card"
                          data-travel={travels}
                          data-moved={travels && moved}
                          style={
                            { "--i": columnIndex } as React.CSSProperties
                          }
                        >
                          <div className="site-board__card-top">
                            <TypeGlyph type={card.type} />
                            <span className="site-board__key">{card.key}</span>
                          </div>
                          <p className="site-board__title">{card.title}</p>
                          <div className="site-board__meta">
                            <PriorityMeter
                              level={
                                card.priority === "Urgent"
                                  ? 4
                                  : card.priority === "High"
                                    ? 3
                                    : 2
                              }
                            />
                            <span className="site-board__priority">
                              {card.priority}
                            </span>
                            <Avatar initials={card.assignee} size="sm" />
                          </div>
                        </article>
                      );
                    },
                  )}
                </div>
              </div>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------ issue detail */

/**
 * A single issue (§18), with its activity trail arriving one entry at a time
 * once the section is on screen.
 */
export function IssueDetail() {
  const reduced = usePrefersReducedMotion();
  const { ref, inView } = useInView<HTMLDivElement>({ threshold: 0.3 });
  const [shown, setShown] = useState(0);

  useEffect(() => {
    if (!inView || reduced) return;

    let step = 0;
    const timer = window.setInterval(() => {
      step += 1;
      setShown(step);
      if (step >= ISSUE_DETAIL.activity.length) window.clearInterval(timer);
    }, 700);

    return () => window.clearInterval(timer);
  }, [inView, reduced]);

  // Reduced motion sees the completed trail rather than an empty one.
  const visibleCount = reduced ? ISSUE_DETAIL.activity.length : shown;

  return (
    <section className="site-section" id="issue">
      <div className="site-container">
        <SectionHeading
          eyebrow="Issue detail"
          title="Every change, on the record."
          body="Reproduction, ownership and an activity trail that is never edited."
        />

        <Reveal direction="up">
          <div ref={ref} className="site-issue" data-cursor="ui">
            <div className="site-issue__main">
              <div className="site-issue__crumbs">
                <span>Engineering</span>
                <span aria-hidden>/</span>
                <span className="site-issue__key">{ISSUE_DETAIL.key}</span>
              </div>

              <h3 className="site-issue__title">{ISSUE_DETAIL.title}</h3>

              <div className="site-issue__chips">
                <span className="site-chip" data-status="progress">
                  <StatusDot status="progress" />
                  {ISSUE_DETAIL.status}
                </span>
                <span className="site-chip" data-tone="amber">
                  <PriorityMeter level={3} />
                  {ISSUE_DETAIL.priority}
                </span>
                <span className="site-chip site-chip--sev">
                  {ISSUE_DETAIL.severity}
                </span>
              </div>

              <p className="site-issue__desc">{ISSUE_DETAIL.description}</p>

              <div className="site-issue__comment">
                <Avatar initials={ISSUE_DETAIL.comment.initials} />
                <div>
                  <p className="site-issue__comment-who">
                    {ISSUE_DETAIL.comment.who}
                  </p>
                  <p className="site-issue__comment-body">
                    {ISSUE_DETAIL.comment.body}
                  </p>
                </div>
              </div>

              <div className="site-issue__activity">
                <p className="site-issue__label">Activity</p>
                {ISSUE_DETAIL.activity.map((entry, index) => (
                  <div
                    key={entry.who}
                    className="site-issue__event"
                    data-shown={index < visibleCount}
                    style={{ "--i": index } as React.CSSProperties}
                  >
                    <span className="site-issue__rail" aria-hidden />
                    <Avatar initials={entry.initials} size="sm" />
                    <p>
                      <strong>{entry.who}</strong> {entry.action}
                    </p>
                    <span className="site-issue__time">{entry.at}</span>
                  </div>
                ))}
              </div>
            </div>

            <aside className="site-issue__side">
              <p className="site-issue__label">Details</p>
              {[
                ["Assignee", ISSUE_DETAIL.assignee.name, ISSUE_DETAIL.assignee.initials],
                ["Reporter", ISSUE_DETAIL.reporter.name, ISSUE_DETAIL.reporter.initials],
              ].map(([label, name, initials]) => (
                <div key={label} className="site-issue__row">
                  <span>{label}</span>
                  <span className="site-issue__person">
                    <Avatar initials={initials!} size="sm" />
                    {name}
                  </span>
                </div>
              ))}

              <div className="site-issue__row">
                <span>Due date</span>
                <span>{ISSUE_DETAIL.due}</span>
              </div>

              <div className="site-issue__row">
                <span>Labels</span>
                <span className="site-issue__labels">
                  {ISSUE_DETAIL.labels.map((label) => (
                    <span key={label} className="site-label">
                      {label}
                    </span>
                  ))}
                </span>
              </div>
            </aside>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- workflow */

/**
 * Workflow (§19). The connecting line draws itself as the section scrolls, and
 * each dot lights when the line reaches it.
 */
export function Workflow() {
  const reduced = usePrefersReducedMotion();
  const { ref, inView } = useInView<HTMLDivElement>({ threshold: 0.35 });
  const [active, setActive] = useState(-1);

  useEffect(() => {
    if (!inView || reduced) return;

    let step = -1;
    const timer = window.setInterval(() => {
      step += 1;
      setActive(step);
      if (step >= WORKFLOW_STEPS.length - 1) window.clearInterval(timer);
    }, 520);

    return () => window.clearInterval(timer);
  }, [inView, reduced]);

  // Reduced motion shows the finished workflow instead of animating to it.
  const activeIndex = reduced ? WORKFLOW_STEPS.length - 1 : active;
  const progress = ((activeIndex + 1) / WORKFLOW_STEPS.length) * 100;

  return (
    <section className="site-section site-section--tint" id="workflow">
      <div className="site-container">
        <SectionHeading
          eyebrow="Workflow"
          title="From idea to done, without the chaos."
          body="One fixed workflow that every issue, story and bug travels through."
        />

        <div ref={ref} className="site-flow">
          <div className="site-flow__line" aria-hidden>
            <span
              className="site-flow__line-fill"
              style={{ "--p": `${progress}%` } as React.CSSProperties}
            />
          </div>

          <ol className="site-flow__steps">
            {WORKFLOW_STEPS.map((step, index) => (
              <li
                key={step.id}
                className="site-flow__step"
                data-active={index <= activeIndex}
                style={{ "--i": index } as React.CSSProperties}
              >
                <span className="site-flow__dot" aria-hidden>
                  <span className="site-flow__pulse" />
                </span>
                <p className="site-flow__label">{step.label}</p>
                <p className="site-flow__detail">{step.detail}</p>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
