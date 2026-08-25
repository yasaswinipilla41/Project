"use client";

import { useTheme, type ThemeChoice } from "./ThemeProvider";

/**
 * Light / Dark / System control (§5).
 *
 * A radiogroup rather than a toggle, because there are genuinely three states
 * and "system" is not a midpoint between the other two. The sliding indicator
 * is a single element moved with a transform, so switching costs no layout.
 */

const OPTIONS: {
  value: ThemeChoice;
  label: string;
  icon: React.ReactNode;
}[] = [
  {
    value: "light",
    label: "Light",
    icon: (
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
        <circle cx="8" cy="8" r="3.1" fill="currentColor" />
        <g
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          fill="none"
        >
          <path d="M8 1.4v1.8M8 12.8v1.8M1.4 8h1.8M12.8 8h1.8" />
          <path d="M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3" />
        </g>
      </svg>
    ),
  },
  {
    value: "dark",
    label: "Dark",
    icon: (
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
        <path
          d="M13.4 9.6A5.8 5.8 0 0 1 6.4 2.6a5.9 5.9 0 1 0 7 7Z"
          fill="currentColor"
        />
      </svg>
    ),
  },
  {
    value: "system",
    label: "System",
    icon: (
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden>
        <rect
          x="1.8"
          y="3"
          width="12.4"
          height="8.4"
          rx="1.4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path
          d="M5.6 13.6h4.8"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    ),
  },
];

export function ThemeSwitcher() {
  const { choice, resolved, setTheme } = useTheme();
  const index = OPTIONS.findIndex((option) => option.value === choice);

  return (
    <div
      className="site-theme"
      role="radiogroup"
      aria-label="Colour theme"
      data-resolved={resolved}
    >
      <span
        className="site-theme__indicator"
        style={{ transform: `translateX(${Math.max(0, index) * 100}%)` }}
        aria-hidden
      />
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={choice === option.value}
          className="site-theme__option"
          data-active={choice === option.value}
          onClick={() => setTheme(option.value)}
          /* The icons are decorative; the label carries the meaning. */
          title={`${option.label} theme`}
        >
          {option.icon}
          <span className="site-theme__label">{option.label}</span>
        </button>
      ))}
    </div>
  );
}
