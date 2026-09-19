import { expect, test, type Page } from "@playwright/test";
import { setViewport, watchForProblems } from "./support";

/**
 * The number beside Columns is how many columns the table is drawing.
 *
 * It used to count the ones that were turned *off*, so switching a column on
 * made the number go down and a table showing everything had no number at all.
 * What makes this worth an end-to-end test rather than a unit test is the
 * claim that the badge and the table cannot disagree: the count is compared
 * against the headers actually rendered, after a round trip to the server that
 * draws them.
 *
 * The row-actions cell is not a column anybody chose — no header, not in the
 * chooser — so the badge is the header count less that one.
 */

/** Columns the table is drawing, from the table itself. */
async function renderedColumns(page: Page): Promise<number> {
  const headers = await page.locator(".prio-table thead th").count();
  return headers - 1; // the actions cell
}

async function badge(page: Page): Promise<number> {
  const text = await page
    .getByRole("button", { name: "Columns" })
    .locator(".prio-filterchip__count")
    .innerText();
  return Number(text.trim());
}

async function toggle(page: Page, label: string) {
  await page.getByRole("button", { name: "Columns" }).click();
  await page.getByRole("menuitemradio", { name: label, exact: true }).click();
  await page.keyboard.press("Escape");
}

test.describe("The Columns badge", () => {
  test.beforeEach(async ({ context }) => {
    /* Start from no stored preference, so the first assertion is about the
       default set rather than about whatever a previous run chose. */
    await context.clearCookies({ name: "prio.issues.columns" });
  });

  test("counts the columns on screen, and follows every toggle", async ({ page }) => {
    const { consoleErrors } = watchForProblems(page);

    await page.goto("/issues");
    await expect(page.locator(".prio-table thead th").first()).toBeVisible();

    const initial = await renderedColumns(page);
    expect(await badge(page)).toBe(initial);

    /* Off: the table loses a column and the badge loses one with it. */
    await toggle(page, "Priority");
    await expect
      .poll(async () => renderedColumns(page))
      .toBe(initial - 1);
    expect(await badge(page)).toBe(initial - 1);

    /* And back on again. */
    await toggle(page, "Priority");
    await expect
      .poll(async () => renderedColumns(page))
      .toBe(initial);
    expect(await badge(page)).toBe(initial);

    expect(consoleErrors).toEqual([]);
  });

  test("keeps the stored choice, and the count that goes with it", async ({
    page,
  }) => {
    await page.goto("/issues");
    await expect(page.locator(".prio-table thead th").first()).toBeVisible();
    const initial = await renderedColumns(page);

    await toggle(page, "Reporter");
    await expect.poll(async () => renderedColumns(page)).toBe(initial - 1);

    await page.reload();
    await expect(page.locator(".prio-table thead th").first()).toBeVisible();
    expect(await renderedColumns(page)).toBe(initial - 1);
    expect(await badge(page)).toBe(initial - 1);

    await toggle(page, "Reporter");
    await expect.poll(async () => renderedColumns(page)).toBe(initial);
  });

  test("says the same thing on a project's own list", async ({ page }) => {
    /* The two lists share one chooser and one resolver, so the claim is that
       the project's own table counts the way the global one does. It has to be
       a project with work in it, or there is no table to count. */
    await page.goto("/projects");
    const withWork = page
      .locator(".prio-projectcard")
      .filter({ hasNot: page.getByText("No issues yet") })
      .first();
    await expect(withWork).toBeVisible();

    const href = await withWork
      .locator("a[href*='/welcome']")
      .first()
      .getAttribute("href");
    const key = /\/projects\/([^/]+)\//.exec(href ?? "")![1]!;

    await page.goto(`/projects/${key}/list`);
    await expect(page.locator(".prio-table thead th").first()).toBeVisible();

    const initial = await renderedColumns(page);
    expect(await badge(page)).toBe(initial);

    await toggle(page, "Status");
    await expect.poll(async () => renderedColumns(page)).toBe(initial - 1);
    expect(await badge(page)).toBe(initial - 1);

    await toggle(page, "Status");
    await expect.poll(async () => renderedColumns(page)).toBe(initial);
  });
});

test.describe("The badge in the toolbar", () => {
  /*
   * The badge used to hide itself when nothing was turned off, so the default
   * table showed a narrower chip than it does now. Always drawing it adds
   * width to a toolbar that already has to fit, which is the one presentation
   * risk this change carries.
   */
  test("fits the toolbar at every width, and never pushes the page sideways", async ({
    page,
  }) => {
    await page.goto("/issues");
    const chip = page.getByRole("button", { name: "Columns" });
    await expect(chip).toBeVisible();

    for (const [width, height] of [
      [1440, 900],
      [834, 1112],
      [390, 844],
    ] as const) {
      await setViewport(page, width, height);
      await expect(chip).toBeVisible();

      const box = (await chip.boundingBox())!;
      expect(box.x, `${width}px: chip starts on screen`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `${width}px: chip ends on screen`).toBeLessThanOrEqual(
        width + 1,
      );

      /* The toolbar wraps rather than widening the document. */
      const overflows = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 1,
      );
      expect(overflows, `${width}px: no sideways scroll`).toBe(false);
    }
  });

  test("is legible on both grounds", async ({ page }) => {
    await page.goto("/issues");
    const count = page
      .getByRole("button", { name: "Columns" })
      .locator(".prio-filterchip__count");

    for (const choice of ["light", "dark"] as const) {
      await page.evaluate(
        (value) => document.documentElement.setAttribute("data-theme", value),
        choice,
      );
      await page.waitForTimeout(120);

      await expect(count, choice).toBeVisible();
      const paint = await count.evaluate((el) => {
        const style = getComputedStyle(el);
        return { background: style.backgroundColor, color: style.color };
      });

      /* A filled pill, not text lost against the chip: it keeps its own
         painted ground in both themes rather than inheriting the surface. */
      expect(paint.background, choice).not.toBe("rgba(0, 0, 0, 0)");
      expect(paint.color, choice).not.toBe(paint.background);
    }
  });
});
