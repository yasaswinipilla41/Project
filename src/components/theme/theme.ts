/**
 * Theme preference — shared between the pre-paint script and the switcher.
 *
 * "system" is a real, first-class choice, not the absence of one: it means
 * "follow the machine", and it must keep following the machine when that
 * changes mid-session. It is represented as the absence of `data-theme` on
 * <html>, which is exactly what the CSS in `theme-dark.css` is written
 * against — but it is stored explicitly under `prio-theme`, so "chose System"
 * and "has never chosen anything" stay distinguishable. That distinction is
 * what lets a brand-new account default to Light while a deliberate System
 * choice still follows the OS; see `THEME_SCRIPT`.
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
 * Four cases, and the last one is the only thing that decides what a brand-new
 * account sees:
 *
 *   stored "light"  -> `data-theme="light"`
 *   stored "dark"   -> `data-theme="dark"`
 *   stored "system" -> no attribute; `prefers-color-scheme` decides, which is
 *                      what "System" means and is unchanged
 *   nothing stored  -> `data-theme="light"`
 *
 * That last line is the change: no preference now means Light rather than
 * following the machine. Somebody arriving for the first time on a dark laptop
 * was being shown a dark application they never asked for, and had no way to
 * know a Theme control existed to undo it. Following the OS is still available
 * — it is simply a choice now rather than the fallback.
 *
 * Nobody with a stored preference is affected: all three stored values are
 * handled above and read exactly as before.
 *
 * Defensive about storage: a private window that throws on access leaves `c`
 * null, which falls into the same "no preference" branch and yields Light,
 * rather than breaking the page.
 */
export const THEME_SCRIPT = `(function(){var c=null;try{c=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});}catch(e){}if(c==="dark"||c==="light"){document.documentElement.setAttribute("data-theme",c);}else if(c!=="system"){document.documentElement.setAttribute("data-theme","light");}})();`;
