import { expect, test } from "@playwright/test";
import { prisma } from "@/lib/prisma";

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

  return { key: project.key.toLowerCase(), sprintId: sprint.id, finished, open };
}

test.describe("The burndown's detail", () => {
  test("shows what the sprint is made of, and what each day is made of", async ({
    page,
  }) => {
    const { key, sprintId, finished, open } = await seedRunningSprint();

    await page.goto(`/projects/${key}/sprints/${sprintId}`);
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
    expect(figures).toEqual([
      ["Total Effort", "30h"],
      ["Completed Effort", "10h"],
      ["Remaining Effort", "20h"],
      ["Total Issues", "2"],
      ["Completed Issues", "1"],
      ["Remaining Issues", "1"],
    ]);

    // ---------------------------------------------- a marker for right now
    /* The sprint is the one being worked, so today is marked — with what is
       left, how many issues that is, and how much of the effort is burned. */
    await expect(chart.locator("line.prio-burndown__today")).toHaveCount(1);
    const today = chart.locator(".prio-burndown__todaytag");
    await expect(today).toContainText("Today");
    await expect(today).toContainText("20h left");
    await expect(today).toContainText("1 issue");
    await expect(today).toContainText("33% burned");

    // --------------------------------------------- the day the line stepped
    /* The sprint started seven days ago and the work was finished five days
       ago, so that is the third day on the chart. */
    const hits = chart.locator(".prio-burndown__hit");
    await hits.nth(2).hover();

    const tip = chart.locator(".prio-burndown__tip");
    await expect(tip).toBeVisible();
    await expect(tip).toContainText("Remaining: 20h");
    await expect(tip).toContainText("Completed: 10h");
    await expect(tip).toContainText("Total: 30h");
    await expect(tip).toContainText("Remaining issues: 1");
    await expect(tip).toContainText("Completed issues: 1");

    /* Why it stepped, and by how much. */
    const change = tip.locator(".prio-burndown__tipchanges li");
    await expect(change).toHaveCount(1);
    await expect(change).toContainText(finished.key);
    await expect(change).toContainText("finished");
    await expect(change).toContainText("−10h");

    /* And what is left, named: key, title, status and effort. */
    const rows = tip.locator(".prio-burndown__tipissues li");
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText(open.key);
    await expect(rows).toContainText("Twenty hours, still going");
    await expect(rows).toContainText("In Progress");
    await expect(rows).toContainText("20h");

    // ---------------------------------------- the first day, before the step
    await hits.nth(0).hover();
    await expect(tip).toContainText("Remaining: 30h");
    await expect(tip).toContainText("Remaining issues: 2");
    /* Nothing had happened yet, so there is nothing to explain. */
    await expect(tip.locator(".prio-burndown__tipchanges")).toHaveCount(0);

    /* Moving off the chart puts the detail away. */
    await page.locator(".prio-burndown__summary").hover();
    await expect(tip).toHaveCount(0);
  });

  test("reads inside the chart, clear of the point and the remaining line", async ({
    page,
  }) => {
    /*
     * The panel used to float at a fixed height inside the plot, which put it
     * over the marker whenever the remainder was high — hiding the one thing
     * the reader was pointing at — and over the line around it.
     *
     * What has to hold now, on every day of the sprint and at both ends of
     * it: the panel is inside the chart's own card and whole, the marker it
     * describes is not underneath it and has a gap around it, and none of the
     * *Remaining* line is underneath it either. (The dashed *Ideal* line is a
     * reference rather than a measurement; the placement prefers to miss it
     * but will lie over it rather than desert the point.) Checked in both
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
              x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
            if (inside(segment.ax, segment.ay) || inside(segment.bx, segment.by)) {
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
          coversMarker: inflow ? false : hits(m, t),
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
        };
      });

    for (const theme of ["light", "dark"] as const) {
      for (const [width, height] of [
        [1440, 900],
        [1024, 768],
      ] as const) {
        await page.setViewportSize({ width, height });
        await page.goto(`/projects/${key}/sprints/${sprintId}`);
        /* The theme is an attribute on <html>, set from storage on load —
           so it is set here after the load, the way the app's own switcher
           sets it. */
        await page.evaluate(
          (value) => document.documentElement.setAttribute("data-theme", value),
          theme,
        );
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        const chart = page.locator(".prio-burndown");
        await chart.waitFor({ timeout: 45_000 });

        const hits = chart.locator(".prio-burndown__hit");
        const days = await hits.count();
        expect(days).toBeGreaterThan(2);

        /* Every day, which is every position across the plot — the first and
           last days are its left and right boundaries, and this sprint's
           line runs from the top of the scale to the bottom of it, so its
           points sit against the top and bottom boundaries too. */
        const gaps: number[] = [];
        for (let day = 0; day < days; day += 1) {
          await hits.nth(day).hover();
          await expect(chart.locator(".prio-burndown__tip")).toBeVisible();

          const where = `${theme}, ${width}px, day ${day}`;
          const seen = await geometry();
          expect(seen.escapes, `${where}: outside the card`).toBeLessThan(1);
          expect(seen.coversMarker, `${where}: covers the marker`).toBe(false);
          expect(
            seen.onRemainingLine,
            `${where}: covers the remaining line`,
          ).toBe(false);
          expect(seen.pointerEvents).toBe("none");
          if (!seen.inflow) {
            /*
             * Close to the point, on the side it opened.
             *
             * The lower bound is the spacing itself: the marker and its
             * crosshair have to be visible, not merely uncovered. The upper
             * one is the bug this replaced — the panel used to be sent to the
             * far edge of the card, two to six hundred pixels from the day it
             * was describing, whenever the line blocked the obvious
             * positions. It searches finely now, and narrows itself rather
             * than desert the point, so a day of this sprint is never more
             * than a panel's width away from its own detail.
             */
            expect(
              seen.gap,
              `${where}: no gap from the point`,
            ).toBeGreaterThanOrEqual(6);
            expect(seen.gap, `${where}: stranded from the point`).toBeLessThan(
              100,
            );
            gaps.push(seen.gap!);
          }
        }

        /* And most days hug it: the spacing is small and the same wherever
           the line leaves room for it. */
        expect(
          gaps.filter((gap) => gap <= 14).length,
          `${theme}, ${width}px: too few days sit at the spacing`,
        ).toBeGreaterThanOrEqual(Math.ceil(days / 2));
      }
    }
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
