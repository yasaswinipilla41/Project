"use client";

import { COMPANIES, FEATURES, VALUES } from "@/lib/marketing-content";
import { Reveal, Tilt } from "./primitives";
import { StatusDot } from "./ui-atoms";

/**
 * Social proof, the three-part value story and the feature grid.
 *
 * Grouped in one module because they share the section-heading rhythm and the
 * same reveal cadence; splitting them further would spread one visual idea
 * across three files.
 */

/* ------------------------------------------------------------ social proof */

export function SocialProof() {
  return (
    <section className="site-proof" aria-label="Teams using Prio">
      <div className="site-container">
        <Reveal direction="up">
          <p className="site-proof__lead">
            Everything your team needs to move work forward
          </p>
        </Reveal>

        <div className="site-proof__row">
          {COMPANIES.map((company, index) => (
            <Reveal key={company.name} direction="up" delay={index * 60}>
              <div className="site-proof__logo" data-cursor="card">
                <span className="site-proof__glyph" aria-hidden>
                  {company.glyph}
                </span>
                <span className="site-proof__name">{company.name}</span>
              </div>
            </Reveal>
          ))}
        </div>

        {/* These are illustrative names, and the page says so. */}
        <p className="site-proof__note">
          Illustrative examples — Prio is an internal tool built for Symbiosys
          Technologies.
        </p>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ value */

export function ValueSection() {
  return (
    <section className="site-section" id="value">
      <div className="site-container">
        <SectionHeading
          eyebrow="Why Prio"
          title="One workspace. Complete visibility."
          body="Three things, done properly, instead of forty things done badly."
        />

        <div className="site-value">
          {VALUES.map((value, index) => (
            <Reveal key={value.id} direction="up" delay={index * 120}>
              <article className="site-value__card" data-cursor="card">
                <span className="site-value__step">{value.step}</span>
                <h3 className="site-value__title">{value.title}</h3>
                <p className="site-value__body">{value.description}</p>

                {/* A miniature of the product idea the card describes. */}
                <div className="site-value__viz" aria-hidden>
                  <ValueVisual id={value.id} />
                </div>

                <ul className="site-value__points">
                  {value.points.map((point) => (
                    <li key={point}>
                      <StatusDot status="done" />
                      {point}
                    </li>
                  ))}
                </ul>

                <span className="site-value__arrow" aria-hidden>
                  <svg viewBox="0 0 16 16" width="16" height="16">
                    <path
                      d="M3 8h9M8.5 4.5 12 8l-3.5 3.5"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </span>
              </article>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

/** Each value card gets its own small animated diagram. */
function ValueVisual({ id }: { id: string }) {
  if (id === "plan") {
    return (
      <div className="site-viz site-viz--plan">
        {[64, 88, 46, 72].map((width, i) => (
          <span
            key={i}
            className="site-viz__row"
            style={{ "--w": `${width}%`, "--i": i } as React.CSSProperties}
          />
        ))}
      </div>
    );
  }

  if (id === "track") {
    return (
      <div className="site-viz site-viz--track">
        {["todo", "progress", "review", "done"].map((status, i) => (
          <span
            key={status}
            className="site-viz__pill"
            data-status={status}
            style={{ "--i": i } as React.CSSProperties}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="site-viz site-viz--deliver">
      <span className="site-viz__track" />
      <span className="site-viz__fill" />
      <span className="site-viz__marker" />
    </div>
  );
}

/* --------------------------------------------------------------- features */

export function FeatureGrid() {
  return (
    <section className="site-section site-section--tint" id="features">
      <div className="site-container">
        <SectionHeading
          eyebrow="Features"
          title="Everything your team needs to stay in sync"
          body="The parts of an issue tracker people actually use, built to work together."
        />

        <div className="site-features">
          {FEATURES.map((feature, index) => (
            <Reveal key={feature.id} direction="up" delay={index * 70}>
              <Tilt maxTilt={4}>
                <article
                  className="site-feature"
                  data-accent={feature.accent}
                  data-cursor="card"
                >
                  <span className="site-feature__icon" aria-hidden>
                    <FeatureIcon id={feature.id} />
                  </span>
                  <h3 className="site-feature__title">{feature.title}</h3>
                  <p className="site-feature__body">{feature.description}</p>

                  <span className="site-feature__viz" aria-hidden>
                    <FeatureVisual id={feature.id} />
                  </span>

                  <span className="site-feature__arrow" aria-hidden>
                    <svg viewBox="0 0 16 16" width="14" height="14">
                      <path
                        d="M3 8h9M8.5 4.5 12 8l-3.5 3.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </span>
                </article>
              </Tilt>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}

function FeatureIcon({ id }: { id: string }) {
  const paths: Record<string, React.ReactNode> = {
    issues: (
      <>
        <rect x="2.5" y="3" width="15" height="5" rx="1.6" />
        <rect x="2.5" y="12" width="15" height="5" rx="1.6" />
      </>
    ),
    bugs: (
      <>
        <path d="M6.4 7.6a3.6 3.6 0 0 1 7.2 0v3.2a3.6 3.6 0 0 1-7.2 0Z" />
        <path d="M7.8 5.4 6.6 3.8M12.2 5.4l1.2-1.6M6.4 9.2H3.6M16.4 9.2h-2.8" />
      </>
    ),
    projects: (
      <>
        <rect x="2.6" y="2.6" width="6.4" height="6.4" rx="1.6" />
        <rect x="11" y="2.6" width="6.4" height="6.4" rx="1.6" />
        <rect x="2.6" y="11" width="6.4" height="6.4" rx="1.6" />
      </>
    ),
    kanban: (
      <>
        <rect x="2.6" y="3" width="4" height="14" rx="1.4" />
        <rect x="8" y="3" width="4" height="9.5" rx="1.4" />
        <rect x="13.4" y="3" width="4" height="12" rx="1.4" />
      </>
    ),
    priorities: (
      <>
        <path d="M4 15V9M8 15V5.5M12 15v-4M16 15V7" />
      </>
    ),
    collaboration: (
      <>
        <circle cx="7.4" cy="6.6" r="2.8" />
        <path d="M2.6 16a4.8 4.8 0 0 1 9.6 0" />
        <path d="M12.6 4.2a2.8 2.8 0 0 1 0 5.2M13.6 11.4A4.8 4.8 0 0 1 16.4 16" />
      </>
    ),
    workflows: (
      <>
        <circle cx="4.4" cy="10" r="2.2" />
        <circle cx="15.6" cy="10" r="2.2" />
        <path d="M6.6 10h6.8" />
        <path d="M11.4 7.8 13.6 10l-2.2 2.2" />
      </>
    ),
    analytics: (
      <>
        <path d="M2.8 16.4h14.4" />
        <path d="M5.6 16.4v-5M10 16.4V4.6M14.4 16.4v-7.4" />
      </>
    ),
  };

  return (
    <svg
      viewBox="0 0 20 20"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[id]}
    </svg>
  );
}

/** A one-glance micro visualisation per feature card. */
function FeatureVisual({ id }: { id: string }) {
  if (id === "kanban") {
    return (
      <span className="site-fviz site-fviz--kanban">
        {[3, 2, 4].map((count, col) => (
          <span key={col} className="site-fviz__col">
            {Array.from({ length: count }).map((_, row) => (
              <i key={row} style={{ "--i": col + row } as React.CSSProperties} />
            ))}
          </span>
        ))}
      </span>
    );
  }

  if (id === "analytics" || id === "priorities") {
    return (
      <span className="site-fviz site-fviz--bars">
        {[40, 70, 52, 88, 64].map((height, i) => (
          <i
            key={i}
            style={{ "--h": `${height}%`, "--i": i } as React.CSSProperties}
          />
        ))}
      </span>
    );
  }

  if (id === "collaboration") {
    return (
      <span className="site-fviz site-fviz--avatars">
        {["PN", "KD", "SI"].map((who, i) => (
          <i key={who} style={{ "--i": i } as React.CSSProperties}>
            {who}
          </i>
        ))}
      </span>
    );
  }

  return (
    <span className="site-fviz site-fviz--lines">
      {[80, 55, 68].map((width, i) => (
        <i
          key={i}
          style={{ "--w": `${width}%`, "--i": i } as React.CSSProperties}
        />
      ))}
    </span>
  );
}

/* ---------------------------------------------------------- shared heading */

export function SectionHeading({
  eyebrow,
  title,
  body,
  align = "center",
}: {
  eyebrow: string;
  title: string;
  body?: string;
  align?: "center" | "left";
}) {
  return (
    <Reveal direction="up" className="site-heading" data-align={align}>
      <div className="site-heading__inner" data-align={align}>
        <p className="site-heading__eyebrow">{eyebrow}</p>
        <h2 className="site-heading__title">{title}</h2>
        {body ? <p className="site-heading__body">{body}</p> : null}
      </div>
    </Reveal>
  );
}
