import {
  distributionSegments,
  distributionTotal,
  type StatusDistribution,
} from "@/lib/statusDistribution";

/**
 * The four-way split of a project's work, drawn as one bar and its legend.
 *
 * Sits with `ProjectProgressBar`, and answers the question that bar cannot:
 * the percentage says how much is behind you, this says what the rest is
 * doing. The two are read together, which is why they are drawn together.
 *
 * Widths and legend figures come from `lib/statusDistribution` already
 * calculated — the same contract `ProjectProgressBar` has with
 * `lib/projectProgress`, and for the same reason. A bar cannot show a share
 * the authoritative query did not produce.
 *
 * The widths are exact and the legend's percentages are rounded, so they are
 * deliberately not the same number: three equal thirds occupy exactly a third
 * of the bar each while reading as 34/33/33, which is the only way a legend
 * can both total 100% and describe a bar that has no gap in it.
 *
 * `as="span"` for the one caller that draws this inside a link, exactly as the
 * progress bar does.
 */
export function ProjectDistributionBar({
  distribution,
  as: Tag = "div",
  showLegend = true,
  className,
}: {
  distribution: StatusDistribution;
  as?: "div" | "span";
  showLegend?: boolean;
  className?: string;
}) {
  const Part = Tag === "span" ? "span" : "div";
  const total = distributionTotal(distribution);
  const segments = distributionSegments(distribution);

  return (
    <Tag
      className={
        className ? `prio-distribution__split ${className}` : "prio-distribution__split"
      }
    >
      {/*
        * Empty is its own statement, not 100% of nothing.
        *
        * A project with no work in it has not finished everything, and an
        * unsegmented full-width bar is exactly what that would look like. The
        * track is drawn empty instead, and the legend says what it is.
        */}
      <Part className="prio-distribution__track" data-empty={total === 0 || undefined} aria-hidden>
        {total > 0
          ? segments.map((segment) =>
              segment.count > 0 ? (
                <Part
                  key={segment.category}
                  className="prio-distribution__bar"
                  data-bucket={segment.category}
                  style={{ width: `${segment.width}%` }}
                />
              ) : null,
            )
          : null}
      </Part>

      {showLegend ? (
        <Part className="prio-distribution__legend">
          {/*
            * The legend says which question it is answering.
            *
            * The progress bar directly above reports how much of the project
            * is closed, and this reports what state its work items are in.
            * They are different measurements of the same project and they do
            * not agree — closed work includes Rejected and Cancelled, which
            * were never completed and are counted here under Other. Without a
            * name on each, two percentages sitting an inch apart read as one
            * figure printed twice and one of them looking wrong.
            */}
          <Part className="prio-distribution__caption">Work items by state</Part>

          {total === 0 ? (
            <Part className="prio-distribution__legenditem prio-distribution__legenditem--empty">
              No work items
            </Part>
          ) : (
            <>
              {segments.map((segment) => (
                <Part
                  key={segment.category}
                  className="prio-distribution__legenditem"
                  title={
                    segment.category === "completed"
                      ? "Work items in Done. Rejected and Cancelled work is counted under Other, so this is not the same figure as the progress bar above."
                      : segment.category === "other"
                        ? "Ready for QA, Reopen, Reject / Not an Issue and Cancelled."
                        : undefined
                  }
                >
                  <Part
                    className="prio-distribution__swatch"
                    data-bucket={segment.category}
                    aria-hidden
                  />
                  {segment.label} — {segment.count} ({segment.percentage}%)
                </Part>
              ))}
              <Part className="prio-distribution__legenditem prio-distribution__legenditem--total">
                Total — {total} work item{total === 1 ? "" : "s"} (100%)
              </Part>
            </>
          )}
        </Part>
      ) : null}
    </Tag>
  );
}
