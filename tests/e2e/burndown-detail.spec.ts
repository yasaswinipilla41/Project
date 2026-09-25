import { expect, test } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { openBurndown } from "./support";

/**
 * What the burndown says beyond the two lines.
 *
 * The chart answers "how much is left". The figures above it say what the
 * sprint is made of, the detail under the pointer says which issues that
 * remainder is and what moved it, and the marker says where today falls. The
 * arithmetic behind all three is pinned in `tests/burndown.test.ts`; this
 * drives the real page, so what it checks is that the page shows those
 * answers and that they agree with the sprint's own work.
 */

const createdProjects: string[] = [];
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

test.afterAll(async () => {
  for (const id of createdProjects) {
    await prisma.activityLogEntry.deleteMany({
      where: { issue: { projectId: id } },
    });
    await prisma.issue.deleteMany({ where: { projectId: id } });
    await prisma.sprint.deleteMany({ where: { projectId: id } });
    await prisma.project.deleteMany({ where: { id } });
  }
});

/**
 * A running sprint of 30 estimated hours: 10 of them finished five days ago,
 * and 20 still open. The finish is recorded in the issue's own trail, which
 * is what lets the chart say when the line stepped and why.
 */
async function seedRunningSprint() {
  const admin = await prisma.user.findFirstOrThrow({
    where: { role: "ADMIN" },
    select: { id: true },
  });
  const key = `BD${Date.now().toString(36).toUpperCase()}`.slice(0, 10);
  const project = await prisma.project.create({
    data: {
      key,
      name: `Burndown detail fixture ${key}`,
      createdById: admin.id,
      members: { create: { userId: admin.id } },
      issueSequence: 2,
    },
    select: { id: true, key: true },
  });
  createdProjects.push(project.id);

  const start = ago(7);
  const sprint = await prisma.sprint.create({
    data: {
      name: `E2E burndown detail ${Date.now()}`,
      startDate: start,
      endDate: new Date(Date.now() + 6 * DAY),
      projectId: project.id,
      createdById: admin.id,
      status: "ACTIVE",
      startedAt: start,
    },
    select: { id: true },
  });

  const finished = await prisma.issue.create({
    data: {
      projectId: project.id,
      key: `${project.key}-1`,
      number: 1,
      title: "Ten hours, finished",
      type: "TASK",
      status: "DONE",
      reporterId: admin.id,
      sprintId: sprint.id,
      effortHours: 10,
      remainingHours: 10,
    },
    select: { id: true, key: true },
  });
  await prisma.activityLogEntry.create({
    data: {
      issueId: finished.id,
      actorId: admin.id,
      action: "issue.updated",
      field: "status",
      oldValue: "IN_PROGRESS",
      newValue: "DONE",
      createdAt: ago(5),
    },
  });

  const open = await prisma.issue.create({
    data: {
      projectId: project.id,
      key: `${project.key}-2`,
      number: 2,
      title: "Twenty hours, still going",
      type: "TASK",
      status: "IN_PROGRESS",
      reporterId: admin.id,
      sprintId: sprint.id,
      effortHours: 20,
      remainingHours: 20,
    },
    select: { id: true, key: true },
  });

  return {
    key: project.key.toLowerCase(),
    sprintId: sprint.id,
    finished,
    open,
  };
}

test.describe("The burndown's detail", () => {
  test("shows what the sprint is made of, and what each day is made of", async ({
    page,
  }) => {
    const { key, sprintId, finished, open } = await seedRunningSprint();

    await page.goto(`/projects/${key}/sprints/${sprintId}`);
    await openBurndown(page);
    const chart = page.locator(".prio-burndown");
    await chart.waitFor({ timeout: 45_000 });

    // ------------------------------------------- the figures above the chart
    /* 30 hours committed, 10 finished, 20 left, across two issues — every one
       of them read from the sprint's own work rather than written here. */
    const figures = await chart
      .locator(".prio-burndown__figure")
      .evaluateAll((nodes) =>
        nodes.map((node) => [
          node.querySelector("dt")!.textContent!.trim(),
          node.querySelector("dd")!.textContent!.trim(),
        ]),
      );
    /*
     * Six figures, every one read off the sprint's own work.
     *
     * What the sprint opened with, what is done, what is left, how many
     * issues of how many that is, whether the scope moved, and how far
     * through the commitment that puts it. This sprint's scope never moved,
     * so it says None; progress is the same definition the marker for today
     * quotes, and is labelled "of effort" because the sprint block above the
     * chart carries a progress figure counted in issues.
     */
    expect(figures).toEqual([
      ["Initial Effort", "30h"],
      ["Total Effort", "30h"],
      ["Completed Effort", "10h"],
      ["Remaining Effort", "20h"],
      ["Completed Issues", "1/2"],
      ["Scope Changes", "None"],
      ["Sprint Progress of effort", "33%"],
    ]);

    /*
     * And the progress bar beside that last figure says the same number — for
     * a reader who takes it from the shape rather than from the digits.
     *
     * Measured, not merely present. The fill is a `span`, and an inline box
     * ignores both the width the component sets on it and its own
     * `height: 100%`, so it collapsed to nothing and the bar read as an empty
     * track. What has to hold is that the painted fill really is that
     * fraction of the track.
     */
    const bar = chart.locator(".prio-burndown__progressbar");
    await expect(bar).toHaveAttribute("aria-valuenow", "33");
    const painted = await bar.evaluate((track) => {
      const fill = track.querySelector(".prio-progress__bar")!;
      const outer = track.getBoundingClientRect();
      const inner = fill.getBoundingClientRect();
      return {
        share: outer.width === 0 ? 0 : (inner.width / outer.width) * 100,
        height: Math.round(inner.height),
      };
    });
    expect(painted.share, "the fill is not painted").toBeGreaterThan(25);
    expect(painted.share, "the fill is not the figure's share").toBeLessThan(
      41,
    );
    expect(painted.height, "the fill has no height").toBeGreaterThan(0);

    // ---------------------------------------------- a marker for right now
    /* The sprint is the one being worked, so today is marked — with what is
       left, how many issues that is, and how much of the effort is burned. */
    await expect(chart.locator("line.prio-burndown__today")).toHaveCount(1);
    /*
     * The marker's own panel: the four answers it is read for, each on its
     * own line, without hovering anything.
     */
    const today = chart.locator(".prio-burndown__todaytag");
    await expect(today).toContainText("Today (");
    const todayFigures = Object.fromEntries(
      await today
        .locator("div")
        .evaluateAll((nodes) =>
          nodes.map((node) => [
            node.querySelector("dt")!.textContent!.trim(),
            node.querySelector("dd")!.textContent!.trim(),
          ]),
        ),
    );
    expect(todayFigures["Remaining Effort"]).toBe("20h");
    expect(todayFigures["Completed/Total Issues"]).toBe("1/2");
    expect(todayFigures["Burn Percentage"]).toBe("33%");
    expect(todayFigures["Sprint Time Remaining"]).toMatch(/^\d+ days?$/);

    // --------------------------------------------- the day the line stepped
    /* The sprint started seven days ago and the work was finished five days
       ago, so that is the third day on the chart. */
    const hits = chart.locator(".prio-burndown__hit");
    await hits.nth(2).hover();

    const tip = chart.locator(".prio-burndown__tip");
    await expect(tip).toBeVisible();
    await expect(tip).toContainText("Remaining: 20h");
    await expect(tip).toContainText("Completed: 10h of 30h committed");
    await expect(tip).toContainText("Issues: 1 completed · 1 remaining");

    /* Why it stepped, and by how much. */
    const change = tip.locator(".prio-burndown__tipchanges li");
    await expect(change).toHaveCount(1);
    await expect(change).toContainText(finished.key);
    await expect(change).toContainText("finished");
    await expect(change).toContainText("−10h");

    /* What the day itself did, which the cumulative figures above do not
       say: ten hours went, and the count behind them. */
    await expect(
      tip.locator(".prio-burndown__tipfigures"),
      "the day's own step, among the effort figures",
    ).toContainText("Change since prev: −10h");
    const movement = tip.locator(".prio-burndown__tipchange");
    await expect(movement).toContainText("Burned today: 10h");
    await expect(movement).toContainText("Completed: 1");

    /*
     * And the day's own work, in the table under the chart.
     *
     * The panel says what moved; the table says what the day was carrying,
     * with who holds each issue and what it owes — and unlike the panel it
     * holds still, so its keys can be read and clicked.
     */
    const table = chart.locator(".prio-burndown__table");
    await expect(table).toContainText("Issues on");
    /* The five columns, behind a narrow one for the mark down the left edge —
       empty on screen, and named for a reader who cannot see it. */
    expect(
      await table
        .locator("thead th")
        .evaluateAll((nodes) => nodes.map((node) => node.textContent!.trim())),
    ).toEqual([
      "Change",
      "Issue Key",
      "Summary",
      "Status",
      "Assignee",
      "Effort",
    ]);

    /* Both of the day's issues: the one that was finished that day, and the
       one still going. */
    const rows = table.locator("tbody tr");
    await expect(rows).toHaveCount(2);
    const stillGoing = rows.filter({ hasText: open.key });
    await expect(stillGoing).toContainText("Twenty hours, still going");
    await expect(stillGoing).toContainText("In Progress");
    await expect(stillGoing, "nobody holds it, and it says so").toContainText(
      "Unassigned",
    );
    await expect(stillGoing).toContainText("20h");
    /* The finished one says why it is in the day's list. */
    await expect(rows.filter({ hasText: finished.key })).toContainText(
      "finished",
    );

    /* Its key is the way into the issue, by the route the rest of Prio
       uses. */
    await expect(stillGoing.locator("a.prio-key")).toHaveAttribute(
      "href",
      `/issues/${open.key.toLowerCase()}`,
    );

    // ---------------------------------------- the first day, before the step
    await hits.nth(0).hover();
    await expect(tip).toContainText("Remaining: 30h");
    await expect(tip).toContainText("Issues: 0 completed · 2 remaining");
    /* Nothing had happened yet, so there is nothing to explain. */
    await expect(tip.locator(".prio-burndown__tipchanges")).toHaveCount(0);
    /* And the day says so rather than leaving an empty panel to be read as
       "no data": the first day has no day before it to have moved from. */
    await expect(tip.locator(".prio-burndown__tipfigures")).toContainText(
      "Change since prev: 0h",
    );
    await expect(tip.locator(".prio-burndown__tipchange")).toContainText(
      "first day",
    );

    // --------------------------------------------- a day when nothing moved
    /* The day after the step: the line is flat, and a flat day is an answer.
       The wording is the one the requirement asks for, on the quietest day a
       sprint has. */
    await hits.nth(3).hover();
    await expect(tip.locator(".prio-burndown__tipchange")).toHaveText(
      "No effort completed today",
    );
    await expect(tip.locator(".prio-burndown__tipfigures")).toContainText(
      "Change since prev: 0h",
    );

    /* Moving off the chart puts the detail away. */
    await page.locator(".prio-burndown__summary").hover();
    await expect(tip).toHaveCount(0);
  });

  test("sits beside the point, inside the chart, and never over the table", async ({
    page,
  }) => {
    /*
     * The panel used to float at a fixed height inside the plot, which put it
     * over the marker whenever the remainder was high — hiding the one thing
     * the reader was pointing at. Searching for a position clear of the whole
     * *Remaining* line fixed that but bought it with distance: on a low point
     * the only clear spot was the far side of the plot, hundreds of pixels
     * from the day being described, and on the lowest days the panel opened
     * downward across the *Issues on …* table under the chart.
     *
     * So the placement is anchored now — above, below, or to one side of the
     * marker at a few pixels — and what has to hold, on every day of the
     * sprint and at both ends of it, is: the panel is inside the chart's own
     * card and whole, the marker it describes is not underneath it and keeps
     * its gap, and the table under the chart is never covered. The lines are
     * a preference between positions that all fit, not a veto: a panel this
     * size six pixels from a point cannot always miss a line that crosses the
     * whole plot, and being beside the point matters more. Checked in both
     * themes, because a theme changes the panel's size and so the room it
     * needs.
     */
    const { key, sprintId } = await seedRunningSprint();

    /**
     * Where the panel ended up, against the card, the marker and the line —
     * measured in the page itself, from what the browser actually drew.
     */
    const geometry = () =>
      page.evaluate(() => {
        const dot = document.querySelector("circle.prio-burndown__dot")!;
        const tip = document.querySelector(".prio-burndown__tip")!;
        const svg = document.querySelector(
          "svg.prio-burndown__svg",
        ) as SVGSVGElement;
        const card = document
          .querySelector(".prio-burndown")!
          .closest(".prio-card")!;
        const style = getComputedStyle(tip);
        /* Below the phone step, and on a day with too much to say to fit
           beside the chart, the panel reads in the flow under it — where it
           is part of the card and cannot cover anything. */
        const inflow = style.position === "static";
        const t = tip.getBoundingClientRect();
        const m = dot.getBoundingClientRect();
        const c = card.getBoundingClientRect();

        type Segment = { ax: number; ay: number; bx: number; by: number };
        /* The drawn line, back through the SVG's screen matrix so it can be
           compared with a panel measured in pixels. */
        const lineOf = (selector: string): Segment[] => {
          const poly = svg?.querySelector<SVGPolylineElement>(selector);
          const matrix = svg?.getScreenCTM();
          if (!poly || !matrix) return [];
          const points: { x: number; y: number }[] = [];
          for (let i = 0; i < poly.points.numberOfItems; i += 1) {
            points.push(poly.points.getItem(i).matrixTransform(matrix));
          }
          return points.slice(1).map((point, index) => ({
            ax: points[index]!.x,
            ay: points[index]!.y,
            bx: point.x,
            by: point.y,
          }));
        };
        const crosses = (one: Segment, two: Segment) => {
          const side = (
            ax: number,
            ay: number,
            bx: number,
            by: number,
            cx: number,
            cy: number,
          ) => Math.sign((bx - ax) * (cy - ay) - (by - ay) * (cx - ax));
          return (
            side(one.ax, one.ay, one.bx, one.by, two.ax, two.ay) !==
              side(one.ax, one.ay, one.bx, one.by, two.bx, two.by) &&
            side(two.ax, two.ay, two.bx, two.by, one.ax, one.ay) !==
              side(two.ax, two.ay, two.bx, two.by, one.bx, one.by)
          );
        };
        const onLine = (box: DOMRect, line: Segment[]) =>
          line.some((segment) => {
            const inside = (x: number, y: number) =>
              x >= box.left &&
              x <= box.right &&
              y >= box.top &&
              y <= box.bottom;
            if (
              inside(segment.ax, segment.ay) ||
              inside(segment.bx, segment.by)
            ) {
              return true;
            }
            return (
              [
                { ax: box.left, ay: box.top, bx: box.right, by: box.top },
                { ax: box.right, ay: box.top, bx: box.right, by: box.bottom },
                { ax: box.right, ay: box.bottom, bx: box.left, by: box.bottom },
                { ax: box.left, ay: box.bottom, bx: box.left, by: box.top },
              ] as Segment[]
            ).some((side) => crosses(segment, side));
          });
        const hits = (a: DOMRect, z: DOMRect) =>
          !(
            z.right <= a.left ||
            z.left >= a.right ||
            z.bottom <= a.top ||
            z.top >= a.bottom
          );

        return {
          inflow,
          /* Inside the card it belongs to, and not cut off by it. */
          escapes: Math.round(
            Math.max(
              0,
              c.left - t.left,
              t.right - c.right,
              c.top - t.top,
              t.bottom - c.bottom,
            ),
          ),
          /*
           * And on the screen, whole.
           *
           * A panel is read where it is put, and the reader cannot scroll to
           * one: the pointer has to stay on the day for the panel to exist,
           * and scrolling takes the page out from under the pointer, which
           * ends the hover and takes the panel with it. So a panel below the
           * fold is one that vanishes as the reader reaches for it — which is
           * what the tallest day used to do, reading in the flow under a chart
           * that sat at the bottom of the window.
           */
          offScreen: Math.round(
            Math.max(
              0,
              -t.top,
              t.bottom - window.innerHeight,
              -t.left,
              t.right - window.innerWidth,
            ),
          ),
          coversMarker: inflow ? false : hits(m, t),
          /*
           * The table under the chart lists the day being read, and a panel
           * over it hides the very rows the reader is being pointed at. Hard:
           * the placement's lower boundary is the table's top edge, not the
           * card's bottom.
           */
          coversTable: (() => {
            const table = document.querySelector(".prio-burndown__table");
            if (inflow || !table) return false;
            return hits(table.getBoundingClientRect(), t);
          })(),
          onRemainingLine: inflow
            ? false
            : onLine(t, lineOf("polyline.prio-burndown__actual")),
          /* The gap it keeps from the point, on whichever side it opened. */
          gap: inflow
            ? null
            : Math.round(
                Math.hypot(
                  Math.max(t.left - m.right, m.left - t.right, 0),
                  Math.max(t.top - m.bottom, m.top - t.bottom, 0),
                ),
              ),
          /* Which way it opened, for the record: every one of these is
             reached by some day of some sprint. */
          side: inflow
            ? "flow"
            : t.bottom <= m.top
              ? "above"
              : t.top >= m.bottom
                ? "below"
                : t.right <= m.left
                  ? "left"
                  : t.left >= m.right
                    ? "right"
                    : "on the point",
          /* Hovering must stay smooth, so the panel is not a target
             itself. */
          pointerEvents: style.pointerEvents,
          /* What "far" is measured against. */
          chartWidth: document
            .querySelector(".prio-burndown__svg")!
            .getBoundingClientRect().width,
        };
      });

    for (const theme of ["light", "dark"] as const) {
      /** Every floating day's gap, at every width, for this theme. */
      const gaps: number[] = [];
      /** How many of them landed clear of the remaining line. */
      let clearOfLine = 0;

      /*
       * Two windows, and two places on the page.
       *
       * How far the page is scrolled used to decide where the panel went: the
       * position under the chart counted as a candidate whenever it happened
       * to be on screen, and for the days along the bottom of the plot it
       * measured as the closest one — so the same day answered beside its
       * point at the top of the page and underneath the chart once the reader
       * had scrolled. Both states are read here.
       */
      for (const [width, height] of [
        [1440, 900],
        [1024, 768],
      ] as const) {
        for (const at of [
          "top of the page",
          "chart at the fold",
          "chart in the middle",
        ] as const) {
          await page.setViewportSize({ width, height });
          await page.goto(`/projects/${key}/sprints/${sprintId}`);
          /* The theme is an attribute on <html>, set from storage on load —
             so it is set here after the load, the way the app's own switcher
             sets it. */
          await page.evaluate(
            (value) =>
              document.documentElement.setAttribute("data-theme", value),
            theme,
          );
          await expect(page.locator("html")).toHaveAttribute(
            "data-theme",
            theme,
          );
          /* The chart lives behind the sprint header's button now, and each
             turn of this loop loads the page again — so it is opened again
             here, before anything measures it. */
          await openBurndown(page);
          const chart = page.locator(".prio-burndown");
          await chart.waitFor({ timeout: 45_000 });
          if (at === "chart at the fold") {
            /* The plot's bottom edge just above the window's: everywhere the
               panel could read in the flow is then off the screen, so this is
               the state where it has to be placed beside the point or not at
               all. */
            await chart.evaluate((node) => {
              const plot = node.querySelector(".prio-burndown__svg")!;
              window.scrollBy(
                0,
                plot.getBoundingClientRect().bottom - window.innerHeight + 4,
              );
            });
          }
          if (at === "chart in the middle") {
            /* And the state where the flow *is* on the screen and a few
               pixels under the bottom row of points — which is where it used
               to beat a placement beside the point on distance, and so where
               the scroll position used to decide the answer. */
            await chart.evaluate((node) =>
              node.scrollIntoView({ block: "center" }),
            );
          }

          const hits = chart.locator(".prio-burndown__hit");
          const days = await hits.count();
          expect(days).toBeGreaterThan(2);

          /* Every day, which is every position across the plot — the first
             and last days are its left and right boundaries, and this
             sprint's line runs from the top of the scale to the bottom of it,
             so its points sit against the top and bottom boundaries too. */
          for (let day = 0; day < days; day += 1) {
            await hits.nth(day).hover();
            await expect(chart.locator(".prio-burndown__tip")).toBeVisible();

            const where = `${theme}, ${width}px, ${at}, day ${day}`;
            const seen = await geometry();
            expect(seen.escapes, `${where}: outside the card`).toBeLessThan(1);
            expect(seen.offScreen, `${where}: off the screen`).toBe(0);
            expect(seen.coversMarker, `${where}: covers the marker`).toBe(
              false,
            );
            expect(seen.coversTable, `${where}: covers the table`).toBe(false);
            expect(seen.pointerEvents).toBe("none");
            /* Beside its point, not under the chart — at these widths there
               is always a placement, so falling to the flow would mean the
               scroll position had decided it. */
            expect(seen.inflow, `${where}: read under the chart`).toBe(false);
            if (!seen.onRemainingLine) clearOfLine += 1;
            /*
             * Beside the point, at the spacing — not merely somewhere inside
             * the card.
             *
             * The lower bound is the spacing itself: the marker and its
             * crosshair have to be visible, not merely uncovered. The upper
             * one is the bug this replaced — the panel used to be sent to the
             * far edge of the card, two to six hundred pixels from the day it
             * was describing, whenever the line blocked the obvious
             * positions. It searches finely now, and reads under the chart
             * rather than desert the point, so a day of this sprint is never
             * more than a panel's width away from its own detail.
             */
            expect(
              seen.gap,
              `${where}: no gap from the point`,
            ).toBeGreaterThanOrEqual(4);
            expect(
              seen.gap,
              `${where}: too far from the point`,
            ).toBeLessThanOrEqual(12);
            gaps.push(seen.gap!);
          }
        }
      }

      /*
       * Every floating day sits at the spacing, and the line is still
       * preferred clear.
       *
       * Clearing the remaining line is a preference now rather than a
       * requirement: at six pixels from a point, a panel this size cannot
       * always miss a line that crosses the whole plot, and being beside the
       * point it describes matters more than which pixels of the line are
       * behind it. The preference is what decides between placements that
       * both fit, so on a sprint with this many days some of them do come out
       * clear — if none ever did, the preference would have stopped
       * working.
       */
      expect(gaps.length, `${theme}: no day floated at all`).toBeGreaterThan(0);
      expect(
        clearOfLine,
        `${theme}: no day's panel is clear of the remaining line`,
      ).toBeGreaterThan(0);
    }
  });

  test("answers in the same place however far the page is scrolled", async ({
    page,
  }) => {
    /*
     * Where the panel goes is a question about the chart, not about the page.
     *
     * It briefly was about both. Reading in the flow under the chart competed
     * with the placements beside the point on distance, and only counted when
     * it was on screen — so for the days sitting on the floor of the plot,
     * where the flow is a few pixels below the point, the answer changed as
     * the reader scrolled: beside the point at the top of the page, and then
     * underneath the chart once there was room on screen for it to be there.
     *
     * A reader cannot even get to a panel that goes there. The pointer has to
     * stay on the day for the panel to exist, and scrolling moves the page out
     * from under the pointer, which ends the hover — so a panel below the fold
     * disappears as they reach for it, which is how this was reported.
     */
    const { key, sprintId } = await seedBurnedToZero();

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/projects/${key}/sprints/${sprintId}`);
    await openBurndown(page);
    const chart = page.locator(".prio-burndown");
    await chart.waitFor({ timeout: 45_000 });

    const hits = chart.locator(".prio-burndown__hit");
    /* A day on the floor with the climb behind it: the fourth, which is two
       days after the work was finished and two before the rest arrived. */
    const onTheFloor = 4;
    expect(await hits.count()).toBeGreaterThan(onTheFloor);

    /** Which side of its point the panel opened, and how far off it is. */
    const placement = () =>
      page.evaluate(() => {
        const dot = document.querySelector("circle.prio-burndown__dot")!;
        const tip = document.querySelector(".prio-burndown__tip")!;
        const t = tip.getBoundingClientRect();
        const m = dot.getBoundingClientRect();
        return {
          side:
            getComputedStyle(tip).position === "static"
              ? "under the chart"
              : t.bottom <= m.top
                ? "above"
                : t.top >= m.bottom
                  ? "below"
                  : t.right <= m.left
                    ? "left"
                    : "right",
          gap: Math.round(
            Math.hypot(
              Math.max(t.left - m.right, m.left - t.right, 0),
              Math.max(t.top - m.bottom, m.top - t.bottom, 0),
            ),
          ),
          offScreen: Math.round(
            Math.max(
              0,
              -t.top,
              t.bottom - window.innerHeight,
              -t.left,
              t.right - window.innerWidth,
            ),
          ),
        };
      });

    const sides = new Set<string>();
    for (const at of ["top", "middle", "fold"] as const) {
      await page.evaluate(() => window.scrollTo(0, 0));
      if (at === "middle") {
        await chart.evaluate((node) =>
          node.scrollIntoView({ block: "center" }),
        );
      }
      if (at === "fold") {
        await chart.evaluate((node) => {
          const plot = node.querySelector(".prio-burndown__svg")!;
          window.scrollBy(
            0,
            plot.getBoundingClientRect().bottom - window.innerHeight + 4,
          );
        });
      }

      await hits.nth(onTheFloor).hover();
      await expect(chart.locator(".prio-burndown__tip")).toBeVisible();
      const seen = await placement();
      expect(seen.side, `${at}: not beside the point`).not.toBe(
        "under the chart",
      );
      expect(seen.gap, `${at}: too far from the point`).toBeLessThanOrEqual(12);
      expect(seen.offScreen, `${at}: off the screen`).toBe(0);
      sides.add(seen.side);
    }

    /* And the same side in each of them: the day's answer is where the day is,
       not where the page happens to be. */
    expect(
      [...sides],
      "the panel moved because the page was scrolled",
    ).toHaveLength(1);
  });

  test("a day with more to say than fits gives up rows, not its place", async ({
    page,
  }) => {
    /*
     * Ten changes on one day, which no screen can list beside a point.
     *
     * The panel used to take the other way out: too tall for the room between
     * the chart and the table, it read in the flow under the chart — and on a
     * window of ordinary height that is below the fold. The reader would go to
     * scroll down to it and the panel would disappear as they did, because
     * scrolling moves the page out from under the pointer and the hover ends
     * with it. That is the fault this is about.
     *
     * So height is traded for position: the list gives up rows until the panel
     * fits beside its day, and says how many it left out. Nothing is lost —
     * the table under the chart lists the day in full, which is what the
     * counting line points at.
     */
    const { key, sprintId } = await seedBusyDay();

    /** What the day added up to, per window: listed rows plus counted ones. */
    const accounted: number[] = [];

    for (const [width, height] of [
      [1550, 950],
      [1440, 900],
      [1024, 700],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.goto(`/projects/${key}/sprints/${sprintId}`);
      await openBurndown(page);
      const chart = page.locator(".prio-burndown");
      await chart.waitFor({ timeout: 45_000 });

      const hits = chart.locator(".prio-burndown__hit");
      const days = await hits.count();

      /* The busy day is the one with the longest list — found rather than
         counted out, so the fixture's dates are free to move. */
      let busiest = { day: 0, rows: -1 };
      for (let day = 0; day < days; day += 1) {
        await hits.nth(day).hover();
        await expect(chart.locator(".prio-burndown__tip")).toBeVisible();
        const rows = await chart
          .locator(".prio-burndown__tipchanges > li")
          .count();
        if (rows > busiest.rows) busiest = { day, rows };
      }
      expect(
        busiest.rows,
        `${width}px: no day listed anything`,
      ).toBeGreaterThan(1);

      await hits.nth(busiest.day).hover();
      await expect(chart.locator(".prio-burndown__tip")).toBeVisible();

      const seen = await page.evaluate(() => {
        const dot = document.querySelector("circle.prio-burndown__dot")!;
        const tip = document.querySelector(".prio-burndown__tip")!;
        const table = document.querySelector(".prio-burndown__table")!;
        const t = tip.getBoundingClientRect();
        const m = dot.getBoundingClientRect();
        const tb = table.getBoundingClientRect();
        return {
          inflow: getComputedStyle(tip).position === "static",
          gap: Math.round(
            Math.hypot(
              Math.max(t.left - m.right, m.left - t.right, 0),
              Math.max(t.top - m.bottom, m.top - t.bottom, 0),
            ),
          ),
          offScreen: Math.round(
            Math.max(
              0,
              -t.top,
              t.bottom - window.innerHeight,
              -t.left,
              t.right - window.innerWidth,
            ),
          ),
          coversTable: !(
            t.right <= tb.left ||
            t.left >= tb.right ||
            t.bottom <= tb.top ||
            t.top >= tb.bottom
          ),
          /* The rows it is showing, and what it says about the rest. */
          listed: tip.querySelectorAll(
            ".prio-burndown__tipchanges > li:not(.prio-burndown__tipmore)",
          ).length,
          more: tip
            .querySelector(".prio-burndown__tipmore")
            ?.textContent?.trim(),
        };
      });

      const where = `${width}x${height}`;
      /* Beside its day, whole, on the screen, and off the table. */
      expect(seen.inflow, `${where}: read under the chart instead`).toBe(false);
      expect(seen.gap, `${where}: not beside the point`).toBeLessThanOrEqual(
        12,
      );
      expect(seen.offScreen, `${where}: off the screen`).toBe(0);
      expect(seen.coversTable, `${where}: covers the table`).toBe(false);

      /*
       * And the day is still accounted for in full.
       *
       * The rows given up are counted, and the count is of the rows actually
       * given up — which is the part a trim can quietly get wrong, by dropping
       * rows and leaving behind the number that was written for the untrimmed
       * list. So what the panel lists plus what it says it left out has to be
       * the same day whatever the window: the window decides how much of the
       * day is shown, never how big the day was.
       */
      expect(
        seen.more ?? "",
        `${where}: nothing said about the rest`,
      ).toContain("the table below has the day in full");
      const left = Number(seen.more!.match(/and (\d+) more/)![1]);
      expect(left, `${where}: says it left out nothing`).toBeGreaterThan(0);
      expect(seen.listed, `${where}: lists nothing at all`).toBeGreaterThan(1);
      accounted.push(seen.listed + left);
    }

    expect(
      new Set(accounted).size,
      `the day came to ${accounted.join(", ")} as the window changed`,
    ).toBe(1);
  });

  test("is the size of its own contents, at every point and every width", async ({
    page,
  }) => {
    /*
     * The box's width is its content's, and nothing else's.
     *
     * It briefly was not: the placement tried the panel at a few narrower
     * widths so that one which would not fit beside a point could wrap into a
     * column that did, which made the width a function of where it fitted.
     * The same day's detail then read one width on one screen and another on
     * the next — and a build whose card is a little taller, as a deployed one
     * is, could fall through to the widest of them on the lower points. On
     * top of that the panel reading under the chart was `width: auto`, which
     * in the flow means the card's width: a tooltip stretched across the
     * whole chart.
     *
     * So what has to hold, whatever the point and whatever the width of the
     * window: the box is no wider than the reading measure, it is not a
     * stripe across the chart, and the room left over inside it is small —
     * which is what "sized to its contents" means once the text has wrapped.
     */
    const { key, sprintId } = await seedRunningSprint();

    /** The box, and how much of it the words inside it actually use. */
    const box = () =>
      page.evaluate(() => {
        const tip = document.querySelector(
          ".prio-burndown__tip",
        ) as HTMLElement;
        const chart = document.querySelector(".prio-burndown__svg")!;
        const style = getComputedStyle(tip);
        const t = tip.getBoundingClientRect();
        const inner =
          t.width -
          parseFloat(style.paddingLeft) -
          parseFloat(style.paddingRight) -
          parseFloat(style.borderLeftWidth) -
          parseFloat(style.borderRightWidth);
        const left =
          t.left +
          parseFloat(style.paddingLeft) +
          parseFloat(style.borderLeftWidth);

        /*
         * The rightmost ink in the box: each row's own line boxes and each
         * element within it, because a row is a flex line whose ink ends at
         * its last item rather than at its widest one.
         */
        const range = document.createRange();
        let ink = 0;
        for (const row of Array.from(tip.querySelectorAll("p, li"))) {
          range.selectNodeContents(row);
          for (const rect of Array.from(range.getClientRects())) {
            ink = Math.max(ink, rect.right - left);
          }
          for (const child of Array.from(row.querySelectorAll("*"))) {
            ink = Math.max(ink, child.getBoundingClientRect().right - left);
          }
        }

        /*
         * And the width it would have in the other mode.
         *
         * The panel is either placed beside the point or read in the flow
         * under the chart, and which one it gets depends on the room around
         * the point — so a fixture that only ever floats would never see the
         * flow's own width. That is where the reported fault lived: in the
         * flow the box was `width: auto`, which means the card's width, so
         * the same detail became a stripe across the chart as soon as the
         * placement fell through to it. Both are measured here, and the claim
         * is that they are the same box.
         */
        const floating = !tip.classList.contains("is-inflow");
        tip.classList.toggle("is-inflow");
        const other = Math.round(tip.getBoundingClientRect().width);
        tip.classList.toggle("is-inflow");

        return {
          width: Math.round(t.width),
          /* Empty room at the right-hand edge. */
          slack: Math.round(inner - ink),
          shareOfChart: t.width / chart.getBoundingClientRect().width,
          /* Nothing may size the panel from JavaScript: the stylesheet is the
             only thing that decides how wide it is. */
          inlineWidth: `${tip.style.width}|${tip.style.maxWidth}`,
          mode: floating ? "float" : "flow",
          otherModeWidth: other,
        };
      });

    /** Every day's width, per window width, so the two can be compared. */
    const byViewport = new Map<number, number[]>();

    for (const [width, height] of [
      [1550, 900],
      [1280, 800],
      [1024, 768],
      [900, 700],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.goto(`/projects/${key}/sprints/${sprintId}`);
      await openBurndown(page);
      const chart = page.locator(".prio-burndown");
      await chart.waitFor({ timeout: 45_000 });

      const hits = chart.locator(".prio-burndown__hit");
      const days = await hits.count();
      const widths: number[] = [];

      for (let day = 0; day < days; day += 1) {
        await hits.nth(day).hover();
        await expect(chart.locator(".prio-burndown__tip")).toBeVisible();

        const where = `${width}px, day ${day}`;
        const seen = await box();
        /* The reading measure the stylesheet sets, and never more. */
        expect(
          seen.width,
          `${where}: wider than the measure`,
        ).toBeLessThanOrEqual(420);
        /* Not a stripe across the chart. */
        expect(
          seen.shareOfChart,
          `${where}: stretched across the chart`,
        ).toBeLessThan(0.75);
        /* Sized to the words in it: what is left over is a ragged edge, not a
           field of empty box. */
        expect(
          seen.slack,
          `${where}: box far wider than its text`,
        ).toBeLessThan(90);
        expect(seen.inlineWidth, `${where}: sized from script`).toBe("|");
        /* The same box whichever way it is drawn — floating beside the point
           or reading in the flow under the chart. */
        expect(
          Math.abs(seen.otherModeWidth - seen.width),
          `${where}: ${seen.mode === "float" ? "the flow" : "the floating"} width differs`,
        ).toBeLessThan(6);
        expect(
          seen.otherModeWidth,
          `${where}: wider than the measure in the other mode`,
        ).toBeLessThanOrEqual(420);
        widths.push(seen.width);
      }

      byViewport.set(width, widths);
    }

    /*
     * The same day is the same width whatever the window is.
     *
     * This is the property the reported fault was about: a box whose width
     * came from where it happened to fit rather than from what was in it.
     * Days differ from one another — a quiet day says less than a day with
     * six changes on it, and should be smaller — but one day's panel must not
     * change size because the card did.
     */
    const widths = [...byViewport.values()];
    for (let day = 0; day < widths[0]!.length; day += 1) {
      const across = widths.map((row) => row[day]!);
      expect(
        Math.max(...across) - Math.min(...across),
        `day ${day}: the width follows the window rather than the content`,
      ).toBeLessThanOrEqual(2);
    }
  });

  test("follows the pointer from point to point, and goes away after it", async ({
    page,
  }) => {
    /*
     * What hovering has to do: answer for the day under the pointer, keep
     * answering for the right one as the pointer moves along the line, and
     * stop when the pointer leaves. A panel left behind — or left showing the
     * day before — is worse than no panel, because it reads as a fact about
     * the day being pointed at.
     */
    const { key, sprintId } = await seedRunningSprint();

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/projects/${key}/sprints/${sprintId}`);
    await openBurndown(page);
    const chart = page.locator(".prio-burndown");
    await chart.waitFor({ timeout: 45_000 });

    const hits = chart.locator(".prio-burndown__hit");
    const tip = chart.locator(".prio-burndown__tip");
    const days = await hits.count();

    /* The dates the chart itself says each day is, read from the text it
       writes for a screen reader — so the expectation is the page's own and
       not a format typed in here. */
    const spoken = await chart
      .locator(".prio-visually-hidden li")
      .allTextContents();
    expect(spoken.length).toBe(days);

    for (let day = 0; day < days; day += 1) {
      await hits.nth(day).hover();
      await expect(tip).toBeVisible();

      /* The date in the panel is this day's, so nothing stale survives the
         move from the day before. */
      const date = spoken[day]!.split(":")[0]!.trim();
      await expect(
        tip.locator(".prio-burndown__tipdate"),
        `day ${day} shows another day's date`,
      ).toHaveText(date);

      /* One panel at a time, and the marker it describes is on the day under
         the pointer. */
      await expect(tip).toHaveCount(1);
      await expect(chart.locator("circle.prio-burndown__dot")).toHaveCount(1);
    }

    /* Off the chart and it is gone — not hidden, not stale, not there. */
    await page.locator(".prio-burndown__summary").hover();
    await expect(tip).toHaveCount(0);

    /* Back on, and it answers again. */
    await hits.nth(1).hover();
    await expect(tip).toBeVisible();
    await expect(tip.locator(".prio-burndown__tipdate")).toHaveText(
      spoken[1]!.split(":")[0]!.trim(),
    );
  });

  test("keeps the day's table still when the pointer leaves the chart", async ({
    page,
  }) => {
    /*
     * The table is the half of the day's detail that can be used.
     *
     * A panel that follows the pointer cannot be clicked — reaching for it
     * moves the pointer off the day it belongs to — so the table holds the
     * last day that was read and keeps holding it after the pointer has gone.
     * Until a day has been read it shows the most recent one the sprint has
     * reached, which is what somebody opening the page wants.
     */
    const { key, sprintId, finished } = await seedRunningSprint();

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/projects/${key}/sprints/${sprintId}`);
    await openBurndown(page);
    const chart = page.locator(".prio-burndown");
    await chart.waitFor({ timeout: 45_000 });

    const table = chart.locator(".prio-burndown__table");
    const heading = table.locator(".prio-burndown__tabletitle");

    /* Nothing hovered yet: the latest day the sprint has reached. */
    const today = await chart
      .locator(".prio-visually-hidden li")
      .last()
      .textContent();
    const todayDate = today!.split(":")[0]!.trim();
    await expect(heading).toHaveText(`Issues on ${todayDate}`);

    /* Read the day the work was finished — the third day of this sprint. */
    const hits = chart.locator(".prio-burndown__hit");
    await hits.nth(2).hover();
    await expect(chart.locator(".prio-burndown__tip")).toBeVisible();
    const stepped = await chart
      .locator(".prio-burndown__tip .prio-burndown__tipdate")
      .textContent();
    await expect(heading).toHaveText(`Issues on ${stepped!.trim()}`);
    await expect(table.locator("tbody tr")).toContainText([finished.key]);

    /* Now leave the chart: the panel goes, and the table stays on that day so
       the row can be reached. */
    await page.locator(".prio-burndown__summary").hover();
    await expect(chart.locator(".prio-burndown__tip")).toHaveCount(0);
    await expect(heading).toHaveText(`Issues on ${stepped!.trim()}`);
    await expect(table.locator("tbody tr").first()).toBeVisible();
  });

  test("marks the days the scope moved, and says what moved", async ({
    page,
  }) => {
    /*
     * The question a burndown is worst at answering: why the line did not
     * fall.
     *
     * A sprint that took on ten more hours on its fourth day, and handed an
     * issue to testing on its sixth. Neither is visible in the line alone —
     * one pushes it up, the other moves it not at all — so the chart marks
     * the day the scope moved, the summary counts it, and the day's own panel
     * names the issue and the hours.
     */
    const { key, sprintId, added, toQa } = await seedSprintWithScopeChange();

    await page.setViewportSize({ width: 1550, height: 900 });
    await page.goto(`/projects/${key}/sprints/${sprintId}`);
    await openBurndown(page);
    const chart = page.locator(".prio-burndown");
    await chart.waitFor({ timeout: 45_000 });

    // ------------------------------------------------- the summary above it
    const figures = Object.fromEntries(
      await chart
        .locator(".prio-burndown__figure")
        .evaluateAll((nodes) =>
          nodes.map((node) => [
            node.querySelector("dt")!.textContent!.trim(),
            node.querySelector("dd")!.textContent!.trim(),
          ]),
        ),
    );
    /* Twenty hours on the first day and ten more later, said in issues and in
       hours — an issue arriving and a re-estimate are different news. */
    expect(figures["Initial Effort"]).toBe("20h");
    expect(figures["Scope Changes"]).toBe("+1 issue / +10h");
    /* And what it adds up to now, in the line under the chart. */
    await expect(chart.locator(".prio-burndown__legend")).toContainText(
      "of 30h left",
    );

    // ------------------------------------------------ the mark on the axis
    const marks = chart.locator("g.prio-burndown__scope");
    await expect(marks).toHaveCount(1);
    /* Up, because the work arrived. The arrow is a stroke rather than a
       filled shape, so it reads at whatever size the card gives the chart. */
    await expect(marks.first()).toHaveAttribute("data-direction", "up");
    await expect(marks.first().locator("path")).toHaveCount(1);
    /* Named in the legend, so a triangle on the axis is not decoration. */
    await expect(
      chart.locator('.prio-burndown__key[data-line="scope"]'),
    ).toContainText("Scope change");

    // ------------------------------------------- the day the work arrived
    const hits = chart.locator(".prio-burndown__hit");
    const days = await hits.count();
    const tip = chart.locator(".prio-burndown__tip");

    /**
     * The day whose panel has a row naming this issue and saying that.
     *
     * Matched row by row rather than over the panel's whole text: a row reads
     * "KEY Title" and then, on its second line, what happened to it — so the
     * key and the words are not adjacent in the text.
     */
    const dayNaming = async (key: string, said: string) => {
      for (let day = 0; day < days; day += 1) {
        await hits.nth(day).hover();
        await expect(tip).toBeVisible();
        const rows = await tip.locator("li").allTextContents();
        if (rows.some((row) => row.includes(key) && row.includes(said))) {
          return day;
        }
      }
      throw new Error(`no day's detail says "${said}" of ${key}`);
    };

    await dayNaming(added.key, "added to the sprint");
    /* The line went up, and the panel says which half of the day did it. */
    await expect(tip.locator(".prio-burndown__tipchange")).toContainText(
      "Added today: 10h",
    );
    await expect(tip.locator(".prio-burndown__tipchange")).toContainText(
      "Added: 1",
    );
    await expect(tip.locator(".prio-burndown__tipchanges")).toContainText(
      "+10h",
    );

    // --------------------------------------------- the day it went to testing
    await dayNaming(toQa.key, "moved to QA");
    /* Testing is open work, so nothing burned — and the day still has its
       answer rather than reading as a day nobody worked. */
    await expect(tip.locator(".prio-burndown__tipfigures")).toContainText(
      "Change since prev: 0h",
    );
    await expect(tip.locator(".prio-burndown__tipchange")).toContainText(
      "No effort completed today",
    );
    await expect(tip.locator(".prio-burndown__tipchange")).toContainText(
      "To QA: 1",
    );
  });

  test("is the size of its own contents, at every point and every width", async ({
    page,
  }) => {
    /*
     * The box's width is its content's, and nothing else's.
     *
     * It briefly was not: the placement tried the panel at a few narrower
     * widths so that one which would not fit beside a point could wrap into a
     * column that did, which made the width a function of where it fitted.
     * The same day's detail then read one width on one screen and another on
     * the next — and a build whose card is a little taller, as a deployed one
     * is, could fall through to the widest of them on the lower points. On
     * top of that the panel reading under the chart was `width: auto`, which
     * in the flow means the card's width: a tooltip stretched across the
     * whole chart.
     *
     * So what has to hold, whatever the point and whatever the width of the
     * window: the box is no wider than the reading measure, it is not a
     * stripe across the chart, and the room left over inside it is small —
     * which is what "sized to its contents" means once the text has wrapped.
     */
    const { key, sprintId } = await seedRunningSprint();

    /** The box, and how much of it the words inside it actually use. */
    const box = () =>
      page.evaluate(() => {
        const tip = document.querySelector(
          ".prio-burndown__tip",
        ) as HTMLElement;
        const chart = document.querySelector(".prio-burndown__svg")!;
        const style = getComputedStyle(tip);
        const t = tip.getBoundingClientRect();
        const inner =
          t.width -
          parseFloat(style.paddingLeft) -
          parseFloat(style.paddingRight) -
          parseFloat(style.borderLeftWidth) -
          parseFloat(style.borderRightWidth);
        const left =
          t.left +
          parseFloat(style.paddingLeft) +
          parseFloat(style.borderLeftWidth);

        /*
         * The rightmost ink in the box: each row's own line boxes and each
         * element within it, because a row is a flex line whose ink ends at
         * its last item rather than at its widest one.
         */
        const range = document.createRange();
        let ink = 0;
        for (const row of Array.from(tip.querySelectorAll("p, li"))) {
          range.selectNodeContents(row);
          for (const rect of Array.from(range.getClientRects())) {
            ink = Math.max(ink, rect.right - left);
          }
          for (const child of Array.from(row.querySelectorAll("*"))) {
            ink = Math.max(ink, child.getBoundingClientRect().right - left);
          }
        }

        /*
         * And the width it would have in the other mode.
         *
         * The panel is either placed beside the point or read in the flow
         * under the chart, and which one it gets depends on the room around
         * the point — so a fixture that only ever floats would never see the
         * flow's own width. That is where the reported fault lived: in the
         * flow the box was `width: auto`, which means the card's width, so
         * the same detail became a stripe across the chart as soon as the
         * placement fell through to it. Both are measured here, and the claim
         * is that they are the same box.
         */
        const floating = !tip.classList.contains("is-inflow");
        tip.classList.toggle("is-inflow");
        const other = Math.round(tip.getBoundingClientRect().width);
        tip.classList.toggle("is-inflow");

        return {
          width: Math.round(t.width),
          /* Empty room at the right-hand edge. */
          slack: Math.round(inner - ink),
          shareOfChart: t.width / chart.getBoundingClientRect().width,
          /* Nothing may size the panel from JavaScript: the stylesheet is the
             only thing that decides how wide it is. */
          inlineWidth: `${tip.style.width}|${tip.style.maxWidth}`,
          mode: floating ? "float" : "flow",
          otherModeWidth: other,
        };
      });

    for (const [width, height] of [
      [1550, 900],
      [1280, 800],
      [1024, 768],
      [900, 700],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.goto(`/projects/${key}/sprints/${sprintId}`);
      await openBurndown(page);
      const chart = page.locator(".prio-burndown");
      await chart.waitFor({ timeout: 45_000 });

      const hits = chart.locator(".prio-burndown__hit");
      const days = await hits.count();
      const widths: number[] = [];

      for (let day = 0; day < days; day += 1) {
        await hits.nth(day).hover();
        await expect(chart.locator(".prio-burndown__tip")).toBeVisible();

        const where = `${width}px, day ${day}`;
        const seen = await box();
        /* The reading measure the stylesheet sets, and never more. */
        expect(
          seen.width,
          `${where}: wider than the measure`,
        ).toBeLessThanOrEqual(420);
        /* Not a stripe across the chart. */
        expect(
          seen.shareOfChart,
          `${where}: stretched across the chart`,
        ).toBeLessThan(0.75);
        /* Sized to the words in it: what is left over is a ragged edge, not a
           field of empty box. */
        expect(
          seen.slack,
          `${where}: box far wider than its text`,
        ).toBeLessThan(90);
        expect(seen.inlineWidth, `${where}: sized from script`).toBe("|");
        /* The same box whichever way it is drawn — floating beside the point
           or reading in the flow under the chart. */
        expect(
          Math.abs(seen.otherModeWidth - seen.width),
          `${where}: ${seen.mode === "float" ? "the flow" : "the floating"} width differs`,
        ).toBeLessThan(6);
        expect(
          seen.otherModeWidth,
          `${where}: wider than the measure in the other mode`,
        ).toBeLessThanOrEqual(420);
        widths.push(seen.width);
      }

      /* And one width for the sprint, near enough: these days differ by a row
         or two of text, not by where they sit on the chart. */
      expect(
        Math.max(...widths) - Math.min(...widths),
        `${width}px: the width moves with the point`,
      ).toBeLessThan(40);
    }
  });

  test("follows the pointer from point to point, and goes away after it", async ({
    page,
  }) => {
    /*
     * What hovering has to do: answer for the day under the pointer, keep
     * answering for the right one as the pointer moves along the line, and
     * stop when the pointer leaves. A panel left behind — or left showing the
     * day before — is worse than no panel, because it reads as a fact about
     * the day being pointed at.
     */
    const { key, sprintId } = await seedRunningSprint();

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/projects/${key}/sprints/${sprintId}`);
    await openBurndown(page);
    const chart = page.locator(".prio-burndown");
    await chart.waitFor({ timeout: 45_000 });

    const hits = chart.locator(".prio-burndown__hit");
    const tip = chart.locator(".prio-burndown__tip");
    const days = await hits.count();

    /* The dates the chart itself says each day is, read from the text it
       writes for a screen reader — so the expectation is the page's own and
       not a format typed in here. */
    const spoken = await chart
      .locator(".prio-visually-hidden li")
      .allTextContents();
    expect(spoken.length).toBe(days);

    for (let day = 0; day < days; day += 1) {
      await hits.nth(day).hover();
      await expect(tip).toBeVisible();

      /* The date in the panel is this day's, so nothing stale survives the
         move from the day before. */
      const date = spoken[day]!.split(":")[0]!.trim();
      await expect(
        tip.locator(".prio-burndown__tipdate"),
        `day ${day} shows another day's date`,
      ).toHaveText(date);

      /* One panel at a time, and the marker it describes is on the day under
         the pointer. */
      await expect(tip).toHaveCount(1);
      await expect(chart.locator("circle.prio-burndown__dot")).toHaveCount(1);
    }

    /* Off the chart and it is gone — not hidden, not stale, not there. */
    await page.locator(".prio-burndown__summary").hover();
    await expect(tip).toHaveCount(0);

    /* Back on, and it answers again. */
    await hits.nth(1).hover();
    await expect(tip).toBeVisible();
    await expect(tip.locator(".prio-burndown__tipdate")).toHaveText(
      spoken[1]!.split(":")[0]!.trim(),
    );
  });

  test("keeps the empty-state message when nothing is estimated", async ({
    page,
  }) => {
    /* The same sprint with its estimates cleared: no chart, and the message
       that says what to do about it. */
    const { key, sprintId } = await seedRunningSprint();
    const project = await prisma.project.findFirstOrThrow({
      where: { key: key.toUpperCase() },
      select: { id: true },
    });
    await prisma.issue.updateMany({
      where: { projectId: project.id },
      data: { effortHours: null, remainingHours: null },
    });

    await page.goto(`/projects/${key}/sprints/${sprintId}`);
    await openBurndown(page);
    await expect(
      page.getByRole("heading", { name: "Burndown Chart" }),
    ).toBeVisible({ timeout: 45_000 });
    await expect(
      page.getByText(/Nothing in this sprint has been estimated yet/),
    ).toBeVisible();
    /* No chart, and none of the new figures either — there is nothing to
       count. */
    await expect(page.locator(".prio-burndown__svg")).toHaveCount(0);
    await expect(page.locator(".prio-burndown__summary")).toHaveCount(0);
  });
});
