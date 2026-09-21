import type { Burndown } from "@/lib/burndown";
import { formatDayMonthYear } from "@/lib/format";

/**
 * A sprint's burndown, drawn as inline SVG.
 *
 * No charting library, for the reason `StatusDonut` gives for the same
 * decision: Prio has no chart dependency, and two polylines over a labelled
 * grid do not justify adding one.
 *
 * Two lines and they mean different things, so they are drawn differently. The
 * ideal is arithmetic — where an evenly burning sprint would be — and is
 * dashed and muted, because it is a reference rather than a measurement. The
 * actual is what was recorded, and is solid. Where nothing has been recorded
 * yet the actual line simply stops: the days a sprint has not reached are left
 * blank rather than drawn flat or drawn to zero, either of which would be a
 * claim about work that has not happened.
 */

const WIDTH = 640;
const HEIGHT = 260;
const PAD = { top: 16, right: 16, bottom: 34, left: 44 };

export function BurndownChart({ data }: { data: Burndown }) {
  const { points, totalEffort } = data;

  if (points.length === 0 || totalEffort === 0) {
    return (
      <p className="prio-text-muted">
        {points.length === 0
          ? "This sprint has no dates to chart."
          : "Nothing in this sprint has been estimated yet, so there is nothing to burn down. Give its work items an Effort in hours and the chart will draw itself."}
      </p>
    );
  }

  const plotWidth = WIDTH - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;

  /* The top of the scale: the commitment, or the worst the actual line got to
     if somebody added work mid-sprint and it went above it. */
  const ceiling = Math.max(
    totalEffort,
    ...points.map((point) => point.actual ?? 0),
  );

  const x = (index: number) =>
    PAD.left +
    (points.length === 1 ? 0 : (plotWidth * index) / (points.length - 1));
  const y = (hours: number) =>
    PAD.top + plotHeight - (plotHeight * hours) / (ceiling || 1);

  const idealLine = points
    .map((point, index) => `${x(index)},${y(point.ideal)}`)
    .join(" ");

  /* Only the days that actually have a reading. `null` is a gap, and joining
     across it would draw a line through days nobody has reported on. */
  const actualLine = points
    .flatMap((point, index) =>
      point.actual === null ? [] : [`${x(index)},${y(point.actual)}`],
    )
    .join(" ");

  const gridlines = [0, 0.25, 0.5, 0.75, 1].map((share) => ({
    share,
    hours: Math.round(ceiling * (1 - share)),
    y: PAD.top + plotHeight * share,
  }));

  /* A label on every day for a short sprint, and every other one once it gets
     long enough that they would collide. */
  const labelEvery = points.length > 10 ? Math.ceil(points.length / 8) : 1;

  return (
    <figure className="prio-burndown">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="prio-burndown__svg"
        role="img"
        aria-label={`Burndown: ${totalEffort} hours committed, ${data.remaining} remaining.`}
        preserveAspectRatio="xMidYMid meet"
      >
        {gridlines.map((line) => (
          <g key={line.share}>
            <line
              x1={PAD.left}
              x2={WIDTH - PAD.right}
              y1={line.y}
              y2={line.y}
              className="prio-burndown__grid"
            />
            <text
              x={PAD.left - 8}
              y={line.y + 4}
              textAnchor="end"
              className="prio-burndown__axis"
            >
              {line.hours}
            </text>
          </g>
        ))}

        {points.map((point, index) =>
          index % labelEvery === 0 ? (
            <text
              key={point.date.toISOString()}
              x={x(index)}
              y={HEIGHT - 12}
              textAnchor="middle"
              className="prio-burndown__axis"
            >
              {point.date.getDate()}
            </text>
          ) : null,
        )}

        <polyline points={idealLine} className="prio-burndown__ideal" />
        {actualLine ? (
          <polyline points={actualLine} className="prio-burndown__actual" />
        ) : null}
      </svg>

      <figcaption className="prio-burndown__legend">
        <span className="prio-burndown__key" data-line="actual">
          Remaining
        </span>
        <span className="prio-burndown__key" data-line="ideal">
          Ideal
        </span>
        <span className="prio-text-muted">
          {formatDayMonthYear(points[0]!.date)} –{" "}
          {formatDayMonthYear(points[points.length - 1]!.date)} ·{" "}
          {data.remaining}h of {totalEffort}h left
          {data.unestimated > 0
            ? ` · ${data.unestimated} item${data.unestimated === 1 ? "" : "s"} not estimated`
            : ""}
        </span>
      </figcaption>
    </figure>
  );
}
