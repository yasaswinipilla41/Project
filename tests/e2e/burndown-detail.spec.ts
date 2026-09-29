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

/**
 * A running sprint whose scope moved.
 *
 * Twenty hours on its first day; ten more arrive on the fourth, recorded the
 * way `updateIssue` records a move between sprints — an activity entry naming
 * the sprint the issue joined — and an issue is handed to testing on the
 * sixth. Both are read back through the real query, so what the chart draws
 * is what the trail says.
 */
async function seedSprintWithScopeChange() {
  const admin = await prisma.user.findFirstOrThrow({
    where: { role: "ADMIN" },
    select: { id: true, name: true },
  });
  const key = `SC${Date.now().toString(36).toUpperCase()}`.slice(0, 10);
  const project = await prisma.project.create({
    data: {
      key,
      name: `Burndown scope fixture ${key}`,
      createdById: admin.id,
      members: { create: { userId: admin.id } },
      issueSequence: 3,
    },
    select: { id: true, key: true },
  });
  createdProjects.push(project.id);

  const start = ago(7);
  const sprint = await prisma.sprint.create({
    data: {
      name: `E2E burndown scope ${Date.now()}`,
      startDate: start,
      endDate: new Date(Date.now() + 6 * DAY),
      projectId: project.id,
      createdById: admin.id,
      status: "ACTIVE",
      startedAt: start,
    },
    select: { id: true, name: true },
  });

  const issue = async (
    number: number,
    title: string,
    effortHours: number,
    status: "TODO" | "IN_QA",
  ) =>
    prisma.issue.create({
      data: {
        projectId: project.id,
        key: `${project.key}-${number}`,
        number,
        title,
        type: "TASK",
        status,
        reporterId: admin.id,
        assigneeId: admin.id,
        sprintId: sprint.id,
        effortHours,
        remainingHours: effortHours,
      },
      select: { id: true, key: true },
    });

  /* Committed from the first day. */
  await issue(1, "Twenty hours, planned", 20, "TODO");

  /* Arrived on the fourth day: the sprint's name on the right of the move is
     what makes it a joining, exactly as `loadBurndown` reads it. */
  const added = await issue(2, "Ten hours, added later", 10, "TODO");
  await prisma.activityLogEntry.create({
    data: {
      issueId: added.id,
      actorId: admin.id,
      action: "issue.updated",
      field: "sprintId",
      oldValue: null,
      newValue: sprint.name,
      createdAt: ago(4),
    },
  });

  /* And handed to testing on the sixth, which burns nothing at all. */
  const toQa = await issue(3, "Handed to testing", 0, "IN_QA");
  await prisma.activityLogEntry.create({
    data: {
      issueId: toQa.id,
      actorId: admin.id,
      action: "issue.updated",
      field: "status",
      oldValue: "IN_REVIEW",
      newValue: "IN_QA",
      createdAt: ago(2),
    },
  });

  return {
    key: project.key.toLowerCase(),
    sprintId: sprint.id,
    added,
    toQa,
  };
}

/**
 * A running sprint whose scope moved both ways.
 *
 * One issue re-estimated upward on the third day (+6h, an up arrow) and
 * another re-estimated downward on the fifth (−6h, a down arrow), so the chart
 * draws one arrow of each direction from the sprint's own trail.
 */
async function seedScopeBothWays() {
  const admin = await prisma.user.findFirstOrThrow({
    where: { role: "ADMIN" },
    select: { id: true },
  });
  const key = `SB${Date.now().toString(36).toUpperCase()}`.slice(0, 10);
  const project = await prisma.project.create({
    data: {
      key,
      name: `Burndown scope-both-ways fixture ${key}`,
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
      name: `E2E burndown both ways ${Date.now()}`,
      startDate: start,
      endDate: new Date(Date.now() + 6 * DAY),
      projectId: project.id,
      createdById: admin.id,
      status: "ACTIVE",
      startedAt: start,
    },
    select: { id: true },
  });

  const reestimated = async (
    number: number,
    from: number,
    to: number,
    daysAgo: number,
  ) => {
    const issue = await prisma.issue.create({
      data: {
        projectId: project.id,
        key: `${project.key}-${number}`,
        number,
        title: `Re-estimated ${from}h → ${to}h`,
        type: "TASK",
        status: "IN_PROGRESS",
        reporterId: admin.id,
        assigneeId: admin.id,
        sprintId: sprint.id,
        effortHours: to,
        remainingHours: to,
      },
      select: { id: true },
    });
    await prisma.activityLogEntry.create({
      data: {
        issueId: issue.id,
        actorId: admin.id,
        action: "issue.updated",
        field: "effortHours",
        oldValue: String(from),
        newValue: String(to),
        createdAt: ago(daysAgo),
      },
    });
  };

  await reestimated(1, 4, 10, 5);
  await reestimated(2, 9, 3, 3);

  return { key: project.key.toLowerCase(), sprintId: sprint.id };
}

/**
 * A running sprint with one very busy day.
 *
 * Five issues re-estimated and their remainders rewritten on the same day —
 * ten changes for one point on the line, which is more than a panel can list
 * beside a point on any screen. Long titles, because a row that wraps onto two
 * lines is what makes such a panel taller than the room it has.
 */
async function seedBusyDay() {
  const admin = await prisma.user.findFirstOrThrow({
    where: { role: "ADMIN" },
    select: { id: true },
  });
  const key = `BZ${Date.now().toString(36).toUpperCase()}`.slice(0, 10);
  const project = await prisma.project.create({
    data: {
      key,
      name: `Burndown busy fixture ${key}`,
      createdById: admin.id,
      members: { create: { userId: admin.id } },
      issueSequence: 5,
    },
    select: { id: true, key: true },
  });
  createdProjects.push(project.id);

  const start = ago(7);
  const sprint = await prisma.sprint.create({
    data: {
      name: `E2E burndown busy ${Date.now()}`,
      startDate: start,
      endDate: new Date(Date.now() + 6 * DAY),
      projectId: project.id,
      createdById: admin.id,
      status: "ACTIVE",
      startedAt: start,
    },
    select: { id: true },
  });

  const titles = [
    "Session expiry signs the user out of every open tab at once",
    "Board columns lose their order after a drag that fails to save",
    "Sprint report counts an issue twice when it moves mid-sprint",
    "Notification digest sends yesterday's items again each morning",
    "Search ignores the project filter for keys typed in lower case",
  ];

  for (const [index, title] of titles.entries()) {
    const issue = await prisma.issue.create({
      data: {
        projectId: project.id,
        key: `${project.key}-${index + 1}`,
        number: index + 1,
        title,
        type: "TASK",
        status: "IN_PROGRESS",
        reporterId: admin.id,
        assigneeId: admin.id,
        sprintId: sprint.id,
        effortHours: 4,
        remainingHours: 4,
      },
      select: { id: true },
    });
    /* Both halves of a re-estimate, on the third day: the estimate, then the
       remainder that follows it. Two rows per issue, ten in all. */
    for (const field of ["effortHours", "remainingHours"] as const) {
      await prisma.activityLogEntry.create({
        data: {
          issueId: issue.id,
          actorId: admin.id,
          action: "issue.updated",
          field,
          oldValue: "2",
          newValue: "4",
          createdAt: ago(3),
        },
      });
    }
  }

  return { key: project.key.toLowerCase(), sprintId: sprint.id };
}

/**
 * A sprint already burned to nothing, days ago.
 *
 * Eight hours, finished on the third day, so every day since sits on the floor
 * of the plot — the row of points along the very bottom that a real sprint's
 * quiet week is full of. That is the shape the placement is most tempted to
 * answer badly for: the panel reading in the flow *under* the chart is only a
 * few pixels from a point that low, so it used to measure as the closest
 * position going and win, whenever the page happened to be scrolled far enough
 * for it to be on screen.
 */
async function seedBurnedToZero() {
  const admin = await prisma.user.findFirstOrThrow({
    where: { role: "ADMIN" },
    select: { id: true },
  });
  const key = `BF${Date.now().toString(36).toUpperCase()}`.slice(0, 10);
  const project = await prisma.project.create({
    data: {
      key,
      name: `Burndown floor fixture ${key}`,
      createdById: admin.id,
      members: { create: { userId: admin.id } },
      issueSequence: 1,
    },
    select: { id: true, key: true },
  });
  createdProjects.push(project.id);

  const start = ago(7);
  const sprint = await prisma.sprint.create({
    data: {
      name: `E2E burndown floor ${Date.now()}`,
      startDate: start,
      endDate: new Date(Date.now() + 6 * DAY),
      projectId: project.id,
      createdById: admin.id,
      status: "ACTIVE",
      startedAt: start,
    },
    select: { id: true },
  });

  const done = await prisma.issue.create({
    data: {
      projectId: project.id,
      key: `${project.key}-1`,
      number: 1,
      title: "Eight hours, finished on the third day",
      type: "TASK",
      status: "DONE",
      reporterId: admin.id,
      assigneeId: admin.id,
      sprintId: sprint.id,
      effortHours: 8,
      remainingHours: 8,
    },
    select: { id: true },
  });
  await prisma.activityLogEntry.create({
    data: {
      issueId: done.id,
      actorId: admin.id,
      action: "issue.updated",
      field: "status",
      oldValue: "IN_PROGRESS",
      newValue: "DONE",
      createdAt: ago(5),
    },
  });

  /*
   * And then twenty hours arrive two days ago, which lifts the line off the
   * floor behind those days.
   *
   * That rise is the other half of the shape. A panel above or beside a point
   * on the floor lies across the climb, which counts against it — and while
   * covering the line counted for more than being beside the point, that was
   * enough to send the panel under the chart.
   */
  const late = await prisma.issue.create({
    data: {
      projectId: project.id,
      key: `${project.key}-2`,
      number: 2,
      title: "Twenty hours, added two days ago",
      type: "TASK",
      status: "IN_PROGRESS",
      reporterId: admin.id,
      assigneeId: admin.id,
      sprintId: sprint.id,
      effortHours: 20,
      remainingHours: 20,
    },
    select: { id: true },
  });
  await prisma.activityLogEntry.create({
    data: {
      issueId: late.id,
      actorId: admin.id,
      action: "issue.updated",
      field: "effortHours",
      oldValue: null,
      newValue: "20",
      createdAt: ago(2),
    },
  });

  return { key: project.key.toLowerCase(), sprintId: sprint.id };
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

    /* The per-issue "Issues changed" list is gone from the card: the day's
       burn opens its own details, and the table below lists the day. */
    await expect(tip).not.toContainText("Issues changed");

    /* What the day itself did, which the cumulative figures above do not
       say: ten hours burned, and the count behind them. */
    await expect(
      tip.locator(".prio-burndown__tipfigures"),
      "the day's own step, among the effort figures",
    ).toContainText("Change since prev: −10h");
    const movement = tip.locator(".prio-burndown__tipchange");
    await expect(movement).toContainText("Burn today: 10h");
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
      "Remaining",
      "Burned",
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
    await expect(tip.locator(".prio-burndown__burnlink")).toHaveCount(0);
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

  test("clicking a point pins its day, and Burn today opens what was burned", async ({
    page,
  }) => {
    /*
     * Every day's point is a control: clicking it — or Enter on it — pins the
     * day, so its card stays open and takes clicks. That is what makes "Burn
     * today" usable at all, since a hover card lets the pointer through and
     * ends the moment the pointer leaves the point. "Burn today" then opens
     * the day's burned issues, which add up to the figure it quoted.
     */
    const { key, sprintId, finished } = await seedRunningSprint();
    await page.goto(`/projects/${key}/sprints/${sprintId}`);
    await openBurndown(page);
    const chart = page.locator(".prio-burndown");
    await chart.waitFor({ timeout: 45_000 });
    const hits = chart.locator(".prio-burndown__hit");
    const tip = chart.locator(".prio-burndown__tip");
    const table = chart.locator(".prio-burndown__table");

    /* Every reached day's point is a button, named for its day and value. */
    const days = await hits.count();
    for (let day = 0; day < days; day += 1) {
      await expect(hits.nth(day)).toHaveAttribute("role", "button");
      await expect(hits.nth(day)).toHaveAttribute(
        "aria-label",
        /^\d{2} \w{3} \d{4}: \d+(\.\d+)?h remaining\. Open the day's details$/,
      );
    }

    /* Hovered, the card is a preview: it lets the pointer through and says
       how to make it stay. */
    await hits.nth(2).hover();
    await expect(tip).toContainText("Burn today: 10h");
    await expect(tip).toContainText("Click the point to pin this card");
    expect(await tip.evaluate((node) => getComputedStyle(node).pointerEvents)).toBe(
      "none",
    );

    /* Clicked, it is pinned: it stays when the pointer leaves, takes clicks,
       and hovering another day moves neither it nor the table. */
    await hits.nth(2).click();
    await expect(tip).toHaveAttribute("data-pinned", "true");
    await expect(hits.nth(2)).toHaveAttribute("aria-pressed", "true");
    expect(await tip.evaluate((node) => getComputedStyle(node).pointerEvents)).toBe(
      "auto",
    );
    const pinnedDate = await tip.locator(".prio-burndown__tipdate").innerText();
    await hits.nth(5).hover();
    await expect(tip.locator(".prio-burndown__tipdate")).toHaveText(pinnedDate);
    await expect(table).toContainText(
      `Issues on ${pinnedDate.split("\n")[0]!.trim()}`,
      { ignoreCase: true },
    );

    /* Burn today opens the day's burned issues, in the product's dialog. */
    await tip.getByRole("button", { name: /Burn today/ }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Burned on");
    const rows = dialog.locator("tbody tr");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(finished.key);
    await expect(rows.first()).toContainText("Finished");
    await expect(rows.first()).toContainText("10h");
    await expect(dialog.locator("tfoot")).toContainText("10h");
    /* The key opens the issue, as it does everywhere else. */
    await expect(rows.first().locator("a.prio-key")).toHaveAttribute(
      "href",
      `/issues/${finished.key.toLowerCase()}`,
    );

    /* Escape closes the dialog and leaves the day pinned; a second Escape
       lets the day go. */
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(tip).toHaveAttribute("data-pinned", "true");
    await page.keyboard.press("Escape");
    await expect(tip).toHaveCount(0);

    /* Clicking the same point again unpins it; so does a click outside the
       chart. */
    await hits.nth(2).click();
    await expect(tip).toHaveAttribute("data-pinned", "true");
    await hits.nth(2).click();
    await expect(tip).not.toHaveAttribute("data-pinned", "true");
    await hits.nth(2).click();
    await page.mouse.click(5, 5);
    await expect(tip).toHaveCount(0);

    /* From the keyboard: Enter on a point pins it, like a click. */
    await hits.nth(2).focus();
    await page.keyboard.press("Enter");
    await expect(tip).toHaveAttribute("data-pinned", "true");

    /* A day with nothing burned offers no link to open. */
    await page.keyboard.press("Escape");
    await hits.nth(4).click();
    await expect(tip).toContainText("No effort completed today");
    await expect(tip.locator(".prio-burndown__burnlink")).toHaveCount(0);
  });

  test("the day's table says what each issue has left and has burned, and opens the burns", async ({
    page,
  }) => {
    /*
     * Remaining and Burned, beside Effort. Burned is everything an issue burned
     * from the sprint's first day up to the day being read — the sum of the
     * same per-day burns "Burn today" is made of — and clicking it opens those
     * burns in a bordered modal whose rows add up to the figure.
     */
    const { key, sprintId, finished, open } = await seedRunningSprint();
    await page.goto(`/projects/${key}/sprints/${sprintId}`);
    await openBurndown(page);
    const chart = page.locator(".prio-burndown");
    await chart.waitFor({ timeout: 45_000 });
    const table = chart.locator(".prio-burndown__table");

    /* Before the finish (day 1): nothing burned yet. */
    await chart.locator(".prio-burndown__hit").nth(1).click();
    const early = table.locator("tbody tr").filter({ hasText: finished.key });
    await expect(early.locator("td").nth(6)).toHaveText("10h");
    await expect(early.locator("td").nth(7)).toHaveText("0h");
    await expect(early.locator(".prio-burndown__burnlink")).toHaveCount(0);
    await page.keyboard.press("Escape");

    /* On the last day the open issue has 20h left and has burned nothing;
       Effort is as it was. (The table lists the day's changed and open
       issues, so the one finished days ago is not in it.) */
    const days = await chart.locator(".prio-burndown__hit").count();
    await chart.locator(".prio-burndown__hit").nth(days - 1).click();
    const going = table.locator("tbody tr").filter({ hasText: open.key });
    await expect(going.locator("td").nth(5)).toHaveText("20h");
    await expect(going.locator("td").nth(6)).toHaveText("20h");
    await expect(going.locator("td").nth(7)).toHaveText("0h");
    await page.keyboard.press("Escape");

    /* On the day it was finished (the third): nothing left, 10h burned. */
    await chart.locator(".prio-burndown__hit").nth(2).click();
    const done = table.locator("tbody tr").filter({ hasText: finished.key });
    await expect(done.locator("td").nth(6)).toHaveText("0h");
    const burned = done.locator(".prio-burndown__burnlink");
    await expect(burned).toHaveText("10h");

    /* Clicked, it opens the burns behind it. */
    await burned.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(`${finished.key} · burned to`);
    expect(
      await dialog
        .locator("thead th")
        .evaluateAll((nodes) => nodes.map((node) => node.textContent!.trim())),
    ).toEqual([
      "Date",
      "Issue key",
      "Issue name",
      "What happened",
      "Assignee",
      "Burned",
    ]);
    const rows = dialog.locator("tbody tr");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(finished.key);
    await expect(rows.first()).toContainText("Ten hours, finished");
    await expect(rows.first()).toContainText("10h");
    await expect(dialog.locator("tfoot")).toContainText("10h");

    /* A contained block: a border of its own, and the pinned day card sits
       behind it rather than over its backdrop. */
    expect(
      await dialog.evaluate((node) => getComputedStyle(node).borderTopWidth),
    ).toBe("1px");
    await expect(chart.locator(".prio-burndown__tip")).toHaveAttribute(
      "data-behind",
      "true",
    );

    /* Its close icon closes it, and the card comes back in front. */
    await dialog.getByRole("button", { name: /close/i }).click();
    await expect(dialog).toHaveCount(0);
    await expect(chart.locator(".prio-burndown__tip")).not.toHaveAttribute(
      "data-behind",
      "true",
    );
  });

  test("lines Effort, Remaining and Burned up under their headings", async ({
    page,
  }) => {
    /*
     * The figures were right-aligned and their headings were not, so every
     * heading sat to the left of the column it named; and on a phone the
     * three columns fell to three different widths. Measured from the text
     * itself: each heading ends where its figures end, on every row, and the
     * three columns are one width — at a desktop size and a phone size, in
     * both themes.
     */
    const { key, sprintId } = await seedRunningSprint();

    for (const [width, height] of [
      [1440, 900],
      [390, 844],
    ] as const) {
      for (const theme of ["light", "dark"] as const) {
        await page.setViewportSize({ width, height });
        await page.goto(`/projects/${key}/sprints/${sprintId}`);
        await page.evaluate(
          (value) => document.documentElement.setAttribute("data-theme", value),
          theme,
        );
        await openBurndown(page);
        const table = page.locator(".prio-burndown__issuetable");
        await table.waitFor({ timeout: 45_000 });

        const columns = await table.evaluate((node) => {
          const heads = Array.from(node.querySelectorAll("thead th"));
          const rows = Array.from(node.querySelectorAll("tbody tr"));
          /* Where a cell's own text ends, not where the cell does. */
          const textRight = (cell: Element) => {
            const range = document.createRange();
            range.selectNodeContents(cell);
            return Math.max(
              ...Array.from(range.getClientRects())
                .filter((rect) => rect.width > 0)
                .map((rect) => rect.right),
            );
          };
          return ["Effort", "Remaining", "Burned"].map((name) => {
            const index = heads.findIndex(
              (head) => head.textContent!.trim() === name,
            );
            return {
              name,
              width: Math.round(heads[index]!.getBoundingClientRect().width),
              head: Math.round(textRight(heads[index]!)),
              cells: rows.map((row) => Math.round(textRight(row.children[index]!))),
            };
          });
        });

        const where = `${width}px, ${theme}`;
        for (const column of columns) {
          expect(column.cells.length, where).toBeGreaterThan(0);
          for (const cell of column.cells) {
            expect(
              Math.abs(cell - column.head),
              `${where}: ${column.name} value not under its heading`,
            ).toBeLessThanOrEqual(1);
          }
        }
        expect(
          new Set(columns.map((column) => column.width)).size,
          `${where}: the three columns are different widths (${columns.map((column) => column.width).join(", ")})`,
        ).toBe(1);
      }
    }
  });

  test("a busy day's card stays beside its point, without a list to grow", async ({
    page,
  }) => {
    /*
     * Ten changes on one day.
     *
     * The card used to list them issue by issue, which made a busy day's card
     * taller than the room beside its point — so it had to trim the list, or
     * read under the chart where the reader could not reach it. The card no
     * longer carries that list: the day's figures stay, "Burn today" opens its
     * own details, and the table under the chart lists every issue. So a busy
     * day's card is the same size as a quiet one's, and sits beside its point
     * like any other, at every window size.
     */
    const { key, sprintId } = await seedBusyDay();

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

      /* The busy day is the one whose table names the most changed issues —
         found rather than counted out, so the fixture's dates are free to
         move. */
      let busiest = { day: 0, marked: -1 };
      for (let day = 0; day < days; day += 1) {
        await hits.nth(day).hover();
        await expect(chart.locator(".prio-burndown__tip")).toBeVisible();
        const marked = await chart
          .locator(".prio-burndown__table .prio-burndown__rowmark")
          .count();
        if (marked > busiest.marked) busiest = { day, marked };
      }
      expect(busiest.marked, `${width}px: no busy day`).toBeGreaterThan(1);

      await hits.nth(busiest.day).hover();
      const tip = chart.locator(".prio-burndown__tip");
      await expect(tip).toBeVisible();
      await expect(tip).not.toContainText("Issues changed");

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
    }
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
     * The day whose table has a row naming this issue and saying that.
     *
     * Read from the table under the chart, which follows the day being
     * hovered and names each issue's reason for being in it. Matched row by
     * row: the key and the words are in different cells.
     */
    const table = chart.locator(".prio-burndown__table");
    const dayNaming = async (key: string, said: string) => {
      for (let day = 0; day < days; day += 1) {
        await hits.nth(day).hover();
        await expect(tip).toBeVisible();
        const rows = await table.locator("tbody tr").allTextContents();
        if (rows.some((row) => row.includes(key) && row.includes(said))) {
          return day;
        }
      }
      throw new Error(`no day's detail says "${said}" of ${key}`);
    };

    await dayNaming(added.key, "added to the sprint");
    /* The line went up by work arriving: nothing was burned, and the card
       says the ten hours were scope rather than calling them anything
       else. */
    await expect(tip.locator(".prio-burndown__tipfigures")).toContainText(
      "Change since prev: +10h",
    );
    await expect(tip.locator(".prio-burndown__tipchange")).toContainText(
      "No effort completed today (+10h scope)",
    );
    await expect(tip.locator(".prio-burndown__tipchange")).toContainText(
      "Added: 1",
    );
    await expect(
      table.locator("tbody tr").filter({ hasText: added.key }),
    ).toContainText("+10h");

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

  test("colours each arrow by the way it points: up red, down green", async ({
    page,
  }) => {
    /*
     * An up arrow is work the day added and did not solve; a down arrow is
     * work the day cleared. The colour is read off the arrow's own direction,
     * which the chart sets from the day's data — so both are checked against
     * what the day actually did (its `scope ±` title), not against a fixed
     * position, and in both themes, where each colour has its own step.
     */
    const { key, sprintId } = await seedScopeBothWays();
    await page.goto(`/projects/${key}/sprints/${sprintId}`);
    await openBurndown(page);
    const chart = page.locator(".prio-burndown");
    await chart.waitFor({ timeout: 45_000 });

    for (const theme of ["light", "dark"] as const) {
      await page.evaluate(
        (value) => document.documentElement.setAttribute("data-theme", value),
        theme,
      );

      const arrows = await chart
        .locator(".prio-burndown__scope")
        .evaluateAll((groups) => {
          /* What a theme token resolves to, as the browser paints it. */
          const resolve = (token: string) => {
            const probe = document.createElement("span");
            probe.style.color = `var(${token})`;
            document.body.append(probe);
            const colour = getComputedStyle(probe).color;
            probe.remove();
            return colour;
          };
          const red = resolve("--prio-red-600");
          const green = resolve("--prio-status-done-dot");
          return groups.map((group) => ({
            direction: group.getAttribute("data-direction"),
            said: group.querySelector("title")?.textContent ?? "",
            stroke: getComputedStyle(group.querySelector("path")!).stroke,
            red,
            green,
          }));
        });

      expect(
        arrows.map((arrow) => arrow.direction).sort(),
        `${theme}: expected one arrow each way`,
      ).toEqual(["down", "up"]);

      for (const arrow of arrows) {
        const where = `${theme}, ${arrow.said}`;
        /* The direction is the data's: up where scope rose, down where it
           fell. */
        expect(arrow.said, where).toMatch(
          arrow.direction === "up" ? /scope \+/ : /scope −/,
        );
        expect(arrow.stroke, `${where}: wrong colour`).toBe(
          arrow.direction === "up" ? arrow.red : arrow.green,
        );
      }
      /* And the two really are different colours in this theme. */
      expect(arrows[0]!.red, theme).not.toBe(arrows[0]!.green);
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
