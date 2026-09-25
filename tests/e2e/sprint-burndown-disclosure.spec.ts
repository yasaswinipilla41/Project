import { expect, test, type Page } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { ADMIN_STATE, openBurndown, watchForProblems } from "./support";

/**
 * The burndown, opened from the sprint header instead of always drawn.
 *
 * The chart is the tallest thing on a sprint's page and answers a question
 * that is not always being asked, so it used to put the sprint's own work most
 * of a screen down. It is now behind a button, and this spec is about that
 * button: that the page starts compact, that what opens is the same chart with
 * the same figures and the same detail on hover, that it closes both ways it
 * offers, and that none of it needs a mouse.
 *
 * What the chart *says* is not re-asserted here — `burndown-detail`,
 * `burndown-axes` and `effort-burndown-history` own that, and all three now
 * open the panel first. The claim made here is that opening it is all that
 * changed.
 *
 * The borders are in this file too, for the same reason: they are a claim
 * about the sprint page as a whole, checked from the computed styles rather
 * than from the stylesheet, so a block that loses its edge fails whichever
 * rule it lost.
 */

test.use({ storageState: ADMIN_STATE });

const DAY = 24 * 60 * 60 * 1000;
const createdProjects: string[] = [];

test.afterAll(async () => {
  for (const id of createdProjects) {
    await prisma.issue.deleteMany({ where: { projectId: id } });
    await prisma.sprint.deleteMany({ where: { projectId: id } });
    await prisma.project.deleteMany({ where: { id } });
  }
});

/**
 * A running sprint with something to draw: 12 estimated hours across two
 * issues, one of them finished.
 *
 * Its own project, because a sprint page is only compact if this sprint's work
 * is what is on it, and because "one sprint runs at a time in a project" is a
 * real rule that a shared project may already be using.
 */
async function seedSprint() {
  const admin = await prisma.user.findFirstOrThrow({
    where: { role: "ADMIN" },
    select: { id: true },
  });
  const key = `BDD${Date.now().toString(36).toUpperCase()}`.slice(0, 10);
  const project = await prisma.project.create({
    data: {
      key,
      name: `Burndown disclosure fixture ${key}`,
      createdById: admin.id,
      members: { create: { userId: admin.id } },
      issueSequence: 2,
    },
    select: { id: true, key: true },
  });
  createdProjects.push(project.id);

  const start = new Date(Date.now() - 7 * DAY);
  const sprint = await prisma.sprint.create({
    data: {
      name: `Disclosure sprint ${Date.now()}`,
      startDate: start,
      endDate: new Date(Date.now() + 6 * DAY),
      projectId: project.id,
      createdById: admin.id,
      status: "ACTIVE",
      startedAt: start,
    },
    select: { id: true },
  });

  await prisma.issue.create({
    data: {
      projectId: project.id,
      key: `${project.key}-1`,
      number: 1,
      title: "Four hours, finished",
      type: "TASK",
      status: "DONE",
      reporterId: admin.id,
      sprintId: sprint.id,
      effortHours: 4,
      remainingHours: 4,
    },
  });
  await prisma.issue.create({
    data: {
      projectId: project.id,
      key: `${project.key}-2`,
      number: 2,
      title: "Eight hours, in progress",
      type: "TASK",
      status: "IN_PROGRESS",
      reporterId: admin.id,
      sprintId: sprint.id,
      effortHours: 8,
      remainingHours: 8,
    },
  });

  return { key: project.key.toLowerCase(), sprintId: sprint.id };
}

/* Exact, because "Close Burndown Chart" would otherwise match it too — an
   accessible-name match is a substring match by default. */
const toggle = (page: Page) =>
  page.getByRole("button", { name: "Burndown Chart", exact: true });
const panel = (page: Page) => page.locator(".prio-burndownpanel");

test.describe("the Burndown Chart button", () => {
  test("leaves the page compact until it is asked, and sits before the sprint's own actions", async ({
    page,
  }) => {
    const { consoleErrors } = watchForProblems(page);
    const { key, sprintId } = await seedSprint();
    await page.goto(`/projects/${key}/sprints/${sprintId}`);

    const button = toggle(page);
    await expect(button).toBeVisible({ timeout: 45_000 });

    // Nothing of the chart is drawn, and the button says so.
    await expect(panel(page)).toHaveCount(0);
    await expect(page.locator(".prio-burndown")).toHaveCount(0);
    await expect(button).toHaveAttribute("aria-expanded", "false");

    /*
     * In the header's own actions row, first.
     *
     * Position measured rather than read from the markup: "before the + and
     * Edit" is a claim about what somebody sees, and a flex row can reorder
     * what the DOM says.
     */
    const row = page.locator(".prio-sprint__actions");
    await expect(
      row.getByRole("button", { name: "Burndown Chart", exact: true }),
    ).toHaveCount(1);
    const box = (await button.boundingBox())!;
    for (const name of ["Add issues", "Edit"]) {
      const other = (await page.getByRole("button", { name }).boundingBox())!;
      expect(box.x, `Burndown Chart before ${name}`).toBeLessThan(other.x);
    }

    /*
     * And the sprint's own work is on screen without scrolling — the point of
     * collapsing the chart. Asserted against the viewport, because "moves
     * upward" is only worth anything if it moves far enough to be seen.
     */
    const issues = page.getByRole("heading", { name: "Issues in this sprint" });
    const heading = (await issues.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(heading.y).toBeLessThan(viewport.height);

    expect(consoleErrors).toEqual([]);
  });

  test("opens the existing chart, once, with its figures and its detail on hover", async ({
    page,
  }) => {
    const { consoleErrors } = watchForProblems(page);
    const { key, sprintId } = await seedSprint();
    await page.goto(`/projects/${key}/sprints/${sprintId}`);

    await toggle(page).click();
    await expect(panel(page)).toBeVisible();
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");

    /* One chart, not a second one beside it — the thing a duplicate
       implementation would show up as. */
    await expect(page.locator(".prio-burndown")).toHaveCount(1);
    await expect(page.locator("polyline.prio-burndown__ideal")).toHaveCount(1);
    await expect(page.locator("polyline.prio-burndown__actual")).toHaveCount(1);

    /* The heading the panel is named by, and the six figures, all inside the
       panel rather than loose on the page. */
    await expect(
      panel(page).getByRole("heading", { name: "Burndown Chart" }),
    ).toBeVisible();
    const figures = await panel(page)
      .locator(".prio-burndown__figure")
      .evaluateAll((nodes) =>
        nodes.map((node) => [
          node.querySelector("dt")!.textContent!.trim(),
          node.querySelector("dd")!.textContent!.trim(),
        ]),
      );
    /* All six, and each one's arithmetic: 12 hours committed across two
       issues, 4 of them finished. Read from the panel, so this is the chart
       the button opened rather than a figure from the sprint's own strip. */
    expect(figures).toEqual([
      ["Total Effort", "12h"],
      ["Completed Effort", "4h"],
      ["Remaining Effort", "8h"],
      ["Total Issues", "2"],
      ["Completed Issues", "1"],
      ["Remaining Issues", "1"],
    ]);

    /*
     * The day-detail still appears under the pointer, beside the day it
     * explains. This is the interaction most at risk from being opened late:
     * the panel places itself by measuring, and a chart measured while hidden
     * would put its detail somewhere else entirely.
     */
    const hits = panel(page).locator(".prio-burndown__hit");
    expect(await hits.count()).toBeGreaterThan(0);
    await hits.first().hover();
    const tip = panel(page).locator(".prio-burndown__tip");
    await expect(tip).toBeVisible();
    /* What this tooltip has always said: the day, and what was left of the
       effort on it. The Ideal line is named in the legend rather than in the
       day detail — asserted as the chart is, not as it might have been, since
       nothing here redesigns it. */
    await expect(tip).toContainText(/\d{1,2} \w{3} \d{4}/);
    await expect(tip).toContainText(/Remaining: /);
    await expect(panel(page).locator(".prio-burndown__legend")).toContainText(
      "Ideal",
    );

    const tipBox = (await tip.boundingBox())!;
    const panelBox = (await panel(page).boundingBox())!;
    /* Inside the panel that owns it, so nothing is clipped or floating over
       the sprint's work. */
    expect(tipBox.x).toBeGreaterThanOrEqual(panelBox.x - 1);
    expect(tipBox.x + tipBox.width).toBeLessThanOrEqual(
      panelBox.x + panelBox.width + 1,
    );

    expect(consoleErrors).toEqual([]);
  });

  test("closes from the X and from the button, and changes no data doing it", async ({
    page,
  }) => {
    const { key, sprintId } = await seedSprint();
    await page.goto(`/projects/${key}/sprints/${sprintId}`);

    /*
     * The sprint's own figures, before any of this: opening a chart is a
     * question, not an edit, and the page must read the same afterwards.
     *
     * Read as label/value pairs from the DOM rather than as the strip's
     * rendered text: `innerText` is what the browser has *laid out*, so the
     * same strip read before the stylesheet has landed comes back in a
     * different case and without the spacing, and the comparison fails over
     * the stylesheet rather than over the figures.
     */
    const stats = page.locator(".prio-sprint__summary");
    await expect(stats).toBeVisible({ timeout: 45_000 });
    const figuresNow = () =>
      stats.locator(".prio-sprint__stat").evaluateAll((nodes) =>
        nodes.map((node) => [
          node.querySelector(".prio-sprint__statlabel")?.textContent?.trim() ?? "",
          node.querySelector(".prio-sprint__statvalue")?.textContent?.trim() ?? "",
        ]),
      );
    const before = await figuresNow();
    expect(before.length).toBeGreaterThan(0);

    await openBurndown(page);
    await panel(page).getByRole("button", { name: "Close Burndown Chart" }).click();
    await expect(panel(page)).toHaveCount(0);
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");

    // And the button itself closes what it opened.
    await toggle(page).click();
    await expect(panel(page)).toBeVisible();
    await toggle(page).click();
    await expect(panel(page)).toHaveCount(0);

    expect(await figuresNow()).toEqual(before);
    /* The sprint's work is still listed, untouched by any of it. */
    await expect(
      page.getByRole("heading", { name: "Issues in this sprint" }),
    ).toBeVisible();
  });

  test("opens and closes from the keyboard alone", async ({ page }) => {
    const { key, sprintId } = await seedSprint();
    await page.goto(`/projects/${key}/sprints/${sprintId}`);

    const button = toggle(page);
    await button.focus();
    await expect(button).toBeFocused();

    await page.keyboard.press("Enter");
    await expect(panel(page)).toBeVisible();
    await expect(button).toHaveAttribute("aria-expanded", "true");

    /* Space too, which is the other key a button answers to. */
    await page.keyboard.press(" ");
    await expect(panel(page)).toHaveCount(0);

    await page.keyboard.press("Enter");
    await expect(panel(page)).toBeVisible();

    /* And the way out is reachable without a mouse as well. */
    const close = panel(page).getByRole("button", {
      name: "Close Burndown Chart",
    });
    await close.focus();
    await page.keyboard.press("Enter");
    await expect(panel(page)).toHaveCount(0);
  });

  test("keeps clear of the sprint's actions on a narrow screen, and the chart fits its card", async ({
    page,
  }) => {
    const { key, sprintId } = await seedSprint();
    await page.setViewportSize({ width: 768, height: 900 });
    await page.goto(`/projects/${key}/sprints/${sprintId}`);

    const button = toggle(page);
    await expect(button).toBeVisible({ timeout: 45_000 });

    /* No overlap with the controls beside it: the row wraps rather than
       stacking things on top of each other. */
    const box = (await button.boundingBox())!;
    for (const name of ["Add issues", "Edit"]) {
      const other = (await page.getByRole("button", { name }).boundingBox())!;
      const overlaps =
        box.x < other.x + other.width &&
        other.x < box.x + box.width &&
        box.y < other.y + other.height &&
        other.y < box.y + box.height;
      expect(overlaps, `Burndown Chart overlaps ${name}`).toBe(false);
    }

    await openBurndown(page);
    /* The chart draws inside the width it was given rather than pushing the
       page sideways. The plot keeps a floor width on a narrow screen and its
       own scroller handles that, so the claim is about the card and the page,
       not the drawing. */
    const cardBox = (await panel(page).boundingBox())!;
    expect(cardBox.width).toBeLessThanOrEqual(768);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

test.describe("every block on a sprint's page", () => {
  test("carries the same border", async ({ page }) => {
    const { key, sprintId } = await seedSprint();
    await page.goto(`/projects/${key}/sprints/${sprintId}`);
    await openBurndown(page);

    /*
     * Read from the computed styles, block by block, rather than from the
     * stylesheet: what is being asserted is that each of these actually has an
     * edge, and that they all have the *same* one — a border added to a block
     * in a different colour or width would pass a rule-by-rule check and still
     * look like an afterthought.
     *
     * The status blocks inside Issues in this sprint are the ones that had no
     * border at all; they are included here by the same selector the others
     * are, so nothing about this test knows which was the odd one out.
     */
    const edges = await page.evaluate(() => {
      const of = (selector: string) =>
        [...document.querySelectorAll(selector)].map((node) => {
          const style = getComputedStyle(node);
          return {
            selector,
            width: style.borderTopWidth,
            style: style.borderTopStyle,
            colour: style.borderTopColor,
          };
        });
      return [
        ...of(".prio-sprint"),
        ...of(".prio-burndownpanel"),
        ...of(".prio-sprint__column"),
        /* The two remaining cards on this page, named by what is in them
           rather than by a class every card in Prio shares. */
        ...of(".prio-card:has(> * > .prio-sprint__board)"),
        ...of(".prio-card:has(.prio-isochart)"),
      ];
    });

    /* Every block named above was found. */
    for (const selector of [
      ".prio-sprint",
      ".prio-burndownpanel",
      ".prio-sprint__column",
      ".prio-card:has(> * > .prio-sprint__board)",
      ".prio-card:has(.prio-isochart)",
    ]) {
      expect(
        edges.filter((edge) => edge.selector === selector).length,
        `${selector} found`,
      ).toBeGreaterThan(0);
    }

    for (const edge of edges) {
      expect(edge.style, `${edge.selector} border style`).toBe("solid");
      expect(
        Number.parseFloat(edge.width),
        `${edge.selector} border width`,
      ).toBeGreaterThanOrEqual(1);
    }

    /*
     * One colour across all of them.
     *
     * The running sprint's own card is the exception and stays one: an active
     * sprint is marked out by its edge, which is deliberate and older than
     * this change. Everything else is the same token.
     */
    const ordinary = edges.filter((edge) => edge.selector !== ".prio-sprint");
    expect(new Set(ordinary.map((edge) => edge.colour)).size).toBe(1);
  });
});
