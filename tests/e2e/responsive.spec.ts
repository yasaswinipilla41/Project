import { expect, test, type Page } from "@playwright/test";
import { watchForProblems } from "./support";

/**
 * Every page, at every width Prio is expected to work at.
 *
 * The single assertion that matters most is the absence of horizontal
 * overflow. A page that scrolls sideways on a phone is not "a bit tight" — a
 * column of it is simply unreachable, and it is the failure mode that creeps
 * back every time something is added to a toolbar.
 *
 * Measured on the document element rather than by eye, at both themes, because
 * a dark-mode-only overflow is just as broken and twice as easy to miss.
 */

const WIDTHS = [320, 375, 390, 430, 768, 1024, 1280, 1440, 1920] as const;

const PAGES = [
  { path: "/", name: "Dashboard" },
  { path: "/projects", name: "Projects" },
  { path: "/issues", name: "Issues" },
  { path: "/bugs", name: "Bugs" },
  { path: "/my-work", name: "My work" },
  { path: "/notifications", name: "Notifications" },
  { path: "/reports", name: "Reports" },
  { path: "/issues/eng-1", name: "Issue detail" },
  { path: "/projects/eng", name: "Project detail" },
] as const;

/**
 * How far the document extends past the viewport.
 *
 * A pixel of slack is allowed for sub-pixel rounding in the layout engine —
 * anything beyond that is a real element sticking out.
 */
async function overflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
}

test.describe("No horizontal overflow", () => {
  for (const width of WIDTHS) {
    test(`every page fits at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });

      for (const target of PAGES) {
        await page.goto(target.path);
        // Layout settles before measuring; the shell animates its own width.
        await page.waitForTimeout(250);

        expect(
          await overflow(page),
          `${target.name} (${target.path}) overflows at ${width}px`,
        ).toBeLessThanOrEqual(1);
      }
    });
  }
});

test.describe("Navigation adapts rather than shrinking", () => {
  test("the sidebar becomes a drawer below the tablet breakpoint", async ({
    page,
  }) => {
    await page.goto("/");

    // Wide: the sidebar sits alongside the content.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(250);
    let left = (await page.locator(".prio-sidebar").boundingBox())?.x ?? -1;
    expect(left).toBeGreaterThanOrEqual(0);
    await expect(
      page.getByRole("button", { name: "Open navigation" }),
    ).toBeHidden();

    // Narrow: it moves off-canvas and a control appears to bring it back.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(350);
    left = (await page.locator(".prio-sidebar").boundingBox())?.x ?? 0;
    expect(left, "the sidebar should be off-canvas on a phone").toBeLessThan(0);

    const opener = page.getByRole("button", { name: "Open navigation" });
    await expect(opener).toBeVisible();

    await opener.click();
    await page.waitForTimeout(350);
    left = (await page.locator(".prio-sidebar").boundingBox())?.x ?? -1;
    expect(left).toBeGreaterThanOrEqual(0);

    // Opening it must not push the page sideways.
    expect(await overflow(page)).toBeLessThanOrEqual(1);
  });

  test("the collapsed sidebar keeps its destinations reachable", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");

    await page.getByRole("button", { name: /Collapse|Expand/i }).click();
    await page.waitForTimeout(350);

    const sidebar = page.locator(".prio-sidebar");
    await expect(sidebar).toHaveAttribute("data-collapsed", "true");

    // Labels are hidden, but every item is still a link with a name for
    // assistive technology and a tooltip for everyone else. Scoped to the
    // sidebar itself: the topbar's "Projects" switcher shares the same name.
    /* "My Work" in place of "Activity": Activity is no longer a sidebar item,
       and the point of this loop is that a collapsed item keeps its accessible
       name and tooltip — any four real items prove that equally well. */
    for (const name of ["Home", "Projects", "Issues", "My Work"]) {
      const item = sidebar.getByRole("link", { name, exact: true });
      await expect(item).toBeVisible();
      await expect(item).toHaveAttribute("title", name);
    }

    expect(await overflow(page)).toBeLessThanOrEqual(1);
  });
});

test.describe("Dark mode fits too", () => {
  test("no page overflows in dark mode at phone width", async ({ page }) => {
    const { consoleErrors } = watchForProblems(page);
    await page.setViewportSize({ width: 375, height: 812 });

    for (const target of PAGES) {
      await page.goto(target.path);
      await page.evaluate(() =>
        document.documentElement.setAttribute("data-theme", "dark"),
      );
      await page.waitForTimeout(250);

      expect(
        await overflow(page),
        `${target.name} overflows in dark mode at 375px`,
      ).toBeLessThanOrEqual(1);
    }

    expect(consoleErrors).toEqual([]);
  });
});
