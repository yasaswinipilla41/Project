/**
 * Theme preference — shared between the pre-paint script and the switcher.
 *
 * Three choices, and two of them paint the same thing. Prio's default is
 * Light, and "System" resolves to Light as well: the application does not
 * follow `prefers-color-scheme`, because arriving on a dark machine and being
 * shown a dark application nobody asked for — with no obvious way to know a
 * Theme control exists — is how people ended up stuck in it. Dark is a
 * deliberate choice now, and only a deliberate one.
 *
 * The stored value is the *choice*; `data-theme` on <html> is the *resolved*
 * theme. They differ for exactly one value:
 *
 *   stored "light"  -> data-theme="light"
 *   stored "dark"   -> data-theme="dark"
 *   stored "system" -> data-theme="light"
 *   nothing stored  -> data-theme="light"
 *
 * Keeping the two apart is what lets the switcher show "System" as selected
 * while the page renders Light. Reading the attribute alone would report
 * "Light" and quietly rewrite somebody's choice the next time they opened the
 * menu.
 */

export type ThemeChoice = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "prio-theme";

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return value === "light" || value === "dark" || value === "system";
}

/** What a stored choice paints. Everything that is not Dark is Light. */
export function resolveTheme(choice: ThemeChoice | null): "light" | "dark" {
  return choice === "dark" ? "dark" : "light";
}

/**
 * Runs before first paint, inlined into the document head.
 *
 * Written as a string because it must execute ahead of hydration — if the
 * attribute were applied by React, every dark-mode user would see a white
 * flash on each navigation that reloads the document.
 *
 * It sets the attribute in every case, including System and no-preference,
 * which is what stops `prefers-color-scheme` deciding anything: the dark
 * blocks in `theme-dark.css` are guarded on `:root:not([data-theme="light"])`,
 * and this always answers that guard.
 *
 * Defensive about storage: a private window that throws on access leaves the
 * value null, which is the same as no preference and yields Light rather than
 * breaking the page.
 */
export const THEME_SCRIPT = `(function(){var c=null;try{c=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});}catch(e){}document.documentElement.setAttribute("data-theme",c==="dark"?"dark":"light");})();`;
