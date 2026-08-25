"use client";

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";

/**
 * Motion primitives for the marketing site.
 *
 * Built on IntersectionObserver, pointer events and CSS custom properties
 * rather than an animation library: everything here animates `transform` and
 * `opacity` only, which the compositor handles without layout work, and it adds
 * nothing to the bundle. Every primitive is inert under
 * `prefers-reduced-motion`.
 */

/**
 * Subscribes to a media query.
 *
 * `useSyncExternalStore` is the right tool here: a media query is external
 * state, and reading it this way keeps effects free of the synchronous
 * setState that causes cascading renders. The server snapshot is always
 * `false`, so the markup matches on first paint and only corrects afterwards.
 */
function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** Single source of truth for the motion preference. */
export function usePrefersReducedMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}

/** True only for a mouse or trackpad, never touch. */
export function useFinePointer(): boolean {
  return useMediaQuery("(pointer: fine)");
}

/** True once the element has entered the viewport. Fires once by default. */
export function useInView<T extends HTMLElement>(options?: {
  threshold?: number;
  rootMargin?: string;
  once?: boolean;
}) {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    // Without IntersectionObserver, show everything rather than nothing.
    // Deferred to a microtask so the effect body stays free of setState.
    if (typeof IntersectionObserver === "undefined") {
      queueMicrotask(() => setInView(true));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setInView(true);
            if (options?.once !== false) observer.unobserve(entry.target);
          } else if (options?.once === false) {
            setInView(false);
          }
        }
      },
      {
        threshold: options?.threshold ?? 0.15,
        rootMargin: options?.rootMargin ?? "0px 0px -10% 0px",
      },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, [options?.threshold, options?.rootMargin, options?.once]);

  return { ref, inView };
}

/* ---------------------------------------------------------------- reveal */

export type RevealDirection = "up" | "down" | "left" | "right" | "scale" | "none";

/**
 * Scroll-triggered entrance. `delay` staggers siblings; `direction` varies the
 * motion so a page does not read as one uniform fade (§14).
 */
export function Reveal({
  children,
  direction = "up",
  delay = 0,
  duration,
  className,
  as: Tag = "div",
  threshold,
  style,
}: {
  children: ReactNode;
  direction?: RevealDirection;
  delay?: number;
  duration?: number;
  className?: string;
  as?: "div" | "section" | "li" | "span" | "header" | "article";
  threshold?: number;
  style?: CSSProperties;
}) {
  const { ref, inView } = useInView<HTMLDivElement>({ threshold });

  return (
    <Tag
      // The ref type varies with the tag; the element is always an HTMLElement.
      ref={ref as never}
      className={`site-reveal${className ? ` ${className}` : ""}`}
      data-direction={direction}
      data-visible={inView}
      style={
        {
          "--reveal-delay": `${delay}ms`,
          ...(duration ? { "--reveal-duration": `${duration}ms` } : null),
          ...style,
        } as CSSProperties
      }
    >
      {children}
    </Tag>
  );
}

/* -------------------------------------------------------------- magnetic */

/**
 * Pull toward the pointer (§25).
 *
 * Movement is capped and eased so the control never runs away from the cursor —
 * a magnetic button you cannot click is a broken button. Disabled for coarse
 * pointers and reduced motion.
 */
export function Magnetic({
  children,
  strength = 0.28,
  max = 10,
  className,
}: {
  children: ReactNode;
  strength?: number;
  max?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    const node = ref.current;
    if (!node || reduced) return;
    if (!window.matchMedia("(pointer: fine)").matches) return;

    let frame = 0;

    const onMove = (event: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = node.getBoundingClientRect();
        const dx = event.clientX - (rect.left + rect.width / 2);
        const dy = event.clientY - (rect.top + rect.height / 2);
        const x = Math.max(-max, Math.min(max, dx * strength));
        const y = Math.max(-max, Math.min(max, dy * strength));
        node.style.setProperty("--magnet-x", `${x}px`);
        node.style.setProperty("--magnet-y", `${y}px`);
      });
    };

    const reset = () => {
      cancelAnimationFrame(frame);
      node.style.setProperty("--magnet-x", "0px");
      node.style.setProperty("--magnet-y", "0px");
    };

    node.addEventListener("pointermove", onMove);
    node.addEventListener("pointerleave", reset);
    return () => {
      cancelAnimationFrame(frame);
      node.removeEventListener("pointermove", onMove);
      node.removeEventListener("pointerleave", reset);
    };
  }, [strength, max, reduced]);

  return (
    <span ref={ref} className={`site-magnetic${className ? ` ${className}` : ""}`}>
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ tilt */

/**
 * Subtle 3D tilt with a highlight that tracks the pointer (§16).
 *
 * Capped at a few degrees: past roughly 6° the text starts to distort and the
 * card stops looking like a product surface.
 */
export function Tilt({
  children,
  maxTilt = 5,
  className,
  glare = true,
}: {
  children: ReactNode;
  maxTilt?: number;
  className?: string;
  glare?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    const node = ref.current;
    if (!node || reduced) return;
    if (!window.matchMedia("(pointer: fine)").matches) return;

    let frame = 0;

    const onMove = (event: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = node.getBoundingClientRect();
        const px = (event.clientX - rect.left) / rect.width;
        const py = (event.clientY - rect.top) / rect.height;

        node.style.setProperty("--tilt-x", `${(0.5 - py) * maxTilt * 2}deg`);
        node.style.setProperty("--tilt-y", `${(px - 0.5) * maxTilt * 2}deg`);
        node.style.setProperty("--glare-x", `${px * 100}%`);
        node.style.setProperty("--glare-y", `${py * 100}%`);
        node.style.setProperty("--glare-opacity", "1");
      });
    };

    const reset = () => {
      cancelAnimationFrame(frame);
      node.style.setProperty("--tilt-x", "0deg");
      node.style.setProperty("--tilt-y", "0deg");
      node.style.setProperty("--glare-opacity", "0");
    };

    node.addEventListener("pointermove", onMove);
    node.addEventListener("pointerleave", reset);
    return () => {
      cancelAnimationFrame(frame);
      node.removeEventListener("pointermove", onMove);
      node.removeEventListener("pointerleave", reset);
    };
  }, [maxTilt, reduced]);

  return (
    <div ref={ref} className={`site-tilt${className ? ` ${className}` : ""}`}>
      <div className="site-tilt__inner">
        {children}
        {glare ? <span className="site-tilt__glare" aria-hidden /> : null}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- counter */

/**
 * Counts up when scrolled into view (§20).
 *
 * The final value is rendered on the server and during reduced motion, so the
 * number is never missing — the animation is decoration over correct content.
 */
export function Counter({
  to,
  duration = 1600,
  decimals = 0,
  prefix = "",
  suffix = "",
  className,
}: {
  to: number;
  duration?: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  className?: string;
}) {
  /*
   * No negative rootMargin here. The shared default holds reveals back until
   * they are comfortably on screen, but a figure that sits near the fold would
   * then sit at zero in plain sight.
   */
  const { ref, inView } = useInView<HTMLSpanElement>({
    threshold: 0.2,
    rootMargin: "0px",
  });
  const reduced = usePrefersReducedMotion();
  const [value, setValue] = useState(0);

  useEffect(() => {
    if (!inView || reduced) return;

    let frame = 0;
    const start = performance.now();

    const tick = (now: number) => {
      const progress = Math.min(1, (now - start) / duration);
      // Ease-out cubic: fast start, settled finish.
      const eased = 1 - Math.pow(1 - progress, 3);
      setValue(to * eased);
      if (progress < 1) frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [inView, to, duration, reduced]);

  // With reduced motion the final figure is shown immediately — the number is
  // the content; the count-up is only decoration over it.
  const display = reduced ? to : value;

  return (
    <span ref={ref} className={className}>
      {prefix}
      {display.toFixed(decimals)}
      {suffix}
    </span>
  );
}

/* ------------------------------------------------------ pointer spotlight */

/**
 * Publishes normalised pointer coordinates on an element as CSS variables, so
 * backgrounds and glows can follow the cursor without React re-rendering.
 */
export function usePointerSpotlight<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    const node = ref.current;
    if (!node || reduced) return;
    if (!window.matchMedia("(pointer: fine)").matches) return;

    let frame = 0;

    const onMove = (event: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = node.getBoundingClientRect();
        node.style.setProperty("--pointer-x", `${event.clientX - rect.left}px`);
        node.style.setProperty("--pointer-y", `${event.clientY - rect.top}px`);
        node.style.setProperty(
          "--pointer-px",
          `${((event.clientX - rect.left) / rect.width - 0.5).toFixed(3)}`,
        );
        node.style.setProperty(
          "--pointer-py",
          `${((event.clientY - rect.top) / rect.height - 0.5).toFixed(3)}`,
        );
      });
    };

    node.addEventListener("pointermove", onMove);
    return () => {
      cancelAnimationFrame(frame);
      node.removeEventListener("pointermove", onMove);
    };
  }, [reduced]);

  return ref;
}

/* ---------------------------------------------------------- custom cursor */

/**
 * Cursor companion for fine pointers (§24).
 *
 * Rendered as an extra dot that trails the real cursor; the native cursor is
 * never hidden, so pointing and clicking behave exactly as the visitor expects
 * and nothing breaks on touch or for keyboard users.
 */
export function CustomCursor() {
  const dotRef = useRef<HTMLDivElement>(null);
  const [variant, setVariant] = useState<"default" | "cta" | "card" | "ui">(
    "default",
  );
  const [label, setLabel] = useState("");
  const reduced = usePrefersReducedMotion();
  const finePointer = useFinePointer();

  // Never shown on touch, and never when motion is reduced.
  const enabled = finePointer && !reduced;

  useEffect(() => {
    if (!enabled) return;

    let frame = 0;
    let targetX = window.innerWidth / 2;
    let targetY = window.innerHeight / 2;
    let x = targetX;
    let y = targetY;

    const onMove = (event: PointerEvent) => {
      targetX = event.clientX;
      targetY = event.clientY;

      const target = event.target as HTMLElement | null;
      const hit = target?.closest<HTMLElement>("[data-cursor]");
      const next = hit?.dataset.cursor;

      if (next === "cta" || next === "card" || next === "ui") {
        setVariant(next);
        setLabel(hit?.dataset.cursorLabel ?? "");
      } else {
        setVariant("default");
        setLabel("");
      }
    };

    // Lerp toward the pointer so the dot trails rather than snapping.
    const tick = () => {
      x += (targetX - x) * 0.18;
      y += (targetY - y) * 0.18;
      if (dotRef.current) {
        dotRef.current.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      }
      frame = requestAnimationFrame(tick);
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    frame = requestAnimationFrame(tick);

    return () => {
      window.removeEventListener("pointermove", onMove);
      cancelAnimationFrame(frame);
    };
  }, [enabled]);

  if (!enabled) return null;

  return (
    <div
      ref={dotRef}
      className="site-cursor"
      data-variant={variant}
      aria-hidden
    >
      <span className="site-cursor__ring" />
      {label ? <span className="site-cursor__label">{label}</span> : null}
    </div>
  );
}

/* -------------------------------------------------------- scroll progress */

/** 0–1 progress of an element travelling through the viewport, for parallax. */
export function useScrollProgress<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [progress, setProgress] = useState(0);
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    const node = ref.current;
    if (!node || reduced) return;

    let frame = 0;

    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = node.getBoundingClientRect();
        const total = rect.height + window.innerHeight;
        const seen = window.innerHeight - rect.top;
        setProgress(Math.max(0, Math.min(1, seen / total)));
      });
    };

    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [reduced]);

  return { ref, progress };
}
