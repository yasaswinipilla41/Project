import type { ProjectProgress } from "@/lib/projectProgress";

/**
 * The project completion bar, drawn once for every surface that shows one.
 *
 * The styling is the directory's: `.prio-progress` and `.prio-progress__bar`,
 * which carry the brand gradient, the track, the height, the pill radius and
 * the fill transition from the design tokens. Nothing is restated here, so a
 * change to those tokens still reaches every card.
 *
 * It takes a finished `ProjectProgress` and never works a percentage out for
 * itself. That is the whole point of the contract: a card cannot show a figure
 * the authoritative query did not produce.
 *
 * `as="span"` exists because one caller draws this inside a link, where a
 * `<div>` would be invalid markup. `decorative` marks the bar as presentation
 * for the one place that already announces the same percentage in the link's
 * own accessible name — repeating it there would have a screen reader read the
 * figure twice.
 */
export function ProjectProgressBar({
  progress,
  as: Tag = "div",
  decorative = false,
  className,
}: {
  progress: ProjectProgress;
  as?: "div" | "span";
  decorative?: boolean;
  className?: string;
}) {
  const Fill = Tag === "span" ? "span" : "div";

  return (
    <Tag
      className={className ? `prio-progress ${className}` : "prio-progress"}
      {...(decorative
        ? { "aria-hidden": true as const }
        : {
            role: "progressbar" as const,
            "aria-valuenow": progress.percentage,
            "aria-valuemin": 0,
            "aria-valuemax": 100,
            "aria-label": progress.label,
          })}
    >
      <Fill
        className="prio-progress__bar"
        style={{ width: `${progress.percentage}%` }}
      />
    </Tag>
  );
}
