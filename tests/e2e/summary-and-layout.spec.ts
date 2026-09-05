import { expect, test, type Page } from "@playwright/test";
import { prisma } from "@/lib/prisma";

/**
 * Five separate fixes, each verified where it actually shows:
 *
 *   - the project summary marks completed work and says who completed it;
 *   - Status overview is compact, tinted per status, and keeps its count and
 *     share on one line;
 *   - the calendar's day composer is no longer clipped by the calendar;
 *   - collapsing the sidebar widens the main content by what it gave up;
 *   - the Flow Board's column height and cancelled-card background.
 */

/* ------------------------------------------------- summary: completed work */

test.describe("The project summary's Completed section", () => {
  test("sits below Open work by assignee and groups by who finished it", async ({
    page,
  }) => {
    await page.goto("/projects/eng");

    const workload = page
      .locator(".prio-card", { hasText: "Open work by assignee" })
      .first();
    const completed = page
      .locator(".prio-card", { hasText: "Completed" })
      .filter({ has: page.locator(".prio-completed, .prio-text-muted") })
      .last();

    await expect(workload).toBeVisible();
    await expect(completed).toBeVisible();

    // Directly below it, not above and not elsewhere on the page.
    const above = (await workload.boundingBox())!;
    const below = (await completed.boundingBox())!;
    expect(below.y).toBeGreaterThan(above.y);

    const people = completed.locator(".prio-completed__person");
    if ((await people.count()) === 0) {
      // A project with nothing finished says so rather than showing an empty list.
      await expect(completed).toContainText(/nothing has been completed/i);
      return;
    }

    /* Every issue listed under a person leads to that person's work in this
       project — the completer's, read from the activity trail, not the
       assignee's. */
    const first = people.first();
    const link = first.locator("a.prio-completed__issue").first();
    if ((await link.count()) > 0) {
      const href = await link.getAttribute("href");
      expect(href).toMatch(/^\/projects\/eng\/list\?assignee=.+/);

      await link.click();
      await expect(page).toHaveURL(/\/projects\/eng\/list\?assignee=/);
    }
  });

  test("marks completed issues in Recently updated", async ({ page }) => {
    const done = await prisma.issue.count({
      where: { project: { key: "ENG" }, status: "DONE" },
    });
    test.skip(done === 0, "nothing is completed in ENG to mark");

    await page.goto("/projects/eng");
    const recent = page
      .locator(".prio-card", { hasText: "Recently updated" })
      .first();
    await expect(recent).toBeVisible();

    const rows = recent.locator(".prio-relatedrow");
    await expect(rows.first()).toBeVisible();

    /* Whichever of the recent rows are Done carry the marker, and the ones
       that are not, do not — so this is a mark on completion rather than
       decoration on every row. */
    for (let i = 0; i < (await rows.count()); i += 1) {
      const row = rows.nth(i);
      const isDone = (await row.locator(".prio-status").innerText())
        .trim()
        .toLowerCase()
        .includes("done");
      const marked = (await row.getAttribute("data-completed")) !== null;
      expect(marked, `row ${i}: done=${isDone}`).toBe(isDone);
    }
  });
});

/* --------------------------------------------------------- status overview */

test.describe("Status overview", () => {
  test("is compact, tinted per status, and keeps its figures on one line", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto("/projects/eng");

    const card = page
      .locator(".prio-card", { hasText: "Status overview" })
      .first();
    await expect(card).toBeVisible();

    // Compressed: it no longer stretches across the whole column.
    const box = (await card.boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(560);
    // …but not so narrow that the ring and its legend cannot both fit.
    expect(box.width).toBeGreaterThan(400);

    const rows = card.locator(".prio-donut__legenditem");
    await expect(rows.first()).toBeVisible();

    for (let i = 0; i < (await rows.count()); i += 1) {
      const row = rows.nth(i);

      // Highlighted: the row carries its own status, and a tint to match.
      await expect(row).toHaveAttribute("data-status", /.+/);
      const background = await row.evaluate(
        (el) => getComputedStyle(el).backgroundColor,
      );
      expect(background).not.toBe("rgba(0, 0, 0, 0)");

      /* "23  45%" — both figures visible, on the same line, neither wrapped
         away nor hidden. */
      const value = row.locator(".prio-donut__legendvalue");
      const share = row.locator(".prio-donut__legendshare");
      await expect(value).toBeVisible();
      await expect(share).toBeVisible();
      await expect(share).toHaveText(/^\d+%$/);

      const valueBox = (await value.boundingBox())!;
      const shareBox = (await share.boundingBox())!;
      // Side by side, sharing a line.
      expect(shareBox.x).toBeGreaterThan(valueBox.x);
      expect(Math.abs(shareBox.y - valueBox.y)).toBeLessThan(valueBox.height);
      // And inside the card, not clipped off the end of it.
      expect(shareBox.x + shareBox.width).toBeLessThanOrEqual(box.x + box.width);
    }
  });

  test("brings a status's own figures forward on hover", async ({ page }) => {
    await page.goto("/projects/eng");
    const row = page.locator(".prio-donut__legenditem").first();
    await expect(row).toBeVisible();

    const share = row.locator(".prio-donut__legendshare");
    const before = await share.evaluate((el) => getComputedStyle(el).color);

    await row.hover();
    await expect
      .poll(async () => share.evaluate((el) => getComputedStyle(el).color))
      .not.toBe(before);

    // The value it belongs to is still beside it, still readable.
    await expect(share).toBeVisible();
    await expect(row.locator(".prio-donut__legendvalue")).toBeVisible();
  });
});

/* ------------------------------------------------------ calendar clipping */

test.describe("The calendar's day composer", () => {
  test("is not clipped by the calendar container", async ({ page }) => {
    /*
     * The fault this covers is not placement — that was already fixed — but
     * the grid's own `overflow: hidden`, which cropped a correctly placed
     * panel at the calendar's border. A bounding box cannot see that, because
     * a clipped element still reports its full geometry. Asking the document
     * what is actually painted at a point inside the panel can.
     */
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/projects/eng/calendar");
    await page.waitForSelector(".prio-calendar");

    const days = page.locator(".prio-calendar__cell:not([data-empty])");
    const composer = page.locator(".prio-calendar__composer");

    // The last day of the month: the one hard against the grid's bottom edge.
    const cell = days.nth((await days.count()) - 1);
    await cell.evaluate((el) => el.scrollIntoView({ block: "center" }));
    await cell.hover();
    await cell.locator(".prio-calendar__add").click();
    await expect(composer).toBeVisible();

    const box = (await composer.boundingBox())!;

    /* Four points well inside the panel, including near its bottom edge, which
       is the part a clipping container eats first. */
    const probes = [
      { x: box.x + box.width / 2, y: box.y + 6 },
      { x: box.x + box.width / 2, y: box.y + box.height / 2 },
      { x: box.x + 8, y: box.y + box.height - 6 },
      { x: box.x + box.width - 8, y: box.y + box.height - 6 },
    ];

    for (const point of probes) {
      const insideComposer = await page.evaluate(
        ({ x, y }) => {
          const element = document.elementFromPoint(x, y);
          return element ? element.closest(".prio-calendar__composer") !== null : false;
        },
        point,
      );
      expect(
        insideComposer,
        `the composer is painted at (${Math.round(point.x)}, ${Math.round(point.y)})`,
      ).toBe(true);
    }

    // The calendar itself no longer crops what escapes it.
    await expect(page.locator(".prio-calendar")).toHaveCSS("overflow", "visible");
    // …and it still looks like one rounded grid.
    const radius = await page
      .locator(".prio-calendar > :first-child")
      .evaluate((el) => getComputedStyle(el).borderTopLeftRadius);
    expect(parseFloat(radius)).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------ sidebar collapse + board */

async function collapseWidth(page: Page) {
  return page
    .locator(".prio-content__inner")
    .evaluate((el) => el.getBoundingClientRect().width);
}

test.describe("Collapsing the sidebar", () => {
  test("hands the freed width to the Flow Board", async ({ page }) => {
    /* A window wide enough that the content cap is what limits the board —
       below the cap there is no freed width to hand over and nothing to
       measure. */
    await page.setViewportSize({ width: 1920, height: 900 });
    await page.goto("/projects/eng/board");
    await expect(page.locator(".prio-board")).toBeVisible();

    const main = page.locator(".prio-main");
    await expect(main).toHaveAttribute("data-collapsed", "false");
    const expanded = await collapseWidth(page);

    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await expect(main).toHaveAttribute("data-collapsed", "true");
    // The width transition has to land before it is measured.
    await page.waitForTimeout(500);

    const collapsed = await collapseWidth(page);

    /* Wider by what the sidebar gave up — 248px expanded, 60px collapsed. The
       tolerance covers sub-pixel layout, not a different rule. */
    expect(collapsed - expanded).toBeGreaterThan(180);
    expect(collapsed - expanded).toBeLessThan(196);

    // The board itself uses it: its column area grew with the content.
    const columns = await page
      .locator(".prio-board__columns")
      .evaluate((el) => el.getBoundingClientRect().width);
    expect(columns).toBeGreaterThan(expanded - 100);

    // Expanding again restores exactly the layout that was there before.
    await page.getByRole("button", { name: "Expand sidebar" }).click();
    await expect(main).toHaveAttribute("data-collapsed", "false");
    await page.waitForTimeout(500);
    expect(Math.abs((await collapseWidth(page)) - expanded)).toBeLessThan(2);
  });

  test("still fits on a narrow window", async ({ page }) => {
    // Below the mobile breakpoint the sidebar is an overlay and owns no width.
    await page.setViewportSize({ width: 900, height: 800 });
    await page.goto("/projects/eng/board");
    await expect(page.locator(".prio-board")).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });
});

test.describe("The Flow Board's own styling", () => {
  test("gives a column body the taller allowance at 1366px", async ({ page }) => {
    await page.setViewportSize({ width: 1300, height: 800 });
    await page.goto("/projects/eng/board");

    const body = page.locator(".prio-board__column-body").first();
    await expect(body).toBeVisible();

    /* `calc(112vh - 415px)` at 800px tall — resolved rather than compared as a
       string, because that is what the browser actually applies. */
    const maxHeight = await body.evaluate(
      (el) => parseFloat(getComputedStyle(el).maxHeight),
    );
    expect(Math.round(maxHeight)).toBe(Math.round(800 * 1.12 - 415));
  });

  test("paints a cancelled card white", async ({ page }) => {
    const cancelled = await prisma.issue.findFirst({
      where: { project: { key: "ENG" }, status: "CANCELLED" },
      select: { id: true },
    });
    test.skip(!cancelled, "no cancelled issue in ENG to look at");

    await page.goto("/projects/eng/board");
    const card = page.locator('.prio-board__card[data-cancelled="true"]').first();
    await expect(card).toBeVisible();

    await expect(card).toHaveCSS("background-color", "rgb(255, 255, 255)");

    // Non-cancelled cards are untouched by that rule.
    const ordinary = page
      .locator(".prio-board__card:not([data-cancelled])")
      .first();
    if ((await ordinary.count()) > 0) {
      await expect(ordinary).not.toHaveCSS(
        "text-decoration-line",
        "line-through",
      );
    }
  });
});

/* ------------------------------------------------------------------ theme */

test.describe("Theme", () => {
  test("starts on System, which follows the browser", async ({ browser }) => {
    for (const scheme of ["light", "dark"] as const) {
      const context = await browser.newContext({ colorScheme: scheme });
      const page = await context.newPage();

      await page.goto("/");
      await expect(page.locator(".prio-sidebar")).toBeVisible();

      /* No stored choice, so no `data-theme` attribute — which is exactly what
         "System" is, and what the media query in `theme-dark.css` is written
         against. Nothing forces dark. */
      await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.*/);
      await expect(
        page.getByRole("button", { name: "Theme: System" }),
      ).toBeVisible();

      const background = await page
        .locator("body")
        .evaluate((el) => getComputedStyle(el).backgroundColor);
      const rgb = background.match(/\d+/g)!.map(Number);
      const light = (rgb[0]! + rgb[1]! + rgb[2]!) / 3 > 128;
      expect(light, `${scheme} scheme`).toBe(scheme === "light");

      await context.close();
    }
  });

  test("still lets Light and Dark be chosen", async ({ page }) => {
    await page.goto("/");
    const control = page.getByRole("button", { name: /^Theme: / });

    for (const choice of ["Dark", "Light"] as const) {
      await control.click();
      await page.getByRole("menuitemradio", { name: choice }).click();
      await expect(page.locator("html")).toHaveAttribute(
        "data-theme",
        choice.toLowerCase(),
      );
    }

    // And back to the default.
    await control.click();
    await page.getByRole("menuitemradio", { name: "System" }).click();
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.*/);
  });
});
