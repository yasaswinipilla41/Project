"use client";

import { useEffect, useRef } from "react";
import { usePrefersReducedMotion } from "./primitives";

/**
 * Layered hero backdrop (§8, §26).
 *
 * Six depth layers, each moving at a different rate so the scene reads as
 * space rather than wallpaper: a static wash, a drifting radial glow, a grid, a
 * particle field, a cursor-following light, and the product on top.
 *
 * Only `transform` and `opacity` are animated, and pointer tracking writes CSS
 * variables from a rAF callback rather than re-rendering React.
 */
export function HeroBackground() {
  const rootRef = useRef<HTMLDivElement>(null);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    const node = rootRef.current;
    if (!node || reduced) return;
    if (!window.matchMedia("(pointer: fine)").matches) return;

    let frame = 0;

    const onMove = (event: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = node.getBoundingClientRect();
        const x = (event.clientX - rect.left) / rect.width;
        const y = (event.clientY - rect.top) / rect.height;

        node.style.setProperty("--mx", `${(x * 100).toFixed(2)}%`);
        node.style.setProperty("--my", `${(y * 100).toFixed(2)}%`);
        // Signed offsets drive the parallax on each layer.
        node.style.setProperty("--dx", `${(x - 0.5).toFixed(3)}`);
        node.style.setProperty("--dy", `${(y - 0.5).toFixed(3)}`);
      });
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove);
    };
  }, [reduced]);

  return (
    <div ref={rootRef} className="site-herobg" aria-hidden>
      {/* 1 — static wash */}
      <div className="site-herobg__wash" />

      {/* 2 — slow drifting brand glows */}
      <div className="site-herobg__glow site-herobg__glow--blue" />
      <div className="site-herobg__glow site-herobg__glow--purple" />

      {/* 3 — technical grid, fading out toward the bottom */}
      <div className="site-herobg__grid" />

      {/* 4 — floating particles, deterministic so SSR and client agree */}
      <div className="site-herobg__particles">
        {PARTICLES.map((particle, index) => (
          <span
            key={index}
            className="site-herobg__particle"
            style={
              {
                left: `${particle.x}%`,
                top: `${particle.y}%`,
                "--size": `${particle.size}px`,
                "--delay": `${particle.delay}s`,
                "--duration": `${particle.duration}s`,
                "--depth": particle.depth,
              } as React.CSSProperties
            }
          />
        ))}
      </div>

      {/* 5 — light that follows the cursor */}
      <div className="site-herobg__spotlight" />

      {/* Beams and a fine noise veil to break up the gradient banding */}
      <div className="site-herobg__beam site-herobg__beam--a" />
      <div className="site-herobg__beam site-herobg__beam--b" />
      <div className="site-herobg__noise" />
    </div>
  );
}

/*
 * Fixed values rather than Math.random(): a random field would differ between
 * the server and client renders and trip a hydration mismatch.
 */
const PARTICLES = [
  { x: 8, y: 22, size: 3, delay: 0, duration: 15, depth: 0.6 },
  { x: 18, y: 68, size: 2, delay: 2.4, duration: 18, depth: 0.35 },
  { x: 27, y: 12, size: 4, delay: 1.1, duration: 13, depth: 0.8 },
  { x: 36, y: 84, size: 2, delay: 3.6, duration: 20, depth: 0.3 },
  { x: 46, y: 34, size: 3, delay: 0.6, duration: 16, depth: 0.55 },
  { x: 57, y: 74, size: 2, delay: 4.2, duration: 19, depth: 0.4 },
  { x: 64, y: 18, size: 4, delay: 1.8, duration: 14, depth: 0.75 },
  { x: 73, y: 58, size: 3, delay: 3, duration: 17, depth: 0.5 },
  { x: 82, y: 28, size: 2, delay: 2, duration: 21, depth: 0.3 },
  { x: 90, y: 66, size: 3, delay: 0.9, duration: 15, depth: 0.65 },
  { x: 95, y: 40, size: 2, delay: 5, duration: 22, depth: 0.25 },
  { x: 12, y: 46, size: 2, delay: 3.2, duration: 18, depth: 0.45 },
] as const;
