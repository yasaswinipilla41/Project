"use client";

import { useCallback, useSyncExternalStore } from "react";
import { Menu, MenuItem, MenuLabel } from "@/components/ui/Menu";
import { IconMoon, IconSun, IconSystem } from "@/components/ui/Icon";
import {
  isThemeChoice,
  THEME_STORAGE_KEY,
  type ThemeChoice,
} from "@/components/theme/theme";

/**
 * Light / dark / system.
 *
 * The current choice lives in the DOM — `data-theme` on <html>, written before
 * first paint by the inline script — and is read with `useSyncExternalStore`
 * rather than `useState`.
 *
 * That is not a stylistic preference. A `useState` initializer that reads the
 * DOM is discarded during hydration: React runs it on the server (where there
 * is no DOM), renders the fallback, and never re-runs it. The control would
 * then be permanently stuck showing "System" no matter what the page is
 * actually displaying. `useSyncExternalStore` takes a separate server snapshot,
 * so the client reads the real attribute on its very first client render.
 */

/** No React state to subscribe to; the value only changes when we change it. */
function subscribe(onChange: () => void): () => void {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  // Under "system" the effective theme follows the OS, so a change there is a
  // change the control may need to reflect.
  media.addEventListener("change", onChange);
  window.addEventListener("storage", onChange);
  return () => {
    media.removeEventListener("change", onChange);
    window.removeEventListener("storage", onChange);
  };
}

function readChoice(): ThemeChoice {
  const attribute = document.documentElement.getAttribute("data-theme");
  return isThemeChoice(attribute) ? attribute : "system";
}

/* Rendered on the server and for the first hydration pass. "system" is the
   honest answer there: the server cannot know what the browser stored. */
function serverChoice(): ThemeChoice {
  return "system";
}

const LABEL: Record<ThemeChoice, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

export function ThemeSwitcher() {
  const choice = useSyncExternalStore(subscribe, readChoice, serverChoice);

  const apply = useCallback((next: ThemeChoice) => {
    const root = document.documentElement;

    if (next === "system") {
      // "System" is the absence of the attribute — the same state the CSS
      // media query is written against.
      root.removeAttribute("data-theme");
    } else {
      root.setAttribute("data-theme", next);
    }

    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage can be unavailable (private mode, blocked cookies). The theme
      // still applies for this page; it simply will not be remembered.
    }

    // `subscribe` only hears about OS and cross-tab changes, so nudge this tab.
    window.dispatchEvent(new StorageEvent("storage", { key: THEME_STORAGE_KEY }));
  }, []);

  const Glyph = choice === "dark" ? IconMoon : choice === "light" ? IconSun : IconSystem;

  return (
    <Menu
      align="end"
      width={196}
      label="Theme"
      trigger={(props) => (
        <button
          type="button"
          className="prio-btn prio-btn--ghost prio-btn--icon"
          aria-label={`Theme: ${LABEL[choice]}`}
          {...props}
        >
          <Glyph />
        </button>
      )}
    >
      <MenuLabel>Appearance</MenuLabel>
      <MenuItem
        icon={<IconSun />}
        selected={choice === "light"}
        onSelect={() => apply("light")}
      >
        Light
      </MenuItem>
      <MenuItem
        icon={<IconMoon />}
        selected={choice === "dark"}
        onSelect={() => apply("dark")}
      >
        Dark
      </MenuItem>
      <MenuItem
        icon={<IconSystem />}
        selected={choice === "system"}
        onSelect={() => apply("system")}
      >
        System
      </MenuItem>
    </Menu>
  );
}
