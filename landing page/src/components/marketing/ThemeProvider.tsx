"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

/**
 * Theme state for the marketing site.
 *
 * Three modes (§5): an explicit `light` / `dark` choice, or `system`, which
 * follows the operating system live. The choice persists in localStorage; the
 * resolved value is written to `<html data-theme>` where the CSS reads it.
 *
 * The first paint is handled by `themeScript` below, not by this component —
 * React mounts too late to prevent a flash.
 *
 * Both pieces of state are read through `useSyncExternalStore` rather than
 * `useState`. That matters: the server cannot know the visitor's preference, so
 * a `useState` initialiser that reads the DOM is discarded during hydration and
 * the control ends up stuck on whatever the server guessed. `useSyncExternalStore`
 * takes an explicit server snapshot and reconciles to the real client value
 * immediately after hydration.
 */

export type ThemeChoice = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "prio.theme";

/** Fired when the choice changes, so every subscriber re-reads it. */
const THEME_EVENT = "prio:themechange";

interface ThemeContextValue {
  /** What the visitor picked. */
  choice: ThemeChoice;
  /** What is actually on screen once `system` is resolved. */
  resolved: ResolvedTheme;
  setTheme: (choice: ThemeChoice) => void;
  /** True while the crossfade is running, so the switcher can reflect it. */
  switching: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used inside <ThemeProvider>");
  }
  return context;
}

/**
 * Runs before first paint, inlined in the document head.
 *
 * Reads the stored choice and stamps `data-theme` so the correct palette is
 * already in place when the page renders. Without this the site paints light
 * and then snaps to dark, which is worse than having no dark mode at all.
 * Written as a string because it must not wait for hydration.
 */
export const themeScript = `
(function () {
  try {
    var stored = localStorage.getItem('${THEME_STORAGE_KEY}');
    var choice = stored === 'light' || stored === 'dark' || stored === 'system'
      ? stored
      : 'system';
    var resolved = choice === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : choice;
    document.documentElement.setAttribute('data-theme', resolved);
    document.documentElement.setAttribute('data-theme-choice', choice);
  } catch (e) {
    /* Private mode or blocked storage: fall back to the CSS media query. */
  }
})();
`;

function isChoice(value: unknown): value is ThemeChoice {
  return value === "light" || value === "dark" || value === "system";
}

/* ------------------------------------------------------------- the stores */

function subscribeChoice(onChange: () => void) {
  window.addEventListener(THEME_EVENT, onChange);
  // Keeps other tabs of the same site in step.
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(THEME_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/** The attribute is authoritative: the inline script already resolved it. */
function readChoice(): ThemeChoice {
  const attr = document.documentElement.getAttribute("data-theme-choice");
  if (isChoice(attr)) return attr;

  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (isChoice(stored)) return stored;
  } catch {
    // Storage unavailable.
  }
  return "system";
}

function subscribeSystem(onChange: () => void) {
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function readSystemDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const choice = useSyncExternalStore(
    subscribeChoice,
    readChoice,
    () => "system" as ThemeChoice,
  );

  const systemDark = useSyncExternalStore(
    subscribeSystem,
    readSystemDark,
    () => false,
  );

  const resolved: ResolvedTheme =
    choice === "system" ? (systemDark ? "dark" : "light") : choice;

  const [switching, setSwitching] = useState(false);

  /*
   * Mirrors the resolved theme onto the document — but only in an effect.
   *
   * During hydration `useSyncExternalStore` deliberately returns the *server*
   * snapshot, so writing the attribute from render would briefly stamp
   * "system/light" over whatever the inline script correctly resolved, undoing
   * the no-flash behaviour. By the time effects run, the client snapshot is in
   * place. This exists to follow the OS while the page is open; the first paint
   * is already handled by the inline script.
   *
   * `data-theme-choice` is deliberately NOT written here. It is the store's
   * source of truth, set by the inline script and by `setTheme`. Rewriting it
   * from this effect stamped the hydration-time "system" over the real choice,
   * so the switcher could never recover the stored value.
   */
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", resolved);
  }, [resolved]);

  const setTheme = useCallback((next: ThemeChoice) => {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Preference simply will not persist; the switch still works.
    }

    const nextResolved: ResolvedTheme =
      next === "system"
        ? readSystemDark()
          ? "dark"
          : "light"
        : next;

    document.documentElement.setAttribute("data-theme", nextResolved);
    document.documentElement.setAttribute("data-theme-choice", next);

    const root = document.querySelector(".prio-site");
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    /*
     * The crossfade class is added only for the duration of the change. A
     * permanent transition on every element would make hovers and scroll
     * animations feel sluggish.
     */
    if (root && !reduced) {
      setSwitching(true);
      root.classList.add("is-theme-switching");
      window.setTimeout(() => {
        root.classList.remove("is-theme-switching");
        setSwitching(false);
      }, 620);
    }

    window.dispatchEvent(new Event(THEME_EVENT));
  }, []);

  const value = useMemo(
    () => ({ choice, resolved, setTheme, switching }),
    [choice, resolved, setTheme, switching],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}
