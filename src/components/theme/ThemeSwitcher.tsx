"use client";

import { useCallback, useSyncExternalStore } from "react";
import { Menu, MenuItem, MenuLabel } from "@/components/ui/Menu";
import { IconMoon, IconSun, IconSystem } from "@/components/ui/Icon";
import {
  isThemeChoice,
  resolveTheme,
  THEME_STORAGE_KEY,
  type ThemeChoice,
} from "@/components/theme/theme";

/**
 * Light / dark / system.
 *
 * The choice is read from storage, not from `data-theme`: the attribute
 * carries the *resolved* theme, and System resolves to Light, so reading it
 * back would report "Light" and quietly rewrite the person's choice the next
 * time they opened this menu.
 *
 * Read with `useSyncExternalStore` rather than `useState`. That is not a
 * stylistic preference. A `useState` initializer that reads the browser is
 * discarded during hydration: React runs it on the server (where there is no
 * storage), renders the fallback, and never re-runs it. The control would then
 * be stuck showing one value no matter what was chosen. `useSyncExternalStore`
 * takes a separate server snapshot, so the client reads the real preference on
 * its very first client render.
 */

/** Nothing but this control writes the preference; watch storage for the tab
 *  next door doing exactly that. The OS is not watched, because System no
 *  longer follows it. */
function subscribe(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
}

function readChoice(): ThemeChoice {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    // Storage can be unavailable; the default below is what the page painted.
  }
  return isThemeChoice(stored) ? stored : "light";
}

/* Rendered on the server and for the first hydration pass. The server cannot
   know what the browser stored, so it answers with the default a browser that
   stored nothing has — Light. That is the common first render, so the control
   usually hydrates to the same value it was drawn with instead of swapping its
   icon on the first frame; anyone with a stored preference still has it read
   by `readChoice` on the first client render. */
function serverChoice(): ThemeChoice {
  return "light";
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

    /* The attribute is the resolved theme, and everything that is not Dark
       resolves to Light — System included. The choice itself is what goes to
       storage, just below, so "System" stays selectable and selected. */
    root.setAttribute("data-theme", resolveTheme(next));

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
          /* The tooltip every other icon button in the top bar uses. The
             accessible name still carries the current choice; the tooltip
             names the control. */
          title="Theme"
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
