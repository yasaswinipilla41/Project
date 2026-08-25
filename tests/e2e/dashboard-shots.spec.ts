import { expect, test } from "@playwright/test";
import { MEMBER_STATE } from "./support";

/**
 * Visual capture of the dashboard, for reviewing the design by eye.
 *
 * Not an assertion suite — it writes full-page screenshots under
 * `test-results/shots/` and is excluded from the default run. Invoke it
 * explicitly:
 *
 *   npx playwright test tests/e2e/dashboard-shots.spec.ts --grep-invert=nothing
 */
test.describe("@shots dashboard", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`admin — ${theme}`, async ({ page }) => {
      await page.goto("/");
      await page.evaluate(
        (t) => document.documentElement.setAttribute("data-theme", t),
        theme,
      );
      await expect(page.locator(".prio-dash")).toBeVisible();
      await page.waitForTimeout(600);
      await page.screenshot({
        path: `test-results/shots/dashboard-admin-${theme}.png`,
        fullPage: true,
      });
    });
  }

  test.describe("member", () => {
    test.use({ storageState: MEMBER_STATE });

    for (const theme of ["light", "dark"] as const) {
      test(`member — ${theme}`, async ({ page }) => {
        await page.goto("/");
        await page.evaluate(
          (t) => document.documentElement.setAttribute("data-theme", t),
          theme,
        );
        await expect(page.locator(".prio-dash")).toBeVisible();
        await page.waitForTimeout(600);
        await page.screenshot({
          path: `test-results/shots/dashboard-member-${theme}.png`,
          fullPage: true,
        });
      });
    }

    test("member — mobile", async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto("/");
      await expect(page.locator(".prio-dash")).toBeVisible();
      await page.waitForTimeout(600);
      await page.screenshot({
        path: "test-results/shots/dashboard-member-mobile.png",
        fullPage: true,
      });
    });
  });
});
