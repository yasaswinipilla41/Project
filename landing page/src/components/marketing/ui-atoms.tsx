/**
 * Small pieces of the product's visual vocabulary, reused across every mockup
 * on the marketing site so the Kanban board, the issue detail and the hero
 * dashboard all speak the same language.
 *
 * Deliberately separate from the application's own `Indicators.tsx`: those
 * components are bound to Prisma enums and the app's token set, and importing
 * them here would tie marketing copy to database types.
 */

export function TypeGlyph({ type }: { type: "task" | "bug" | "story" }) {
  return (
    <span className="site-type" data-type={type} aria-hidden>
      {type === "bug" ? (
        <svg viewBox="0 0 16 16" width="11" height="11">
          <g
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          >
            <path d="M5.2 6.3a2.8 2.8 0 0 1 5.6 0v2.5a2.8 2.8 0 0 1-5.6 0Z" />
            <path d="M6.3 4.5 5.4 3.2M9.7 4.5l.9-1.3M5.2 7.5H3M13 7.5h-2.2" />
            <path d="M5.4 10 3.6 11.4M10.6 10l1.8 1.4" />
          </g>
        </svg>
      ) : type === "story" ? (
        <svg viewBox="0 0 16 16" width="11" height="11">
          <path
            d="M3.6 3.6a1.2 1.2 0 0 1 1.2-1.2h6.4a1.2 1.2 0 0 1 1.2 1.2v9.8l-2.9-2-2.9 2V3.6Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" width="11" height="11">
          <rect
            x="2.8"
            y="2.8"
            width="10.4"
            height="10.4"
            rx="2.2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <path
            d="m5.6 8.1 1.7 1.7 3.2-3.4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </span>
  );
}

export function StatusDot({ status }: { status: string }) {
  return <span className="site-statusdot" data-status={status} aria-hidden />;
}

/** Four-bar urgency meter, matching the product's priority indicator. */
export function PriorityMeter({ level }: { level: 1 | 2 | 3 | 4 }) {
  return (
    <span className="site-meter" data-level={level} aria-hidden>
      {[1, 2, 3, 4].map((bar) => (
        <i key={bar} data-on={bar <= level} />
      ))}
    </span>
  );
}

export function Avatar({
  initials,
  size = "md",
}: {
  initials: string;
  size?: "sm" | "md" | "lg";
}) {
  return (
    <span className="site-avatar" data-size={size} aria-hidden>
      {initials}
    </span>
  );
}
