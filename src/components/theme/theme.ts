/**
 * Theme preference — shared between the pre-paint script and the switcher.
 *
 * "system" is a real, first-class choice, not the absence of one: it means
 * "follow the machine", and it must keep following the machine when that
 * changes mid-session. It is stored as the absence of `data-theme` on <html>,
 * which is exactly what the CSS in `theme-dark.css` is written against.
 */

export type ThemeChoice = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "prio-theme";

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === "light" || value === "dark" || value === "system";
}

/**
 * Runs before first paint, inlined into the document head.
 *
 * Written as a string because it must execute ahead of hydration — if the
 * attribute were applied by React, every dark-mode user would see a white
 * flash on each navigation that reloads the document.
 *
 * It is deliberately tiny and defensive: a browser with storage blocked (or a
 * private window that throws on access) falls through to the system default
 * rather than breaking the page.
 */
export const THEME_SCRIPT = `(function(){try{var c=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});if(c==="dark"||c==="light"){document.documentElement.setAttribute("data-theme",c);}}catch(e){}})();`;
