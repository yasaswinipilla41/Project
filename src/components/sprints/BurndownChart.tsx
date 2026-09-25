"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Burndown, BurndownChange } from "@/lib/burndown";
import { STATUS_LABEL } from "@/lib/domain";
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
 * is solid. Where nothing has been recorded yet the actual line simply stops:
 * the days a sprint has not reached are left blank rather than drawn flat or
 * drawn to zero, either of which would be a claim about work that has not
 * happened.
 *
 * A chart of one number per day answers "how much is left" and nothing else,
 * so three things sit around it:
 *
 *  - the **figures above it**, which say what the whole sprint is made of;
 *  - a **detail on hover**, which says which issues make up that day's
 *    remainder and what changed to move it — an issue finished, reopened,
 *    added, taken out, or re-estimated;
 *  - a **marker for today** on the sprint being worked.
 *
 * Every one of those is read from the same `Burndown` the lines are drawn
 * from, so nothing here can disagree with the picture.
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

/** How many issues a day's detail lists before it stops. */
const TIP_ISSUES = 8;

const hours = (value: number) => `${Math.round(value * 10) / 10}h`;
const signed = (value: number) =>
  `${value > 0 ? "+" : value < 0 ? "−" : ""}${hours(Math.abs(value))}`;

/*
 * Placing the day's detail: the geometry it needs.
 *
 * The panel has to end up inside the chart's own card, clear of the marker,
 * and off the line it is explaining. That last one is a question about a
 * rectangle and a polyline, so it is answered here rather than guessed at in
 * the placement.
 */

type Box = { left: number; top: number; right: number; bottom: number };

type Segment = { ax: number; ay: number; bx: number; by: number };

const overlaps = (one: Box, two: Box) =>
  two.left < one.right &&
  two.right > one.left &&
  two.top < one.bottom &&
  two.bottom > one.top;

const grow = (box: Box, by: number): Box => ({
  left: box.left - by,
  top: box.top - by,
  right: box.right + by,
  bottom: box.bottom + by,
});

const clamp = (value: number, low: number, high: number) =>
  Math.min(Math.max(value, low), high);

/** Do two line segments cross? The standard orientation test. */
const segmentsCross = (one: Segment, two: Segment) => {
  const side = (
    ax: number,
    ay: number,
    bx: number,
    by: number,
    cx: number,
    cy: number,
  ) => Math.sign((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
  const a = side(one.ax, one.ay, one.bx, one.by, two.ax, two.ay);
  const b = side(one.ax, one.ay, one.bx, one.by, two.bx, two.by);
  const c = side(two.ax, two.ay, two.bx, two.by, one.ax, one.ay);
  const d = side(two.ax, two.ay, two.bx, two.by, one.bx, one.by);
  return a !== b && c !== d;
};

/**
 * Does a box lie on any part of a drawn line?
 *
 * True if either end of a segment is inside the box, or if the segment
 * crosses one of its sides — which together is every way a line and a
 * rectangle can meet.
 */
const touchesLine = (box: Box, line: Segment[]) =>
  line.some((segment) => {
    const inside = (x: number, y: number) =>
      x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
    if (inside(segment.ax, segment.ay) || inside(segment.bx, segment.by)) {
      return true;
    }
    const sides: Segment[] = [
      { ax: box.left, ay: box.top, bx: box.right, by: box.top },
      { ax: box.right, ay: box.top, bx: box.right, by: box.bottom },
      { ax: box.right, ay: box.bottom, bx: box.left, by: box.bottom },
      { ax: box.left, ay: box.bottom, bx: box.left, by: box.top },
    ];
    return sides.some((side) => segmentsCross(segment, side));
  });

/**
 * A drawn polyline, in the page's own coordinates.
 *
 * The chart is drawn in its own 1200 x 300 box and scaled to the card, so the
 * points have to come back through the SVG's screen matrix before they can be
 * compared with a panel measured in pixels.
 */
const lineOf = (svg: SVGSVGElement, selector: string): Segment[] => {
  const poly = svg.querySelector<SVGPolylineElement>(selector);
  const matrix = svg.getScreenCTM();
  if (!poly || !matrix) return [];
  const points: { x: number; y: number }[] = [];
  for (let index = 0; index < poly.points.numberOfItems; index += 1) {
    points.push(poly.points.getItem(index).matrixTransform(matrix));
  }
  return points.slice(1).map((point, index) => ({
    ax: points[index]!.x,
    ay: points[index]!.y,
    bx: point.x,
    by: point.y,
  }));
};

/** What a change is called, in the words the tooltip uses. */
const REASON_LABEL: Record<BurndownChange["reason"], string> = {
  completed: "finished",
  reopened: "reopened",
  added: "added to the sprint",
  removed: "moved out of the sprint",
  estimate: "re-estimated",
  remainder: "remainder updated",
};

export function BurndownChart({ data }: { data: Burndown }) {
  const { points, totalEffort } = data;
  const [active, setActive] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);

  /*
   * Where the day's detail goes.
   *
   * Inside the chart's own card, clear of the marker, and off the line it is
   * explaining — measured rather than assumed, because the room there is
   * depends on the card's width, on where the day sits, and on how much there
   * is to say about that day.
   *
   * It is placed by trying positions and keeping the best, rather than by a
   * fixed rule, because a rule cannot know where the line goes. The positions
   * tried are the ones a reader expects — above the point, below it, to
   * either side of it, and along the card's edges for a day near one — and
   * the one chosen is the nearest to the point that leaves both the marker
   * and the *Remaining* line showing. The dashed *Ideal* line is a reference
   * rather than a measurement, so lying over it counts against a position
   * without ruling it out.
   *
   * On a day with a great deal to say nothing fits: then the detail reads in
   * the flow under the chart — still inside the card, and covering nothing at
   * all.
   *
   * `position: fixed` rather than absolute: the panel is kept inside the card
   * by arithmetic, and being out of the page's flow means no scroller or card
   * edge can clip it. It runs before the browser paints, so the panel is
   * never seen in the wrong place.
   */
  const placeTip = useCallback(() => {
    const wrap = wrapRef.current;
    const tip = tipRef.current;
    if (!wrap || !tip) return;

    tip.classList.remove("is-placed", "is-inflow");

    /* Below the phone step the stylesheet keeps the panel in the flow, where
       there is nothing to place it against. */
    if (getComputedStyle(tip).position === "static") {
      tip.style.removeProperty("left");
      tip.style.removeProperty("top");
      return;
    }

    const dot = wrap.querySelector("circle.prio-burndown__dot");
    const svg = wrap.querySelector<SVGSVGElement>("svg.prio-burndown__svg");
    /* The chart's own card is the boundary the panel stays inside. */
    const card = wrap.closest(".prio-card") ?? wrap.closest(".prio-burndown");
    if (!dot || !svg || !card) return;

    /* Reading under the chart instead of beside the point. Its width is the
       same content width it has anywhere else — see the stylesheet. */
    const readInFlow = () => {
      tip.style.removeProperty("left");
      tip.style.removeProperty("top");
      tip.classList.add("is-inflow");
    };

    const marker = dot.getBoundingClientRect();
    const bounds = card.getBoundingClientRect();
    /* The gap the panel keeps from the point, and from the card's edges.
       Small enough to read as attached to the day, wide enough to leave the
       marker and its crosshair showing. */
    const gap = 10;
    const inset = 8;

    const actual = lineOf(svg, "polyline.prio-burndown__actual");
    const ideal = lineOf(svg, "polyline.prio-burndown__ideal");
    const centreX = marker.left + marker.width / 2;
    const centreY = marker.top + marker.height / 2;
    /* Room to see the marker, not merely to miss it. */
    const keepClear = grow(marker, gap);

    /** How far a box ends up from the point, in pixels of clear space. */
    const awayFrom = (box: Box) =>
      Math.hypot(
        Math.max(box.left - centreX, centreX - box.right, 0),
        Math.max(box.top - centreY, centreY - box.bottom, 0),
      );

    /*
     * What reading in the flow would cost.
     *
     * Measured, not assumed, and measured the same way as a floating
     * position: the panel is put in the flow for the length of one
     * measurement and its distance from the point read off. It covers nothing
     * at all, so it competes on that distance alone — and only if it would be
     * on screen, because under the chart is below the fold when the card runs
     * to the bottom of the window, and a panel the reader has to scroll to
     * find is worse than one across the chart from the point.
     */
    tip.classList.add("is-inflow");
    const flowed = tip.getBoundingClientRect();
    tip.classList.remove("is-inflow");
    const flowCost =
      flowed.top >= 0 && flowed.bottom <= window.innerHeight
        ? awayFrom({
            left: flowed.left,
            top: flowed.top,
            right: flowed.right,
            bottom: flowed.bottom,
          })
        : Number.POSITIVE_INFINITY;

    /*
     * The panel's own size, measured once.
     *
     * Its width is its content's width — capped by the stylesheet and by
     * nothing else. It used to be part of the search: a few narrower widths
     * were tried, so that a panel which would not fit beside the point could
     * wrap into a column that did. That made the width a function of where the
     * panel happened to fit, which is exactly what a reader notices — the same
     * day's detail one width here and another there, and on a deployed build,
     * where the card is a little taller or the window a little shorter, a low
     * point falling through to the widest option of all.
     *
     * A tooltip's width should say something about what is in it and nothing
     * about the chart's geometry. So it is read here, once, and the search
     * moves a box of that one size around.
     */
    const width = tip.offsetWidth;
    const height = tip.offsetHeight;
    const minLeft = bounds.left + inset;
    const maxLeft = bounds.right - inset - width;
    const minTop = bounds.top + inset;
    const maxTop = bounds.bottom - inset - height;

    let best: { left: number; top: number; cost: number } | null = null;

    /* Unless the card cannot hold the panel at all, in which case the flow
       below is the only place for it. */
    if (maxLeft >= minLeft && maxTop >= minTop) {
      /*
       * Where to look.
       *
       * The positions a reader expects first — above the point, below it, to
       * either side, centred on it or aligned with it — and then a sweep of
       * the card in small steps.
       *
       * The sweep is what keeps the panel near the day. A handful of anchors
       * cannot see that the line ends a little way past the point, or that it
       * clears the panel's height a little way above it, so when every anchor
       * lay over the line the panel had to fall back on the card's far edge —
       * a tooltip a third of a chart away from the point it belongs to.
       * Stepped finely, the search finds the nearest spot that leaves the
       * line alone, whatever shape the line is.
       */
      const sweep = (low: number, high: number, step: number) => {
        const stops: number[] = [];
        for (let at = low; at < high; at += step) stops.push(at);
        stops.push(high);
        return stops;
      };
      const acrossOptions = [
        centreX - width / 2,
        centreX,
        centreX - width,
        marker.right + gap,
        marker.left - gap - width,
        ...sweep(minLeft, maxLeft, Math.max(8, (maxLeft - minLeft) / 30)),
      ];
      const downOptions = [
        marker.top - gap - height,
        marker.bottom + gap,
        centreY - height / 2,
        ...sweep(minTop, maxTop, Math.max(8, (maxTop - minTop) / 16)),
      ];

      for (const across of acrossOptions) {
        for (const down of downOptions) {
          const left = clamp(across, minLeft, maxLeft);
          const top = clamp(down, minTop, maxTop);
          const box: Box = {
            left,
            top,
            right: left + width,
            bottom: top + height,
          };

          /* The point it describes has to stay visible. */
          if (overlaps(keepClear, box)) continue;

          /* How far from the point it ended up: a near position reads as
             belonging to the day, a distant one as floating. */
          const away = awayFrom(box);
          /* Above is what a reader expects, then beside, then below — a
             tie-breaker between positions of much the same distance, not a
             reason to sit further off the point. */
          const direction =
            box.bottom <= marker.top
              ? 0
              : box.right <= marker.left || box.left >= marker.right
                ? 6
                : 12;
          /*
           * What makes a position good, in order.
           *
           * Covering the remaining line is disqualifying — it is the answer
           * the reader came for. After that the panel should read as
           * belonging to the day being read, so its distance from the point
           * decides, and lying over the dashed ideal costs about twenty
           * pixels of that distance: enough to step aside for a position
           * just as close, not enough to move the panel away from the point
           * over a reference line.
           */
          const cost =
            (touchesLine(box, actual) ? 4000 : 0) +
            (touchesLine(box, ideal) ? 20 : 0) +
            away +
            direction;

          if (!best || cost < best.cost) best = { left, top, cost };
        }
      }
    }

    /*
     * Nothing that leaves the remaining line showing, or nothing as near the
     * point as the flow is: under the chart it goes, where it covers nothing
     * at all.
     */
    if (!best || best.cost >= 4000 || best.cost > flowCost) {
      readInFlow();
      return;
    }

    tip.style.left = `${Math.round(best.left)}px`;
    tip.style.top = `${Math.round(best.top)}px`;
    tip.classList.add("is-placed");
  }, []);

  /* Before the paint of the render that opened it, so it is never seen
     unplaced. */
  useLayoutEffect(placeTip);

  /*
   * The chart moves under a fixed panel when the page scrolls or the window
   * changes size, and the panel follows it — at most once a frame, because
   * choosing a position is a few milliseconds of measuring and a scroll
   * fires far more often than it paints.
   */
  useEffect(() => {
    let frame = 0;
    const follow = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        placeTip();
      });
    };
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
    };
  }, [placeTip]);

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
  const y = (value: number) =>
    PAD.top + plotHeight - (plotHeight * value) / (ceiling || 1);

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

  /* The days there is something to say about: a day the sprint has not
     reached has no reading, so there is nothing to show for it. */
  const reached = points.flatMap((point, index) =>
    point.actual === null ? [] : [index],
  );
  const band =
    points.length === 1 ? plotWidth : plotWidth / (points.length - 1);

  const shown = active !== null ? points[active] : undefined;
  const showToday =
    data.active && data.todayIndex !== null && data.todayIndex < points.length;
  const todayPoint =
    data.todayIndex !== null ? points[data.todayIndex] : undefined;

  /**
   * Which way a day's detail opens, so it stays inside the chart.
   *
   * Read from where the day actually sits across the plot, not from its
   * position in the sprint: the last day with a reading can be four fifths
   * of the way along a sprint that still has days to run, and a panel
   * centred there hangs over the edge.
   */
  const tipSide = (index: number) => {
    const share = x(index) / WIDTH;
    return share < 0.3 ? "start" : share > 0.7 ? "end" : "middle";
  };


  return (
    <figure className="prio-burndown">
      {/*
       * What the sprint is made of, above the chart.
       *
       * Counted from the same data the lines are: the effort is the sprint's
       * own estimates and what is left of them, and the issue counts are its
       * own membership by the same open/closed rule. Nothing here is stored,
       * so it follows the work.
       */}
      <dl className="prio-burndown__summary">
        <div className="prio-burndown__figure">
          <dt>Total Effort</dt>
          <dd>{hours(data.totalEffort)}</dd>
        </div>
        <div className="prio-burndown__figure" data-tone="done">
          <dt>Completed Effort</dt>
          <dd>{hours(data.completedEffort)}</dd>
        </div>
        <div className="prio-burndown__figure">
          <dt>Remaining Effort</dt>
          <dd>{hours(data.remaining)}</dd>
        </div>
        <div className="prio-burndown__figure">
          <dt>Total Issues</dt>
          <dd>{data.totalIssues}</dd>
        </div>
        <div className="prio-burndown__figure" data-tone="done">
          <dt>Completed Issues</dt>
          <dd>{data.completedIssues}</dd>
        </div>
        <div className="prio-burndown__figure">
          <dt>Remaining Issues</dt>
          <dd>{data.remainingIssues}</dd>
        </div>
      </dl>

      {/*
       * The chart, and the day being read beside it.
       *
       * The detail is a sibling of the scroller rather than a child of it: a
       * scroll container clips what escapes it, and on a short chart the
       * detail is taller than the plot. Out here it can stand below the
       * chart's own box without being cut off.
       */}
      <div className="prio-burndown__chartwrap" ref={wrapRef}>
        {/* The scroller matters only on a narrow screen, where the chart keeps
          a floor width (see the stylesheet) instead of flattening to an
          unreadable strip. At any ordinary width there is nothing to
          scroll. */}
        <div className="prio-burndown__scroll prio-scroll">
          <div
            className="prio-burndown__plot"
            onMouseLeave={() => setActive(null)}
          >
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

              {/* Today, on the sprint being worked: a quiet rule down the plot,
                so "where are we now" is answered without reading the axis. */}
              {showToday ? (
                <line
                  x1={x(data.todayIndex!)}
                  x2={x(data.todayIndex!)}
                  y1={PAD.top}
                  y2={HEIGHT - PAD.bottom}
                  className="prio-burndown__today"
                />
              ) : null}

              <polyline points={idealLine} className="prio-burndown__ideal" />
              {actualLine ? (
                <polyline
                  points={actualLine}
                  className="prio-burndown__actual"
                />
              ) : null}

              {/* The day being read: a rule down the plot and a dot on the
                line, so the detail beside it is anchored to something. */}
              {shown && shown.actual !== null ? (
                <>
                  <line
                    x1={x(active!)}
                    x2={x(active!)}
                    y1={PAD.top}
                    y2={HEIGHT - PAD.bottom}
                    className="prio-burndown__crosshair"
                  />
                  <circle
                    cx={x(active!)}
                    cy={y(shown.actual)}
                    r={5}
                    className="prio-burndown__dot"
                  />
                </>
              ) : null}

              {/* One target per day the sprint has reached, a whole band wide
                so it can be hit without aiming at the line itself. */}
              {reached.map((index) => (
                <rect
                  key={index}
                  x={x(index) - band / 2}
                  y={PAD.top}
                  width={band}
                  height={plotHeight}
                  className="prio-burndown__hit"
                  onMouseEnter={() => setActive(index)}
                  aria-hidden
                />
              ))}
            </svg>

            {/* Today's own figures, beside its rule. */}
            {showToday && todayPoint ? (
              <p
                className="prio-burndown__todaytag"
                style={{ left: `${(x(data.todayIndex!) / WIDTH) * 100}%` }}
                data-side={tipSide(data.todayIndex!)}
              >
                <strong>Today</strong> · {hours(data.remaining)} left ·{" "}
                {data.remainingIssues}{" "}
                {data.remainingIssues === 1 ? "issue" : "issues"} ·{" "}
                {totalEffort === 0
                  ? 0
                  : Math.round((data.completedEffort / totalEffort) * 100)}
                % burned
              </p>
            ) : null}
          </div>
        </div>
        {/* The day being read, in words: what was left, what made it up,
            and what moved it. */}
        {shown && shown.actual !== null ? (
          <div
            /* Placed by `placeTip` above: outside the chart, so the day's
               point, the crosshair and both lines stay visible while it is
               being read. */
            ref={tipRef}
            className="prio-burndown__tip"
            role="status"
          >
            <p className="prio-burndown__tipdate">
              {formatDayMonthYear(shown.date)}
            </p>
            <p className="prio-burndown__tipfigures">
              Remaining: <strong>{hours(shown.actual)}</strong> · Completed:{" "}
              {hours(shown.completedEffort)} · Total:{" "}
              {hours(shown.committedEffort)}
              <br />
              Remaining issues: <strong>{shown.remainingCount}</strong> ·
              Completed issues: {shown.completedCount}
            </p>

            {shown.changes.length > 0 ? (
              <ul className="prio-burndown__tipchanges">
                {shown.changes.map((change, position) => (
                  <li key={`${change.issueId}-${change.reason}-${position}`}>
                    <span
                      className="prio-burndown__tipdelta"
                      data-up={change.delta > 0 || undefined}
                    >
                      {signed(change.delta)}
                    </span>
                    <span className="prio-key">{change.key}</span>{" "}
                    {REASON_LABEL[change.reason]}
                    {change.reason === "estimate" ||
                    change.reason === "remainder"
                      ? ` (${change.from === null || change.from === undefined ? "none" : hours(change.from)} → ${
                          change.to === null || change.to === undefined
                            ? "none"
                            : hours(change.to)
                        })`
                      : ""}
                  </li>
                ))}
              </ul>
            ) : null}

            {shown.remainingIssues.length > 0 ? (
              <ul className="prio-burndown__tipissues">
                {shown.remainingIssues.slice(0, TIP_ISSUES).map((issue) => (
                  <li key={issue.issueId}>
                    <span className="prio-key">{issue.key}</span> —{" "}
                    <span className="prio-burndown__tiptitle">
                      {issue.title}
                    </span>{" "}
                    — {issue.status ? STATUS_LABEL[issue.status] : "—"} —{" "}
                    {hours(issue.effortHours)}
                  </li>
                ))}
                {shown.remainingIssues.length > TIP_ISSUES ? (
                  <li className="prio-text-muted">
                    and {shown.remainingIssues.length - TIP_ISSUES} more
                  </li>
                ) : null}
              </ul>
            ) : (
              <p className="prio-text-muted">Nothing left on this day.</p>
            )}
          </div>
        ) : null}
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

      {/*
       * The same day-by-day reading, in text.
       *
       * A detail that appears under a pointer is no use to somebody who is
       * not using one, so every day the sprint has reached is also written
       * out here for a screen reader — the same figures, from the same
       * points.
       */}
      <ul className="prio-visually-hidden">
        {reached.map((index) => {
          const point = points[index]!;
          return (
            <li key={index}>
              {formatDayMonthYear(point.date)}: {hours(point.actual ?? 0)}{" "}
              remaining across {point.remainingCount}{" "}
              {point.remainingCount === 1 ? "issue" : "issues"};{" "}
              {hours(point.completedEffort)} completed across{" "}
              {point.completedCount}{" "}
              {point.completedCount === 1 ? "issue" : "issues"}.
              {point.changes
                .map(
                  (change) =>
                    ` ${change.key} ${REASON_LABEL[change.reason]}, ${signed(change.delta)}.`,
                )
                .join("")}
            </li>
          );
        })}
      </ul>
    </figure>
  );
}
