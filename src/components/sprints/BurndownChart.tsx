"use client";

import Link from "next/link";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { IssueStatus } from "@prisma/client";
import { Avatar } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/Dialog";
import { IconClose } from "@/components/ui/Icon";
import { StatusPill } from "@/components/ui/Indicators";
import type { Burndown, BurndownChange } from "@/lib/burndown";
import { STATUS_LABEL } from "@/lib/domain";
import { formatDateCompact, formatDayMonthYear } from "@/lib/format";

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
  /* The day the table under the chart is showing: the last one read, which
     unlike `active` survives the pointer leaving the plot. */
  const [reading, setReading] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);

  /*
   * A day clicked open, as opposed to one merely hovered.
   *
   * The hover card follows the pointer and lets it through, which is what
   * keeps hovering smooth — and also what makes anything in it impossible to
   * click, because reaching for it ends the hover. Clicking a point (or
   * pressing Enter on it) pins that day: its card stays open and takes clicks,
   * so its "Burn today" link can be used, and the table under the chart stays
   * on that day. Clicking the point again, pressing Escape or clicking outside
   * the chart lets it go.
   */
  const [pinned, setPinned] = useState<number | null>(null);
  /*
   * What the burn details dialog is showing, if anything: a day's burn —
   * opened from "Burn today" in a pinned card — or one issue's burn from the
   * sprint's start up to the day the table is showing, opened from that
   * issue's Burned figure in the table.
   */
  const [burnView, setBurnView] = useState<
    | { kind: "day"; day: number }
    | { kind: "issue"; issueId: string; upTo: number }
    | null
  >(null);

  const togglePin = useCallback((index: number) => {
    setPinned((current) => (current === index ? null : index));
    setActive(index);
    setReading(index);
  }, []);

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
    /* The gap the panel keeps from the point, and from the card's edges.
       Small enough to read as attached to the day, wide enough to leave the
       marker and its crosshair showing. */
    const gap = 6;
    const inset = 8;

    /*
     * Where the panel may go: the chart's card, stopping above the table, and
     * never off the screen.
     *
     * The table under the chart lists the day being read, and a panel drawn
     * over it hides the very rows the reader is being pointed at — so the
     * card's own bottom edge is the wrong limit now that the table is part of
     * the card. The limit is the table's top, less the same gap the panel
     * keeps from everything else. Above and to the sides the card's edges
     * still apply: floating over the figures or the legend hides nothing that
     * is not repeated in the panel itself.
     *
     * And the window bounds all of it. A panel is read where it is put, and a
     * reader cannot scroll to one: the pointer has to stay on the day for the
     * panel to exist, and scrolling moves the page out from under the pointer,
     * which ends the hover and takes the panel with it. So anywhere below the
     * fold is nowhere — the region stops at the window's edges, and what does
     * not fit inside them is not a position at all.
     */
    const cardBox = card.getBoundingClientRect();
    const tableTop = wrap
      .closest(".prio-burndown")
      ?.querySelector(".prio-burndown__table")
      ?.getBoundingClientRect().top;
    /* The window's top edge, or the app's bar where that is pinned to it: the
       bar stays on screen whatever the scroll, so the room behind it is not
       room, however much of the card has gone past the top. */
    const topbar = document.querySelector(".prio-topbar");
    const ceiling =
      topbar && getComputedStyle(topbar).position === "sticky"
        ? topbar.getBoundingClientRect().bottom
        : 0;
    const bounds = {
      left: Math.max(cardBox.left, 0),
      top: Math.max(cardBox.top, ceiling),
      right: Math.min(cardBox.right, window.innerWidth),
      bottom: Math.min(
        tableTop === undefined ? cardBox.bottom : tableTop - gap,
        cardBox.bottom,
        window.innerHeight,
      ),
    };

    const actual = lineOf(svg, "polyline.prio-burndown__actual");
    const ideal = lineOf(svg, "polyline.prio-burndown__ideal");
    const centreX = marker.left + marker.width / 2;
    const centreY = marker.top + marker.height / 2;
    /* Room to see the marker, not merely to miss it. */
    const keepClear = grow(marker, gap);

    /*
     * And the marker for today, which is a panel of its own.
     *
     * It answers "where are we now" without being hovered, so covering it
     * with the day being read hides the one figure a reader did not have to
     * ask for. Preferred rather than required — on a small card there are days
     * where every position clear of the line overlaps it, and the day being
     * read is the thing that was asked for.
     */
    const todayBox = wrap.querySelector(".prio-burndown__todaytag");
    const todayRect = todayBox?.getBoundingClientRect();
    const today = todayRect
      ? {
          left: todayRect.left,
          top: todayRect.top,
          right: todayRect.right,
          bottom: todayRect.bottom,
        }
      : null;

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
    const roomForPanel = maxLeft >= minLeft && maxTop >= minTop;

    let best: { left: number; top: number; cost: number } | null = null;

    /*
     * ------------------------------------------------- beside the point first
     *
     * The four placements a reader expects, each exactly `gap` clear of the
     * marker: above it, below it, to its right, to its left. Whichever of them
     * fits inside the bounds wins, so the panel sits a few pixels from the day
     * it describes on every point of the chart — and flips side at a boundary
     * rather than moving away.
     *
     * Covering the remaining line is a preference between these, not a veto:
     * a panel this size, this close to a point, cannot always miss a line that
     * crosses the whole plot, and treating that as disqualifying is what used
     * to send the panel hundreds of pixels across the chart. The marker itself
     * is never covered — each candidate is checked against the keep-clear ring.
     */
    const anchored: { left: number; top: number; fits: boolean }[] = [
      /* Above, centred: the placement a tooltip is expected in. */
      {
        left: clamp(centreX - width / 2, minLeft, maxLeft),
        top: marker.top - gap - height,
        fits: marker.top - gap - height >= minTop,
      },
      /* Below, for a point near the top of the scale. */
      {
        left: clamp(centreX - width / 2, minLeft, maxLeft),
        top: marker.bottom + gap,
        fits: marker.bottom + gap <= maxTop,
      },
      /* Beside it, for a point near the top or the bottom boundary. */
      {
        left: marker.right + gap,
        top: clamp(centreY - height / 2, minTop, maxTop),
        fits: marker.right + gap <= maxLeft,
      },
      {
        left: marker.left - gap - width,
        top: clamp(centreY - height / 2, minTop, maxTop),
        fits: marker.left - gap - width >= minLeft,
      },
    ];

    for (const [order, candidate] of anchored.entries()) {
      if (!roomForPanel || !candidate.fits) continue;
      const box: Box = {
        left: candidate.left,
        top: candidate.top,
        right: candidate.left + width,
        bottom: candidate.top + height,
      };
      if (overlaps(keepClear, box)) continue;
      /* Clear of the line if it can be, and the earlier placement when two
         are equally clear — the order above is the order a reader expects. */
      const cost =
        (touchesLine(box, actual) ? 40 : 0) +
        (touchesLine(box, ideal) ? 4 : 0) +
        order;
      if (!best || cost < best.cost) best = { ...box, cost };
    }

    /*
     * A placement beside the point is taken as it stands; it never competes
     * with reading in the flow. The flow is below the chart, which for the
     * days on the floor of the plot measures a few pixels away while reading
     * as a panel that has gone somewhere else — and it only counts when it is
     * on screen, so letting it compete made the scroll position decide.
     */
    const besideThePoint = best !== null;

    /* Only when nothing beside the point fits does the sweep look further —
       and only if the card can hold the panel at all. */
    if (best === null && roomForPanel) {
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
            /* Worth a good deal of distance to keep today's own figures
               readable, and not worth covering the line for. */
            (today && overlaps(today, box) ? 600 : 0) +
            away +
            direction;

          if (!best || cost < best.cost) best = { left, top, cost };
        }
      }
    }

    /*
     * Nowhere beside the point, and nothing the sweep found that leaves the
     * remaining line showing or lands nearer than the flow does: under the
     * chart it goes, where it covers nothing at all.
     */
    if (
      !best ||
      (!besideThePoint && (best.cost >= 4000 || best.cost > flowCost))
    ) {
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

  /* A pinned day lets go on Escape, or on a click anywhere outside the chart
     — but not on one inside the details dialog it opened, which is where the
     reader has gone to read. The dialog handles its own Escape first. */
  useEffect(() => {
    if (pinned === null || burnView !== null) return;
    const release = () => {
      setPinned(null);
      setActive(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") release();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      const chart = wrapRef.current?.closest(".prio-burndown");
      if (!target || chart?.contains(target)) return;
      if (target.closest('[role="dialog"]')) return;
      release();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [pinned, burnView]);

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

  /* A pinned day holds the card; otherwise the one under the pointer. */
  const showing = pinned ?? active;
  const shown = showing !== null ? points[showing] : undefined;

  /** One issue's burn from the sprint's first day up to day `upTo`, one entry
   *  per day it burned anything — the same per-day figures "Burn today"
   *  adds up, so the two can never disagree. */
  const burnsOf = (issueId: string, upTo: number) =>
    points.slice(0, upTo + 1).flatMap((point) =>
      point.burned
        .filter((burn) => burn.issueId === issueId)
        .map((burn) => ({ ...burn, date: point.date })),
    );

  /* The open burn breakdown, as rows the dialog can list and a total the rows
     add up to. */
  const burnDetails = (() => {
    if (burnView === null) return null;
    if (burnView.kind === "day") {
      const point = points[burnView.day];
      if (!point) return null;
      return {
        byIssue: false,
        title: `Burned on ${formatDayMonthYear(point.date)}`,
        description: `${hours(point.completedToday)} of effort burned by work done this day.`,
        rows: point.burned.map((burn) => ({ ...burn, date: point.date })),
        total: point.completedToday,
      };
    }
    const rows = burnsOf(burnView.issueId, burnView.upTo);
    const until = points[burnView.upTo];
    const total = Math.round(rows.reduce((sum, row) => sum + row.hours, 0) * 100) / 100;
    return {
      byIssue: true,
      title: `${rows[0]?.key ?? "Issue"} · burned to ${until ? formatDayMonthYear(until.date) : "date"}`,
      description: `${hours(total)} burned on this issue from the sprint's first day to this one.`,
      rows,
      total,
    };
  })();

  /*
   * The day the table under the chart is showing.
   *
   * Not `active`: that one clears the moment the pointer leaves the plot, and
   * a table whose rows vanish as you reach for them cannot be clicked. So the
   * table holds the last day that was read — and until a day has been read,
   * the most recent one the sprint has reached, which is the day somebody
   * opening the page wants anyway.
   */
  const tableIndex = reading ?? reached[reached.length - 1] ?? null;
  const tableDay = tableIndex === null ? undefined : points[tableIndex];

  /*
   * Every issue the table names for that day, and why it is there.
   *
   * The ones that changed first, in the order the day's own list has them,
   * then the work that was simply still open — each named once, because an
   * issue that was reopened and is still open is one row, not two.
   */
  const tableRows: {
    issueId: string;
    key: string;
    title: string;
    status: IssueStatus | null;
    assignee: string | null;
    effortHours: number;
    reason: BurndownChange["reason"] | "qa" | null;
    delta: number | null;
  }[] = [];
  if (tableDay) {
    const seen = new Set<string>();
    const openNow = new Map(
      tableDay.remainingIssues.map((issue) => [issue.issueId, issue]),
    );
    for (const change of tableDay.changes) {
      if (seen.has(change.issueId)) continue;
      seen.add(change.issueId);
      tableRows.push({
        issueId: change.issueId,
        key: change.key,
        title: change.title,
        status: change.status,
        assignee: openNow.get(change.issueId)?.assignee ?? null,
        effortHours: change.effortHours,
        reason: change.reason,
        delta: change.delta,
      });
    }
    for (const issue of tableDay.movedToQa) {
      if (seen.has(issue.issueId)) continue;
      seen.add(issue.issueId);
      const open = openNow.get(issue.issueId);
      tableRows.push({
        issueId: issue.issueId,
        key: issue.key,
        title: issue.title,
        status: open?.status ?? null,
        assignee: open?.assignee ?? null,
        effortHours: open?.effortHours ?? 0,
        reason: "qa",
        delta: 0,
      });
    }
    for (const issue of tableDay.remainingIssues) {
      if (seen.has(issue.issueId)) continue;
      seen.add(issue.issueId);
      tableRows.push({
        issueId: issue.issueId,
        key: issue.key,
        title: issue.title,
        status: issue.status,
        assignee: issue.assignee,
        effortHours: issue.effortHours,
        reason: null,
        delta: null,
      });
    }
  }

  /*
   * Each row's Remaining and Burned, for the two columns beside Effort.
   *
   * Remaining is what the issue still owed at the end of the day — read by
   * the same rule as the line itself. Burned is everything the issue burned
   * from the sprint's first day up to this one: the sum of its entries in the
   * days' `burned` lists, which is what "Burn today" is made of too, so a
   * row's figure and the days' figures always agree.
   */
  const tableRowsWithBurn = tableRows.map((row) => ({
    ...row,
    remainingHours: row.effortHours,
    burnedHours:
      tableIndex === null
        ? 0
        : Math.round(
            burnsOf(row.issueId, tableIndex).reduce(
              (sum, burn) => sum + burn.hours,
              0,
            ) * 100,
          ) / 100,
  }));

  /*
   * The sprint's scope movement, in the words the summary uses.
   *
   * Issues and hours read as one line — "+1 issue / +0.5h" — because a scope
   * change is usually both, and either half alone invites the wrong question.
   * Every part is dropped when it is nought, and a sprint that held its scope
   * says None rather than showing four zeroes.
   */
  const scopeParts = [
    data.issuesAdded > 0
      ? `+${data.issuesAdded} ${data.issuesAdded === 1 ? "issue" : "issues"}`
      : null,
    data.issuesRemoved > 0
      ? `−${data.issuesRemoved} ${data.issuesRemoved === 1 ? "issue" : "issues"}`
      : null,
    data.scopeAdded > 0 ? `+${hours(data.scopeAdded)}` : null,
    data.scopeRemoved < 0 ? `−${hours(Math.abs(data.scopeRemoved))}` : null,
  ].filter((part): part is string => part !== null);
  const scopeSummary =
    scopeParts.length === 0 ? "None" : scopeParts.join(" / ");

  /* The day's counts as label-and-number pairs, with the noughts dropped: the
     panel names what happened and stays quiet about what did not. */
  const tallied = (
    shown
      ? ([
          ["Completed", shown.tally.completed],
          ["Reopened", shown.tally.reopened],
          ["Added", shown.tally.added],
          ["Moved out", shown.tally.removed],
          ["To QA", shown.tally.toQa],
        ] as const)
      : []
  ).filter(([, count]) => count > 0);
  /* What else moved the line that day, in hours, beside the burn — so a day
     that burned 1.5h while the line fell 2.5h says where the other hour went,
     without calling any of it burned. */
  const movedParts = shown
    ? [
        shown.reopenedToday > 0 ? `+${hours(shown.reopenedToday)} reopened` : null,
        shown.scopeToday !== 0 ? `${signed(shown.scopeToday)} scope` : null,
      ].filter((part): part is string => part !== null)
    : [];
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
        {/*
         * What the sprint set out to do, beside what it is doing now.
         *
         * The pair is the point: on a sprint whose scope never moved they are
         * the same figure, and on one whose did, the difference between them
         * is the work that arrived or left — which is the question "why is the
         * line not falling?" usually turns out to be.
         */}
        <div className="prio-burndown__figure">
          <dt>Initial Effort</dt>
          <dd>{hours(data.initialEffort)}</dd>
        </div>
        {/* What it has committed to now. The pair with Initial is what says
            whether the scope moved, and it is the figure the caption under
            the chart quotes as well. */}
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
        {/* Completed against total, which is the shape the question is asked
            in — "six of six" rather than two figures to subtract. What the
            sprint holds now is the second of them, and what is left is the
            difference, so neither needs a column of its own. */}
        <div className="prio-burndown__figure">
          <dt>Completed Issues</dt>
          <dd>
            <span className="prio-burndown__figuredone">
              {data.completedIssues}
            </span>
            /{data.totalIssues}
          </dd>
        </div>
        {/*
         * Scope, in issues and in hours.
         *
         * Two sizes of news: an issue arriving is a decision somebody made,
         * and half an hour arriving is a re-estimate. "None" rather than a
         * row of noughts, because a sprint that held its scope is worth
         * saying plainly.
         */}
        <div className="prio-burndown__figure" data-tone="scope">
          <dt>Scope Changes</dt>
          <dd>{scopeSummary}</dd>
        </div>
        {/*
         * How far through the commitment the sprint is, in effort, with the
         * bar the rest of Prio draws progress with.
         *
         * "of effort" because the sprint block above this card shows a
         * progress figure of its own counted in issues — two percentages
         * under two headings that both say progress, and a reader is owed the
         * difference between them rather than left to wonder which is wrong.
         * It is the same figure the marker for today calls burned.
         */}
        <div className="prio-burndown__figure prio-burndown__figure--progress">
          <dt>
            Sprint Progress{" "}
            <span className="prio-burndown__figurenote">of effort</span>
          </dt>
          <dd>
            <span className="prio-burndown__progressvalue">
              {data.progress}%
            </span>
            <span
              className="prio-progress prio-burndown__progressbar"
              role="progressbar"
              aria-valuenow={data.progress}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`${data.progress}% of the sprint's effort burned`}
            >
              <span
                className="prio-progress__bar"
                style={{ width: `${data.progress}%` }}
              />
            </span>
          </dd>
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
            onBlur={(event) => {
              /* Keyboard focus leaving the chart ends a preview, as the
                 pointer leaving it does. */
              if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                setActive(null);
              }
            }}
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

              {/*
               * Where the scope moved, marked on the day it moved.
               *
               * A burndown's most misread feature is a line that climbs, or
               * refuses to fall, because work arrived rather than because
               * nobody did anything. The line itself cannot distinguish the
               * two — so the days the commitment changed carry a mark on the
               * axis, pointing up for work that arrived and down for work
               * that left. The hover still says what and by how much; this is
               * what makes a reader hover in the first place.
               */}
              {points.map((point, index) => {
                if (point.scopeToday === 0) return null;
                /* Just above the day's own point, so the mark reads as
                   belonging to that day of the line rather than to the axis;
                   clamped into the plot so a mark on a day at the top of the
                   scale is not drawn off the chart. */
                const at = Math.max(
                  PAD.top + 9,
                  (point.actual === null ? y(point.ideal) : y(point.actual)) -
                    12,
                );
                const up = point.scopeToday > 0;
                return (
                  <g
                    key={`scope-${point.date.toISOString()}`}
                    className="prio-burndown__scope"
                    data-direction={up ? "up" : "down"}
                  >
                    <title>
                      {`${formatDayMonthYear(point.date)}: scope ${signed(point.scopeToday)}`}
                    </title>
                    {/* An arrow: up for work arriving, down for work leaving.
                        The shaft and the head are one path so the two cannot
                        drift apart at another size. */}
                    <path
                      d={
                        up
                          ? `M${x(index)},${at + 9} L${x(index)},${at - 6} M${x(index) - 4},${at - 2} L${x(index)},${at - 6} L${x(index) + 4},${at - 2}`
                          : `M${x(index)},${at - 6} L${x(index)},${at + 9} M${x(index) - 4},${at + 5} L${x(index)},${at + 9} L${x(index) + 4},${at + 5}`
                      }
                    />
                  </g>
                );
              })}

              {/* A point per day the sprint has reached, so the line reads as
                a series of daily readings rather than as a curve through
                nothing — and so a reader can see which days there is a
                reading for at all. */}
              {reached.map((index) => (
                <circle
                  key={`point-${index}`}
                  cx={x(index)}
                  cy={y(points[index]!.actual!)}
                  r={3}
                  className="prio-burndown__point"
                />
              ))}

              {/* The day being read: a rule down the plot and a dot on the
                line, so the detail beside it is anchored to something. */}
              {shown && shown.actual !== null ? (
                <>
                  <line
                    x1={x(showing!)}
                    x2={x(showing!)}
                    y1={PAD.top}
                    y2={HEIGHT - PAD.bottom}
                    className="prio-burndown__crosshair"
                  />
                  <circle
                    cx={x(showing!)}
                    cy={y(shown.actual)}
                    r={5}
                    className="prio-burndown__dot"
                    data-pinned={pinned !== null || undefined}
                  />
                </>
              ) : null}

              {/*
               * One target per day the sprint has reached, a whole band wide
               * so it can be hit without aiming at the line itself — and so
               * each day's point is clickable wherever in its column it is
               * clicked. Hovering previews the day; clicking it, or Enter or
               * Space on it, pins the day open (see `pinned`). While a day is
               * pinned, hovering the others leaves both its card and the
               * table below alone.
               */}
              {reached.map((index) => {
                const point = points[index]!;
                return (
                  <rect
                    key={index}
                    x={x(index) - band / 2}
                    y={PAD.top}
                    width={band}
                    height={plotHeight}
                    className="prio-burndown__hit"
                    role="button"
                    tabIndex={0}
                    aria-pressed={pinned === index}
                    aria-label={`${formatDayMonthYear(point.date)}: ${hours(point.actual!)} remaining. ${pinned === index ? "Close" : "Open"} the day's details`}
                    onMouseEnter={() => {
                      setActive(index);
                      if (pinned === null) setReading(index);
                    }}
                    onFocus={() => {
                      setActive(index);
                      if (pinned === null) setReading(index);
                    }}
                    onClick={() => togglePin(index)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        togglePin(index);
                      }
                    }}
                  />
                );
              })}
            </svg>

            {/*
             * Today's own figures, beside its rule.
             *
             * Everything a reader wants from the marker without hovering
             * anything: what is left, how much of the work is finished
             * against how much there is, how far through the commitment that
             * puts the sprint, and how long there is left to do the rest.
             * `progress` is the same definition the summary above quotes.
             */}
            {showToday && todayPoint ? (
              <dl
                className="prio-burndown__todaytag"
                style={{ left: `${(x(data.todayIndex!) / WIDTH) * 100}%` }}
                data-side={tipSide(data.todayIndex!)}
              >
                {/* The day, in the short form the board cards use — one date
                    format for the whole product, not a new one here. */}
                <p className="prio-burndown__todaytitle">
                  Today ({formatDateCompact(todayPoint.date)})
                </p>
                <div>
                  <dt>Remaining Effort</dt>
                  <dd>{hours(data.remaining)}</dd>
                </div>
                <div>
                  <dt>Completed/Total Issues</dt>
                  <dd>
                    {data.completedIssues}/{data.totalIssues}
                  </dd>
                </div>
                <div>
                  <dt>Burn Percentage</dt>
                  <dd>{data.progress}%</dd>
                </div>
                {data.daysLeft === null ? null : (
                  <div>
                    <dt>Sprint Time Remaining</dt>
                    <dd>
                      {data.daysLeft} {data.daysLeft === 1 ? "day" : "days"}
                    </dd>
                  </div>
                )}
              </dl>
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
            /* Pinned, it takes clicks — see `pinned`. As a hover preview it
               lets the pointer through, as it always has. */
            data-pinned={pinned !== null || undefined}
            /* Under the burn dialog while it is open, like the rest of the
               page — not floating over its backdrop. */
            data-behind={burnView !== null || undefined}
          >
            <p className="prio-burndown__tipdate">
              {formatDayMonthYear(shown.date)}
              {pinned !== null ? (
                <button
                  type="button"
                  className="prio-burndown__tipclose"
                  aria-label="Close this day's details"
                  title="Close"
                  onClick={() => {
                    setPinned(null);
                    setActive(null);
                  }}
                >
                  <IconClose size={12} />
                </button>
              ) : null}
            </p>
            {/* Effort first, under its own heading: the figures a reader came
                for, one per line so they can be compared rather than parsed
                out of a sentence. The third is the day's own step, which the
                two above it — cumulative to the end of the day — do not
                say. */}
            <p className="prio-burndown__tipsection">Effort</p>
            <p className="prio-burndown__tipfigures">
              Remaining: <strong>{hours(shown.actual)}</strong>
              <br />
              Completed: {hours(shown.completedEffort)} of{" "}
              {hours(shown.committedEffort)} committed
              <br />
              Change since prev:{" "}
              <strong>
                {shown.change === null ? "0h" : signed(shown.change)}
              </strong>
              <br />
              Issues: {shown.completedCount} completed · {shown.remainingCount}{" "}
              remaining
            </p>

            {/*
             * What this day burned, in one line.
             *
             * The figures above are cumulative — where the sprint stood at
             * the end of the day — and a reader hovering a point is usually
             * asking the other question: what was done *today*. "Burn today"
             * is exactly the effort work removed that day (see
             * `completedToday`), never the line's net step, which also moves
             * when work is added, taken out or reopened; those are said
             * beside it when they happened. It opens the day's burned issues
             * — which takes a click, so it works once the day is pinned by
             * clicking its point. A quiet day says it was quiet rather than
             * leaving the reader to infer it from an empty panel.
             */}
            <p
              className="prio-burndown__tipchange"
              data-flat={shown.completedToday === 0 || undefined}
            >
              {shown.completedToday > 0 ? (
                <button
                  type="button"
                  className="prio-burndown__burnlink"
                  onClick={() => setBurnView({ kind: "day", day: showing! })}
                  /* Only reachable once the card is pinned: a hover card lets
                     the pointer through and is not in the tab order. */
                  tabIndex={pinned === null ? -1 : 0}
                >
                  Burn today: <strong>{hours(shown.completedToday)}</strong>
                </button>
              ) : shown.change === null ? (
                <>The sprint&rsquo;s first day</>
              ) : (
                <>No effort completed today</>
              )}
              {movedParts.length > 0 ? <> ({movedParts.join(", ")})</> : null}

              {/* And who did what, on the same line: the counts behind the
                  day, including the hand-offs that move no effort at all. */}
              {tallied.length > 0 ? (
                <span className="prio-burndown__tiptally">
                  {" · "}
                  {tallied
                    .map(([label, count]) => `${label}: ${count}`)
                    .join(" · ")}
                </span>
              ) : null}
            </p>

            {/*
             * A quiet day still gets an answer.
             *
             * What is *left* on the day is not listed here any more: the
             * table under the chart carries every issue for the day being
             * read, with who holds it and what it owes, and it can be clicked
             * — which a panel that follows the pointer cannot. Keeping both
             * lists made the panel tall enough that it had to sit a long way
             * from the point it was describing.
             */}
            {shown.changes.length === 0 && shown.movedToQa.length === 0 ? (
              <p className="prio-burndown__tipquiet">
                No issues changed on this day. The table below lists the work it
                was carrying.
              </p>
            ) : null}

            {/* How to make it stay: a hover card cannot be clicked, so it
                says how to pin it — but only where there is something in it
                to click. */}
            {pinned === null && shown.completedToday > 0 ? (
              <p className="prio-burndown__tiphint">
                Click the point to pin this card and open the burn.
              </p>
            ) : null}
          </div>
        ) : null}

        {/*
         * Burned effort, broken down.
         *
         * Two ways in, one dialog: "Burn today" in a pinned card lists what
         * each issue burned that day, and an issue's Burned figure in the
         * table lists what that issue burned on each day up to the one the
         * table shows. Either way the rows add up to the figure that was
         * clicked, so the number can be checked rather than taken on trust.
         * It is Prio's own modal — over the page, clear of the chart and the
         * table rather than drawn into them, with its own border so it reads
         * as one contained block in both themes — and it closes the way
         * every dialog does: its close icon, Escape, or the backdrop.
         */}
        <Dialog
          open={burnDetails !== null}
          onClose={() => setBurnView(null)}
          size={burnDetails?.byIssue ? "lg" : "md"}
          className="prio-burndown__burndialog"
          title={burnDetails?.title ?? "Burned"}
          description={burnDetails?.description}
        >
          {burnDetails ? (
            <div className="prio-table-wrap">
              <table className="prio-table prio-burndown__burntable">
                <thead>
                  <tr>
                    {burnDetails.byIssue ? <th scope="col">Date</th> : null}
                    <th scope="col">Issue key</th>
                    <th scope="col">Issue name</th>
                    <th scope="col">What happened</th>
                    <th scope="col">Assignee</th>
                    <th scope="col" className="prio-burndown__effortcol">
                      Burned
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {burnDetails.rows.map((burn) => (
                    <tr key={`${burn.issueId}-${burn.date.getTime()}`}>
                      {burnDetails.byIssue ? (
                        <td className="prio-burndown__burndate">
                          {formatDayMonthYear(burn.date)}
                        </td>
                      ) : null}
                      <td>
                        <Link
                          href={`/issues/${burn.key.toLowerCase()}`}
                          className="prio-key"
                        >
                          {burn.key}
                        </Link>
                      </td>
                      <td>{burn.title}</td>
                      <td>
                        {burn.finished
                          ? `Finished${burn.status ? ` · ${STATUS_LABEL[burn.status]}` : ""}`
                          : "Remaining effort lowered"}
                      </td>
                      <td>
                        {burn.assignee ? (
                          <span className="prio-burndown__person">
                            <Avatar name={burn.assignee} size="xs" />
                            {burn.assignee}
                          </span>
                        ) : (
                          <span className="prio-text-muted">Unassigned</span>
                        )}
                      </td>
                      <td className="prio-burndown__effortcol">
                        {hours(burn.hours)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row" colSpan={burnDetails.byIssue ? 5 : 4}>
                      {burnDetails.byIssue ? "Burned in all" : "Burn today"}
                    </th>
                    <td className="prio-burndown__effortcol">
                      <strong>{hours(burnDetails.total)}</strong>
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          ) : null}
        </Dialog>
      </div>

      <figcaption className="prio-burndown__legend">
        {/*
         * What each line is, said in full.
         *
         * Both lines are the ones they always were and are drawn from the
         * same arithmetic; what was missing was the sentence that tells a
         * reader which is a measurement and which is a reference. "Remaining"
         * is what the sprint still owes, day by day; "Ideal" is where an
         * evenly burning sprint would be — it describes nothing that
         * happened, which is exactly why it is dashed.
         */}
        <span className="prio-burndown__key" data-line="actual">
          Remaining{" "}
          <span className="prio-text-muted">— effort still to do</span>
        </span>
        <span className="prio-burndown__key" data-line="ideal">
          Ideal <span className="prio-text-muted">— an even burn to zero</span>
        </span>
        {/* The marks on the axis, named — otherwise they are decoration. */}
        {data.scopeAdded > 0 || data.scopeRemoved < 0 ? (
          <span className="prio-burndown__key" data-line="scope">
            Scope change{" "}
            <span className="prio-text-muted">— work added or taken out</span>
          </span>
        ) : null}
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
       * The day's own work, as a table under the chart.
       *
       * Everything the panel says about a day except the arithmetic, in a
       * form that stays still: who holds each issue, what state it is in,
       * what it owes, and — for the ones that moved — what moved. It answers
       * the half of "what changed?" that a pointer cannot, because these rows
       * can be read at leisure and clicked through to the issue.
       *
       * It follows the day being read and keeps showing it after the pointer
       * has gone, so reaching for a row does not change the rows.
       */}
      {tableDay ? (
        <div className="prio-burndown__table">
          <p className="prio-burndown__tablehead">
            <span className="prio-burndown__tabletitle">
              Issues on {formatDayMonthYear(tableDay.date)}
            </span>
            <span className="prio-text-muted">
              {tableRows.length === 0
                ? "Nothing was open or changed on this day"
                : `${tableRows.length} ${tableRows.length === 1 ? "issue" : "issues"} · hover the chart to read another day`}
            </span>
          </p>

          {tableRows.length > 0 ? (
            <table className="prio-burndown__issuetable">
              <thead>
                <tr>
                  {/* A column for the mark, named for a screen reader and
                      empty on screen — the mark repeats what the row's own
                      words already say. */}
                  <th scope="col" className="prio-burndown__markcol">
                    <span className="prio-visually-hidden">Change</span>
                  </th>
                  <th scope="col">Issue Key</th>
                  <th scope="col">Summary</th>
                  <th scope="col">Status</th>
                  <th scope="col">Assignee</th>
                  <th scope="col" className="prio-burndown__effortcol">
                    Effort
                  </th>
                  {/* Beside Effort: what the issue still owed at the end of
                      the day, and what it had burned from the sprint's
                      first day up to it. */}
                  <th scope="col" className="prio-burndown__effortcol">
                    Remaining
                  </th>
                  <th scope="col" className="prio-burndown__effortcol">
                    Burned
                  </th>
                </tr>
              </thead>
              <tbody>
                {tableRowsWithBurn.map((row) => (
                  <tr key={row.issueId}>
                    {/* The mark the reference carries down the left edge: an
                        arrow for work that arrived or left, a dot for work
                        that came back, nothing for a row that is simply still
                        open. */}
                    <td className="prio-burndown__markcol">
                      {row.reason === null ? null : (
                        <span
                          className="prio-burndown__rowmark"
                          data-reason={row.reason}
                          aria-hidden
                        >
                          {row.reason === "added"
                            ? "↑"
                            : row.reason === "removed"
                              ? "↓"
                              : "●"}
                        </span>
                      )}
                    </td>
                    <td>
                      {/* The issue's own page, by the route the rest of Prio
                          uses — the key is the link, as it is everywhere
                          else. */}
                      <Link
                        href={`/issues/${row.key.toLowerCase()}`}
                        className="prio-key"
                      >
                        {row.key}
                      </Link>
                    </td>
                    <td className="prio-burndown__summarycell">
                      <span className="prio-truncate">{row.title}</span>
                      {/* Why this row is here, when it is here because
                          something happened to it — and, for a row that
                          changed without moving any effort, that it did
                          not. */}
                      {row.reason === null ? null : (
                        <span
                          className="prio-burndown__rowreason"
                          data-reason={row.reason}
                        >
                          {row.reason === "qa"
                            ? "moved to QA"
                            : REASON_LABEL[row.reason]}
                          {row.delta
                            ? ` · ${signed(row.delta)}`
                            : " · no effort change this day"}
                        </span>
                      )}
                    </td>
                    <td className="prio-burndown__statuscell">
                      {row.status ? (
                        <StatusPill status={row.status} />
                      ) : (
                        <span className="prio-text-muted">—</span>
                      )}
                    </td>
                    <td>
                      {row.assignee === null ? (
                        <span className="prio-text-muted">Unassigned</span>
                      ) : (
                        <span className="prio-burndown__person">
                          <Avatar name={row.assignee} size="xs" />
                          {row.assignee}
                        </span>
                      )}
                    </td>
                    <td className="prio-burndown__effortcol">
                      {hours(row.effortHours)}
                    </td>
                    <td className="prio-burndown__effortcol">
                      {hours(row.remainingHours)}
                    </td>
                    <td className="prio-burndown__effortcol">
                      {/* Opens the burns behind the figure; a nought has
                          none to show, so it is plain text. */}
                      {row.burnedHours > 0 ? (
                        <button
                          type="button"
                          className="prio-burndown__burnlink"
                          aria-label={`${hours(row.burnedHours)} burned on ${row.key}: show the burns`}
                          onClick={() =>
                            setBurnView({
                              kind: "issue",
                              issueId: row.issueId,
                              upTo: tableIndex!,
                            })
                          }
                        >
                          {hours(row.burnedHours)}
                        </button>
                      ) : (
                        hours(0)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      ) : null}

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
              {/* The day's own movement, in the same words the panel uses —
                  including a flat day, which is an answer and not a
                  silence. */}
              {point.change === null
                ? ""
                : point.change === 0
                  ? " No effort completed today; change 0h."
                  : ` ${point.change < 0 ? "Burned" : "Added"} ${hours(Math.abs(point.change))} today; change ${signed(point.change)}.`}
              {point.changes
                .map(
                  (change) =>
                    ` ${change.key} ${REASON_LABEL[change.reason]}, ${signed(change.delta)}.`,
                )
                .join("")}
              {point.movedToQa
                .map((issue) => ` ${issue.key} moved to QA.`)
                .join("")}
            </li>
          );
        })}
      </ul>
    </figure>
  );
}
