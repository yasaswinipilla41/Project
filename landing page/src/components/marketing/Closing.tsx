"use client";

import Link from "next/link";
import { useState } from "react";
import { PRIO_TAGLINE, PrioLogo } from "@/components/brand/PrioLogo";
import {
  ANALYTICS,
  AUTOMATION_STEPS,
  COLLABORATION_CARDS,
  FINAL_CTA,
  FOOTER_GROUPS,
} from "@/lib/marketing-content";
import {
  Counter,
  Magnetic,
  Reveal,
  useInView,
  usePointerSpotlight,
} from "./primitives";
import { SectionHeading } from "./Sections";
import { Avatar } from "./ui-atoms";

/* -------------------------------------------------------------- analytics */

/**
 * Analytics (§20). Every figure animates only once its panel is on screen, so
 * nothing has already finished before the visitor arrives.
 */
export function AnalyticsPreview() {
  const { ref, inView } = useInView<HTMLDivElement>({ threshold: 0.25 });
  const maxVelocity = Math.max(...ANALYTICS.velocity);
  const totalPriority = ANALYTICS.priorities.reduce((s, p) => s + p.value, 0);

  return (
    <section className="site-section site-section--dark" id="analytics">
      <div className="site-container">
        <SectionHeading
          eyebrow="Analytics"
          title="Turn project activity into useful insight."
          body="Distributions, workload and throughput, aggregated straight from the data."
        />

        <div ref={ref} className="site-analytics" data-in={inView}>
          <div className="site-analytics__stats">
            {ANALYTICS.stats.map((stat, index) => (
              <Reveal key={stat.label} direction="up" delay={index * 90}>
                <div className="site-stat" data-tone={stat.tone}>
                  <span className="site-stat__label">{stat.label}</span>
                  <span className="site-stat__value">
                    <Counter
                      to={stat.value}
                      decimals={"decimals" in stat ? stat.decimals : 0}
                      suffix={stat.suffix}
                    />
                  </span>
                  <span className="site-stat__glow" aria-hidden />
                </div>
              </Reveal>
            ))}
          </div>

          <div className="site-analytics__grid">
            {/* ------------------------------------------- velocity line */}
            <Reveal direction="up" className="site-panel site-panel--wide">
              <div className="site-panel__head">
                <span>Velocity</span>
                <span className="site-panel__meta">Last 8 sprints</span>
              </div>

              <div className="site-chart">
                <svg viewBox="0 0 320 120" preserveAspectRatio="none" aria-hidden>
                  <defs>
                    <linearGradient id="siteArea" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0" stopColor="var(--site-blue)" stopOpacity="0.35" />
                      <stop offset="1" stopColor="var(--site-purple)" stopOpacity="0" />
                    </linearGradient>
                    <linearGradient id="siteLine" x1="0" y1="0" x2="1" y2="0">
                      <stop offset="0" stopColor="var(--site-blue)" />
                      <stop offset="1" stopColor="var(--site-purple-bright)" />
                    </linearGradient>
                  </defs>

                  <path
                    className="site-chart__area"
                    d={areaPath(ANALYTICS.velocity, maxVelocity)}
                    fill="url(#siteArea)"
                  />
                  <path
                    className="site-chart__line"
                    d={linePath(ANALYTICS.velocity, maxVelocity)}
                    fill="none"
                    stroke="url(#siteLine)"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>

                <div className="site-chart__dots" aria-hidden>
                  {ANALYTICS.velocity.map((value, i) => (
                    <span
                      key={i}
                      style={
                        {
                          left: `${(i / (ANALYTICS.velocity.length - 1)) * 100}%`,
                          bottom: `${(value / maxVelocity) * 82}%`,
                          "--i": i,
                        } as React.CSSProperties
                      }
                    />
                  ))}
                </div>
              </div>
            </Reveal>

            {/* ------------------------------------------ priority donut */}
            <Reveal direction="up" delay={120} className="site-panel">
              <div className="site-panel__head">
                <span>Priority mix</span>
              </div>

              <div className="site-donut">
                <svg viewBox="0 0 120 120" aria-hidden>
                  {donutSegments(ANALYTICS.priorities, totalPriority).map(
                    (segment, i) => (
                      <circle
                        key={segment.label}
                        className="site-donut__seg"
                        cx="60"
                        cy="60"
                        r="46"
                        fill="none"
                        stroke={segment.colour}
                        strokeWidth="14"
                        strokeDasharray={`${segment.length} ${289 - segment.length}`}
                        strokeDashoffset={-segment.offset}
                        style={{ "--i": i } as React.CSSProperties}
                      />
                    ),
                  )}
                </svg>
                <div className="site-donut__center">
                  <Counter to={totalPriority} />
                  <span>issues</span>
                </div>
              </div>

              <ul className="site-legend">
                {ANALYTICS.priorities.map((item) => (
                  <li key={item.label}>
                    <span className="site-legend__dot" data-tone={item.tone} />
                    {item.label}
                    <span className="site-legend__value">{item.value}</span>
                  </li>
                ))}
              </ul>
            </Reveal>

            {/* ---------------------------------------------- workload */}
            <Reveal direction="up" delay={200} className="site-panel">
              <div className="site-panel__head">
                <span>Team workload</span>
              </div>

              <ul className="site-workload">
                {ANALYTICS.workload.map((person, i) => (
                  <li key={person.name} style={{ "--i": i } as React.CSSProperties}>
                    <Avatar initials={person.initials} size="sm" />
                    <span className="site-workload__name">{person.name}</span>
                    <span className="site-workload__track">
                      <span
                        className="site-workload__fill"
                        style={{ "--w": `${person.load}%` } as React.CSSProperties}
                      />
                    </span>
                    <span className="site-workload__value">{person.load}%</span>
                  </li>
                ))}
              </ul>
            </Reveal>
          </div>
        </div>
      </div>
    </section>
  );
}

/** Maps a series onto the 320×120 viewBox used by the velocity chart. */
function points(values: readonly number[], max: number) {
  return values.map((value, i) => ({
    x: (i / (values.length - 1)) * 320,
    y: 110 - (value / max) * 96,
  }));
}

function linePath(values: readonly number[], max: number): string {
  return points(values, max)
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(" ");
}

function areaPath(values: readonly number[], max: number): string {
  return `${linePath(values, max)} L320 120 L0 120 Z`;
}

/** Pre-computes donut arc lengths so the segments can animate in sequence. */
function donutSegments(
  items: readonly { label: string; value: number; tone: string }[],
  total: number,
) {
  const circumference = 2 * Math.PI * 46;
  const colours: Record<string, string> = {
    red: "#ef4444",
    amber: "#f59e0b",
    blue: "var(--site-blue)",
    slate: "#94a3b8",
  };

  let offset = 0;
  return items.map((item) => {
    const length = (item.value / total) * circumference;
    const segment = {
      label: item.label,
      length,
      offset,
      colour: colours[item.tone] ?? "var(--site-blue)",
    };
    offset += length;
    return segment;
  });
}

/* ---------------------------------------------------------- collaboration */

/** Collaboration (§21): floating cards that drift around the product. */
export function CollaborationSection() {
  const ref = usePointerSpotlight<HTMLDivElement>();

  return (
    <section className="site-section" id="collaboration">
      <div className="site-container">
        <SectionHeading
          eyebrow="Collaboration"
          title="Keep every team aligned."
          body="Comments, mentions and assignments land where the work already lives."
        />

        <Reveal direction="scale">
          <div ref={ref} className="site-collab">
            <div className="site-collab__glow" aria-hidden />

            <div className="site-collab__center">
              <div className="site-collab__head">
                <span className="site-collab__key">PRIO-118</span>
                <span className="site-chip" data-status="progress">
                  In Progress
                </span>
              </div>
              <p className="site-collab__title">Fix authentication bug</p>
              <div className="site-collab__people">
                {["PN", "KD", "SI", "RM"].map((who) => (
                  <Avatar key={who} initials={who} size="sm" />
                ))}
                <span className="site-collab__watching">4 watching</span>
              </div>
            </div>

            {COLLABORATION_CARDS.map((card, index) => (
              <div
                key={card.id}
                className="site-collab__card"
                data-slot={card.id}
                style={{ "--i": index } as React.CSSProperties}
              >
                <span className="site-collab__meta">{card.meta}</span>
                <div className="site-collab__row">
                  <Avatar initials={card.initials} size="sm" />
                  <div>
                    <p className="site-collab__who">{card.who}</p>
                    <p className="site-collab__text">{card.text}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- automation */

/** Automation builder (§22) — hovering a step expands its explanation. */
export function AutomationSection() {
  const [active, setActive] = useState(0);

  return (
    <section className="site-section site-section--tint" id="automation">
      <div className="site-container">
        <SectionHeading
          eyebrow="Automation"
          title="Let Prio handle the repetitive work."
          body="Rules that route, notify and assign so nobody has to remember to."
        />

        <Reveal direction="up">
          <div className="site-auto">
            {AUTOMATION_STEPS.map((step, index) => (
              <div key={step.title} className="site-auto__row">
                <button
                  type="button"
                  className="site-auto__step"
                  data-kind={step.kind}
                  data-active={active === index}
                  onPointerEnter={() => setActive(index)}
                  onFocus={() => setActive(index)}
                  onClick={() => setActive(index)}
                  aria-expanded={active === index}
                >
                  <span className="site-auto__kind">{step.kind}</span>
                  <span className="site-auto__title">{step.title}</span>
                  <span className="site-auto__detail">{step.detail}</span>
                </button>

                {index < AUTOMATION_STEPS.length - 1 ? (
                  <span
                    className="site-auto__link"
                    data-lit={active > index}
                    aria-hidden
                  >
                    <span className="site-auto__link-fill" />
                    <svg viewBox="0 0 16 16" width="14" height="14">
                      <path
                        d="M8 3v9M4.8 8.6 8 12l3.2-3.4"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- final CTA */

export function FinalCTA() {
  return (
    <section className="site-cta" id="cta">
      <div className="site-cta__bg" aria-hidden>
        <span className="site-cta__glow site-cta__glow--a" />
        <span className="site-cta__glow site-cta__glow--b" />
        <span className="site-cta__beam" />
        <span className="site-cta__grid" />
      </div>

      <div className="site-container">
        <Reveal direction="up">
          <div className="site-cta__inner">
            <PrioLogo variant="mark" size="xl" decorative />
            <h2 className="site-cta__title">{FINAL_CTA.heading}</h2>
            <p className="site-cta__body">{FINAL_CTA.body}</p>

            <div className="site-cta__actions">
              <Magnetic>
                <Link
                  href="/sign-in"
                  className="site-btn site-btn--primary site-btn--lg"
                  data-cursor="cta"
                >
                  {FINAL_CTA.primary}
                </Link>
              </Magnetic>
              <a href="#product" className="site-btn site-btn--glass site-btn--lg">
                {FINAL_CTA.secondary}
              </a>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ footer */

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="site-container">
        <div className="site-footer__top">
          <div className="site-footer__brand">
            <PrioLogo variant="lockup" size="md" tagline={PRIO_TAGLINE} />
            <p className="site-footer__blurb">
              Plan better. Track smarter. Deliver faster.
            </p>
          </div>

          <div className="site-footer__groups">
            {FOOTER_GROUPS.map((group) => (
              <div key={group.title} className="site-footer__group">
                <p className="site-footer__title">{group.title}</p>
                <ul>
                  {group.links.map((link) => (
                    <li key={link}>
                      {/*
                       * These destinations are not built yet. They are buttons
                       * rather than links so nothing advertises a page that
                       * would 404.
                       */}
                      <button type="button" className="site-footer__link">
                        {link}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>

        <div className="site-footer__bottom">
          <p>© {new Date().getFullYear()} Symbiosys Technologies. Internal system.</p>
          <Link href="/sign-in" className="site-footer__signin">
            Sign in to Prio
          </Link>
        </div>
      </div>
    </footer>
  );
}
