import type { Burndown } from "@/lib/burndown";
import { formatDayMonthYear } from "@/lib/format";

/**
 * A sprint's burndown, drawn as inline SVG.
 *
 * No charting library, for the reason `StatusDonut` gives for the same
 * decision: Prio has no chart dependency, and two polylines over a labelled
 * grid do not justify adding one.
 *
 * Two lines and they mean different things, so they are drawn differently and
 * each is named. The **ideal** is arithmetic — where an evenly burning sprint
 * would be, from the whole estimate down to nothing across the sprint's own
 * dates — and is dashed and muted, because it is a reference rather than a
 * measurement. The **actual** is what the sprint's own work says is left, and
 * is solid. Where nothing has been recorded
 * yet the actual line simply stops: the days a sprint has not reached are left
 * blank rather than drawn flat or drawn to zero, either of which would be a
 * claim about work that has not happened.
 */

/*
 * The drawing's own coordinate space.
 *
 * The chart is `width: 100%` with the aspect ratio kept, so this box is
 * scaled to whatever the card gives it — and everything in it, the type
 * included, is scaled by the same factor. A 640-wide box on a 1,550-wide card
 * meant a scale of nearly 2.5: 10px axis labels arriving as 24px, strokes as
 * 6px, and a chart more than 600px tall for a plot that needed a third of it.
 *
 * So the box is wide and four times as wide as it is tall. At a full-width
 * card it now draws at roughly 1:1, which leaves the type the size it is
 * written at and the whole chart about 300px tall rather than 600. The axis
 * type is stepped per breakpoint in the stylesheet, because the scale falls
 * below 1 on a narrow screen and the labels would shrink away with it; below
 * the tablet step the chart keeps a floor width and its card scrolls, so a
 * phone gets a readable chart rather than a 70px strip.
 */
const WIDTH = 1200;
const HEIGHT = 300;
/* The left gutter holds the scale's own labels — "40h" — and has to hold
   them at the largest size the stylesheet gives them, which is the phone
   step; too narrow and the first digit is cut off by the edge of the box. */
const PAD = { top: 14, right: 24, bottom: 34, left: 58 };

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

  /* The scale down the left, in the unit it is measured in: this axis is
     remaining effort in hours, and a column of bare numbers does not say
     so. */
  const gridlines = [0, 0.25, 0.5, 0.75, 1].map((share) => ({
    share,
    hours: Math.round(ceiling * (1 - share)),
    y: PAD.top + plotHeight * share,
  }));

  /* A label on every day for a short sprint, and every other one once it gets
     long enough that they would collide. */
  const labelEvery = points.length > 10 ? Math.ceil(points.length / 8) : 1;

  /*
   * The dates along the bottom.
   *
   * The day on its own is enough while a sprint stays inside one month, but a
   * fortnight rarely does: "28, 30, 1, 3" reads as four days in no particular
   * month. So the month is named on the first date shown and again on the
   * first one shown in each new month — on a label that is being drawn
   * anyway, rather than by adding labels between the others and crowding
   * them.
   */
  const dated = points
    .map((point, index) => ({ point, index }))
    .filter(({ index }) => index % labelEvery === 0);
  const dateLabels = new Map<number, string>();
  let lastMonth: number | null = null;
  for (const { point, index } of dated) {
    const month = point.date.getMonth();
    dateLabels.set(
      index,
      month === lastMonth
        ? `${point.date.getDate()}`
        : `${point.date.getDate()} ${point.date.toLocaleDateString("en-GB", {
            month: "short",
          })}`,
    );
    lastMonth = month;
  }

  return (
    <figure className="prio-burndown">
      {/* The scroller matters only on a narrow screen, where the chart keeps
          a floor width (see the stylesheet) instead of flattening to an
          unreadable strip. At any ordinary width there is nothing to
          scroll. */}
      <div className="prio-burndown__scroll prio-scroll">
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
              {line.hours}h
            </text>
          </g>
        ))}

        {points.map((point, index) => {
          const label = dateLabels.get(index);
          return label ? (
            <text
              key={point.date.toISOString()}
              x={x(index)}
              y={HEIGHT - 10}
              textAnchor="middle"
              className="prio-burndown__axis"
            >
              {label}
            </text>
          ) : null;
        })}

        <polyline points={idealLine} className="prio-burndown__ideal" />
        {actualLine ? (
          <polyline points={actualLine} className="prio-burndown__actual" />
        ) : null}
      </svg>
      </div>

      <figcaption className="prio-burndown__legend">
        {/* "Remaining" rather than "Actual": it is the same line a burndown
            report calls the actual, and this is what it is showing — the
            hours this sprint still has to do. */}
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
