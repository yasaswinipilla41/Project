"use client";

import { useEffect, useState } from "react";
import { HERO_ISSUES } from "@/lib/marketing-content";
import { Counter, usePrefersReducedMotion } from "./primitives";
import { StatusDot, TypeGlyph } from "./ui-atoms";

/**
 * The Prio application, rendered as a real interface (§10, §11).
 *
 * Built from the same vocabulary as the product — issue keys, type glyphs,
 * status pills, priority meters — rather than decorative rectangles, and it
 * inherits the site theme through the `--ui-*` tokens so light and dark are two
 * designs rather than one filtered image (§23).
 *
 * A slow loop walks one issue through the workflow to demonstrate the product
 * without the visitor having to do anything. Hovering pauses it, so a curious
 * visitor can read a frame instead of chasing it.
 */

const DEMO_STAGES = [
  { status: "todo", progress: 18, label: "To Do" },
  { status: "progress", progress: 46, label: "In Progress" },
  { status: "review", progress: 78, label: "Review" },
  { status: "done", progress: 100, label: "Done" },
] as const;

export function ProductPreview({ compact = false }: { compact?: boolean }) {
  const reduced = usePrefersReducedMotion();
  const [stage, setStage] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (reduced || paused) return;
    const timer = window.setInterval(
      () => setStage((current) => (current + 1) % DEMO_STAGES.length),
      2600,
    );
    return () => window.clearInterval(timer);
  }, [reduced, paused]);

  const demo = DEMO_STAGES[stage]!;

  return (
    <div
      className={`site-app${compact ? " site-app--compact" : ""}`}
      onPointerEnter={() => setPaused(true)}
      onPointerLeave={() => setPaused(false)}
      data-cursor="ui"
      data-cursor-label="Explore"
      role="img"
      aria-label="The Prio workspace: a project dashboard showing issues, status, progress and activity."
    >
      {/* Window chrome keeps it reading as an application, not a diagram. */}
      <div className="site-app__bar">
        <span className="site-app__dots" aria-hidden>
          <i />
          <i />
          <i />
        </span>
        <span className="site-app__url">app.prio.dev/projects/eng</span>
      </div>

      <div className="site-app__body">
        {/* ------------------------------------------------------ sidebar */}
        <aside className="site-app__side" aria-hidden>
          <div className="site-app__side-brand">
            <span className="site-app__side-mark" />
            <span className="site-app__side-name">Prio</span>
          </div>
          {["Home", "Projects", "Issues", "Bugs", "Reports"].map((item, i) => (
            <div
              key={item}
              className="site-app__nav"
              data-active={i === 2}
              style={{ "--i": i } as React.CSSProperties}
            >
              <span className="site-app__nav-icon" />
              <span className="site-app__nav-label">{item}</span>
            </div>
          ))}
          <div className="site-app__side-foot">
            <span className="site-app__chip">ENG</span>
            <span className="site-app__chip">WEB</span>
          </div>
        </aside>

        {/* --------------------------------------------------------- main */}
        <div className="site-app__main">
          <div className="site-app__head">
            <div>
              <p className="site-app__title">Engineering</p>
              <p className="site-app__sub">17 issues · 6 bugs · 7 members</p>
            </div>
            <span className="site-app__cta">+ Create</span>
          </div>

          {/* Stat tiles with counters that run when scrolled into view. */}
          <div className="site-app__stats">
            {[
              { label: "Open", value: 13, tone: "blue" },
              { label: "In progress", value: 5, tone: "amber" },
              { label: "Bugs", value: 6, tone: "red" },
              { label: "Done", value: 24, tone: "green" },
            ].map((stat, i) => (
              <div
                key={stat.label}
                className="site-app__stat"
                data-tone={stat.tone}
                style={{ "--i": i } as React.CSSProperties}
              >
                <span className="site-app__stat-label">{stat.label}</span>
                <span className="site-app__stat-value">
                  <Counter to={stat.value} duration={1200 + i * 200} />
                </span>
                <span className="site-app__stat-spark" aria-hidden />
              </div>
            ))}
          </div>

          {/* --------------------------------------------------- issues */}
          <div className="site-app__panel">
            <div className="site-app__panel-head">
              <span>Issues</span>
              <span className="site-app__panel-meta">Updated just now</span>
            </div>

            <ul className="site-app__issues">
              {HERO_ISSUES.map((issue, i) => {
                // The first row is the one the demonstration drives.
                const isDemo = i === 1;
                const status = isDemo ? demo.status : issue.status;

                return (
                  <li
                    key={issue.key}
                    className="site-app__issue"
                    data-demo={isDemo}
                    style={{ "--i": i } as React.CSSProperties}
                  >
                    <TypeGlyph type={issue.type} />
                    <span className="site-app__issue-key">{issue.key}</span>
                    <span className="site-app__issue-title">{issue.title}</span>

                    <span className="site-app__priority" data-p={issue.priority}>
                      <i />
                      <i />
                      <i />
                      {issue.priority}
                    </span>

                    <span className="site-app__status" data-status={status}>
                      <StatusDot status={status} />
                      {isDemo ? demo.label : STATUS_LABEL[issue.status]}
                    </span>

                    <span className="site-app__avatar">{issue.assignee}</span>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* ------------------------------------ progress + activity row */}
          <div className="site-app__row">
            <div className="site-app__panel site-app__panel--grow">
              <div className="site-app__panel-head">
                <span>Sprint progress</span>
                <span className="site-app__panel-meta">{demo.progress}%</span>
              </div>
              <div className="site-app__progress">
                <span
                  className="site-app__progress-bar"
                  style={{ width: `${demo.progress}%` }}
                />
              </div>
              <div className="site-app__bars" aria-hidden>
                {[42, 68, 55, 80, 61, 92, 74].map((height, i) => (
                  <span
                    key={i}
                    className="site-app__chartbar"
                    style={
                      { "--h": `${height}%`, "--i": i } as React.CSSProperties
                    }
                  />
                ))}
              </div>
            </div>

            <div className="site-app__panel site-app__panel--activity">
              <div className="site-app__panel-head">
                <span>Activity</span>
              </div>
              {[
                { who: "KD", text: "moved PRIO-124 to " + demo.label },
                { who: "PN", text: "commented on PRIO-118" },
                { who: "SI", text: "reported PRIO-140" },
              ].map((item, i) => (
                <div
                  key={i}
                  className="site-app__activity"
                  style={{ "--i": i } as React.CSSProperties}
                >
                  <span className="site-app__avatar site-app__avatar--sm">
                    {item.who}
                  </span>
                  <span className="site-app__activity-text">{item.text}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* A notification that arrives as the demo issue reaches Review. */}
      <div className="site-app__toast" data-show={stage >= 2}>
        <span className="site-app__toast-dot" aria-hidden />
        PRIO-124 moved to {demo.label}
      </div>
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = {
  backlog: "Backlog",
  todo: "To Do",
  progress: "In Progress",
  review: "Review",
  done: "Done",
};
