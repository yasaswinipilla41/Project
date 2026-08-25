"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { HERO } from "@/lib/marketing-content";
import { HeroBackground } from "./HeroBackground";
import { ProductPreview } from "./ProductPreview";
import { Magnetic, useScrollProgress } from "./primitives";

/**
 * Hero (§7, §9).
 *
 * The load choreography is a single `data-stage` attribute that steps up over
 * time; each element keys its own delay off it in CSS. Doing it this way means
 * one state change drives the whole sequence, and the page is interactive
 * immediately — the animation is decoration over content that is already there.
 */
export function Hero() {
  const [ready, setReady] = useState(false);
  const { ref, progress } = useScrollProgress<HTMLDivElement>();

  useEffect(() => {
    // Next frame, so the initial state paints before the transition starts.
    const raf = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <section className="site-hero" id="product" data-ready={ready}>
      <HeroBackground />

      <div className="site-hero__inner site-container">
        <p className="site-hero__eyebrow site-enter" style={enterDelay(220)}>
          <span className="site-hero__eyebrow-dot" aria-hidden />
          {HERO.eyebrow}
        </p>

        <h1 className="site-hero__title">
          {HERO.heading.map((line, index) => (
            <span key={line} className="site-hero__line">
              {/* Each line is masked and slides up behind its own clip. */}
              <span
                className="site-hero__line-inner site-enter-line"
                style={enterDelay(420 + index * 130)}
              >
                {index === HERO.heading.length - 1 ? (
                  <span className="site-hero__accent">{line}</span>
                ) : (
                  line
                )}
              </span>
            </span>
          ))}
        </h1>

        <p className="site-hero__body site-enter" style={enterDelay(920)}>
          {HERO.body}
        </p>

        <div className="site-hero__actions site-enter" style={enterDelay(1120)}>
          <Magnetic>
            <Link
              href="/sign-in"
              className="site-btn site-btn--primary site-btn--lg"
              data-cursor="cta"
            >
              {HERO.primaryCta}
              <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden>
                <path
                  d="M3 8h9M8.5 4.5 12 8l-3.5 3.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </Link>
          </Magnetic>

          <a href="#value" className="site-btn site-btn--glass site-btn--lg">
            {HERO.secondaryCta}
          </a>
        </div>

        <p className="site-hero__trust site-enter" style={enterDelay(1280)}>
          {HERO.trust}
        </p>

        {/*
         * The mockup rises slightly as the hero scrolls, so the page has depth
         * without a heavy scroll handler.
         */}
        <div
          ref={ref}
          className="site-hero__stage site-enter-stage"
          style={
            {
              ...enterDelay(1420),
              "--scroll": progress.toFixed(3),
            } as React.CSSProperties
          }
        >
          <div className="site-hero__stage-glow" aria-hidden />
          <ProductPreview />
        </div>
      </div>

      <div className="site-hero__fade" aria-hidden />
    </section>
  );
}

/** Keeps the timing table readable where it is used. */
function enterDelay(ms: number): React.CSSProperties {
  return { "--enter-delay": `${ms}ms` } as React.CSSProperties;
}
