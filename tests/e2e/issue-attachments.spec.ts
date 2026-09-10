import { expect, test, type Page } from "@playwright/test";

/* A genuine 1x1 PNG. The server identifies uploads by their leading bytes, so
   a made-up buffer with an image name would be refused — correctly. */
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * The issue's Attachments panel: looking closely at a picture, and adding
 * several files at once.
 *
 * Both are asserted against what the browser actually does rather than against
 * the markup. Zoom is only worth having if the *page* stays put while the
 * image grows, so the sidebar, the header and the document's own width are
 * measured before and during; and a multi-file drop is only worth having if
 * every file arrives, so the panel is counted rather than the request.
 */

/** Everything that must not move while the image is zoomed. */
async function pageFrame(page: Page) {
  return page.evaluate(() => {
    const box = (selector: string) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height) };
    };
    return {
      sidebar: box(".prio-sidebar"),
      docWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    };
  });
}

test.describe("Issue attachments", () => {
  test("takes several files in one go, and keeps what was already there", async ({
    page,
  }) => {
    await page.goto("/issues");
    await page.waitForLoadState("networkidle");
    const firstIssue = page.locator("tbody tr a[href^='/issues/']").first();
    await firstIssue.click();
    await expect(page.getByRole("heading", { name: "Attachments" })).toBeVisible();

    const grid = page.locator(".prio-attachment");
    const before = await grid.count();

    /* Three at once, through the panel's own input — the control the drop
       handler feeds. `multiple` is what makes a drop of three arrive as
       three rather than as the first one. */
    const stamp = Date.now();
    await page
      .locator('input[aria-label="Attach files to this issue"]')
      .setInputFiles([
        { name: `batch-a-${stamp}.png`, mimeType: "image/png", buffer: PNG_1PX },
        { name: `batch-b-${stamp}.png`, mimeType: "image/png", buffer: PNG_1PX },
        { name: `batch-c-${stamp}.txt`, mimeType: "text/plain", buffer: Buffer.from("prio") },
      ]);

    await expect(grid).toHaveCount(before + 3, { timeout: 30_000 });

    const names = await page.locator(".prio-attachment__name").allInnerTexts();
    for (const name of [`batch-a-${stamp}.png`, `batch-b-${stamp}.png`, `batch-c-${stamp}.txt`]) {
      expect(names, `${name} arrived`).toContain(name);
    }
  });

  test("refuses one file without losing the rest of the batch", async ({ page }) => {
    await page.goto("/issues");
    await page.waitForLoadState("networkidle");
    await page.locator("tbody tr a[href^='/issues/']").first().click();
    await expect(page.getByRole("heading", { name: "Attachments" })).toBeVisible();

    const grid = page.locator(".prio-attachment");
    const before = await grid.count();

    /* An executable is refused by the server, which reads the leading bytes
       rather than trusting the name. The image beside it must still land: one
       rejection is not a reason to abandon the batch. */
    const stamp = Date.now();
    await page
      .locator('input[aria-label="Attach files to this issue"]')
      .setInputFiles([
        {
          name: `nope-${stamp}.exe`,
          mimeType: "application/octet-stream",
          buffer: Buffer.from([0x4d, 0x5a, 0x90, 0x00]),
        },
        { name: `ok-${stamp}.png`, mimeType: "image/png", buffer: PNG_1PX },
      ]);

    await expect(grid).toHaveCount(before + 1, { timeout: 30_000 });

    // The refusal is named rather than swallowed.
    await expect(page.locator(".prio-composer__error")).toBeVisible();

    const names = await page.locator(".prio-attachment__name").allInnerTexts();
    expect(names).toContain(`ok-${stamp}.png`);
    expect(names).not.toContain(`nope-${stamp}.exe`);
  });

  test("zooms the image and nothing else", async ({ page }) => {
    await page.goto("/issues");
    await page.waitForLoadState("networkidle");
    await page.locator("tbody tr a[href^='/issues/']").first().click();
    await expect(page.getByRole("heading", { name: "Attachments" })).toBeVisible();

    const stamp = Date.now();
    await page
      .locator('input[aria-label="Attach files to this issue"]')
      .setInputFiles([
        { name: `zoom-${stamp}.png`, mimeType: "image/png", buffer: PNG_1PX },
      ]);
    const thumb = page.locator(
      `.prio-attachment__preview[aria-label="Open zoom-${stamp}.png"]`,
    );
    await expect(thumb).toBeVisible({ timeout: 30_000 });

    const before = await pageFrame(page);

    await thumb.click();
    const image = page.locator(".prio-lightbox__image");
    await expect(image).toBeVisible();

    const scaleOf = () =>
      image.evaluate((el) => {
        const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
        return m.a;
      });

    /* Polled, because the image eases between sizes: read at the wrong moment
       `getComputedStyle` hands back a value part-way through the transition. */
    await expect.poll(scaleOf).toBeCloseTo(1, 2);

    await page.getByRole("button", { name: "Zoom in" }).click();
    await page.getByRole("button", { name: "Zoom in" }).click();
    await expect.poll(scaleOf, { timeout: 5_000 }).toBeGreaterThan(1);

    /* The whole point: the page is exactly as it was. A browser zoom would
       have changed the sidebar's size and the document's width along with the
       picture. */
    expect(await pageFrame(page)).toEqual(before);

    // …and the overlay has not given the page anything to scroll sideways.
    const during = await pageFrame(page);
    expect(during.docWidth).toBeLessThanOrEqual(during.clientWidth + 1);

    // Back to fit, then closed, and the page is still usable.
    await page.getByRole("button", { name: "Reset zoom to fit" }).click();
    await expect.poll(scaleOf, { timeout: 5_000 }).toBeCloseTo(1, 2);

    await page.getByRole("button", { name: "Close" }).click();
    await expect(page.locator(".prio-lightbox")).toHaveCount(0);
    expect(await pageFrame(page)).toEqual(before);
  });
});
