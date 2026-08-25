import { expect, test, type Page } from "@playwright/test";
import { MEMBER_STATE, setViewport, watchForProblems } from "./support";

/**
 * One application, one theme.
 *
 * The defect these exist for is specific: the page turned light while the
 * sidebar stayed dark, so Prio looked like two designs sharing a screen. It is
 * not enough to check that *something* changed — the navigation has to move in
 * the same direction as the content, which is what the luminance comparisons
 * below actually measure.
 */

/** Relative luminance of a computed `rgb()` string, 0 (black) to 1 (white). */
function luminance(colour: string): number {
  const [r = 0, g = 0, b = 0] = colour
    .replace(/[^\d,.]/g, "")
    .split(",")
    .map(Number);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

async function setTheme(page: Page, theme: "light" | "dark") {
  await page.evaluate(
    (t) => document.documentElement.setAttribute("data-theme", t),
    theme,
  );
  // One frame for the custom-property cascade to settle before measuring.
  await page.waitForTimeout(120);
}

async function surfaces(page: Page) {
  return page.evaluate(() => {
    const read = (selector: string, prop: string) => {
      const el = document.querySelector(selector);
      return el ? getComputedStyle(el).getPropertyValue(prop) : "";
    };
    return {
      page: getComputedStyle(document.body).backgroundColor,
      sidebar: read(".prio-sidebar", "background-color"),
      sidebarBorder: read(".prio-sidebar", "border-right-color"),
      navText: read(".prio-navitem", "color"),
      sectionLabel: read(".prio-sidebar__section-label", "color"),
      wordmark: read(".prio-wordmark", "color"),
      topbar: read(".prio-topbar", "background-color"),
    };
  });
}

test.describe("The whole application follows one theme", () => {
  test("light mode gives a light sidebar, not a dark one", async ({ page }) => {
    const { consoleErrors, failedRequests } = watchForProblems(page);

    await page.goto("/");
    await expect(page.locator(".prio-sidebar")).toBeVisible();
    await setTheme(page, "light");

    const light = await surfaces(page);

    // The page is light…
    expect(luminance(light.page)).toBeGreaterThan(0.7);
    // …and so is the sidebar. This is the assertion the old build failed.
    expect(
      luminance(light.sidebar),
      "the sidebar must be light when the page is light",
    ).toBeGreaterThan(0.7);

    // Text on it is dark enough to read against that light ground.
    expect(luminance(light.navText)).toBeLessThan(0.45);
    expect(luminance(light.sectionLabel)).toBeLessThan(0.65);
    expect(luminance(light.wordmark)).toBeLessThan(0.35);

    expect(consoleErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
  });

  test("dark mode gives a dark sidebar and readable text", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".prio-sidebar")).toBeVisible();
    await setTheme(page, "dark");

    const dark = await surfaces(page);

    expect(luminance(dark.page)).toBeLessThan(0.3);
    expect(luminance(dark.sidebar)).toBeLessThan(0.3);

    // Text has to be light here, or the sidebar is unreadable.
    expect(luminance(dark.navText)).toBeGreaterThan(0.55);
    expect(luminance(dark.wordmark)).toBeGreaterThan(0.8);
  });

  test("every navigation surface moves together", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".prio-sidebar")).toBeVisible();

    await setTheme(page, "light");
    const light = await surfaces(page);

    await setTheme(page, "dark");
    const dark = await surfaces(page);

    /* Each of these was a separate opportunity to leave something behind. A
       single one that failed to change is the bug returning in miniature. */
    for (const key of Object.keys(light) as (keyof typeof light)[]) {
      expect(dark[key], `${key} did not change between themes`).not.toBe(
        light[key],
      );
    }

    // And the direction is consistent: everything got darker, nothing inverted.
    expect(luminance(dark.sidebar)).toBeLessThan(luminance(light.sidebar));
    expect(luminance(dark.topbar)).toBeLessThan(luminance(light.topbar));
  });

  test("the active navigation item is distinguishable in both themes", async ({
    page,
  }) => {
    await page.goto("/");

    for (const theme of ["light", "dark"] as const) {
      await setTheme(page, theme);

      const measured = await page.evaluate(() => {
        const active = document.querySelector<HTMLElement>(
          '.prio-navitem[aria-current="page"]',
        );
        const inactive = [
          ...document.querySelectorAll<HTMLElement>(".prio-navitem"),
        ].find((el) => el.getAttribute("aria-current") !== "page");

        if (!active || !inactive) return null;
        const a = getComputedStyle(active);
        const i = getComputedStyle(inactive);
        return {
          activeBg: a.backgroundColor,
          inactiveBg: i.backgroundColor,
          activeFg: a.color,
          inactiveFg: i.color,
          activeWeight: a.fontWeight,
          inactiveWeight: i.fontWeight,
        };
      });

      expect(measured, "there should be an active navigation item").not.toBeNull();
      if (!measured) return;

      // Distinguished by more than one signal, so it does not rely on colour
      // alone — which is both an accessibility rule and a robustness one.
      expect(measured.activeBg).not.toBe(measured.inactiveBg);
      expect(measured.activeFg).not.toBe(measured.inactiveFg);
      expect(Number(measured.activeWeight)).toBeGreaterThan(
        Number(measured.inactiveWeight),
      );
    }
  });

  test("the sign-in brand panel stays dark in both themes", async ({
    browser,
  }) => {
    /* The splash panel is a brand surface, not a navigation one — the brand
       sheet specifies it dark. This is the counterpart to the tests above:
       navigation follows the theme, chrome deliberately does not.

       Signed out on purpose: visiting /sign-in with a session redirects
       straight back to the dashboard. */
    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();

    for (const theme of ["light", "dark"] as const) {
      await page.goto("/sign-in");
      await setTheme(page, theme);

      const panel = page.locator(".prio-auth__brand");
      if ((await panel.count()) === 0) {
        test.skip(true, "no brand panel at this viewport");
      }

      const background = await panel.evaluate(
        (el) => getComputedStyle(el).backgroundColor,
      );
      expect(luminance(background)).toBeLessThan(0.25);
    }

    await context.close();
  });
});

test.describe("Theme persistence and system mode", () => {
  test("keeps the choice across a full page load", async ({ page }) => {
    await page.goto("/");

    const control = page.getByRole("button", { name: /^Theme: / });
    await control.click();
    await page.getByRole("menuitemradio", { name: "Dark" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    // The sidebar came back dark too — the pre-paint script covers it.
    const sidebar = await page
      .locator(".prio-sidebar")
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(luminance(sidebar)).toBeLessThan(0.3);

    await control.click();
    await page.getByRole("menuitemradio", { name: "System" }).click();
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.*/);
  });

  test("system mode follows the operating system", async ({ browser }) => {
    for (const scheme of ["light", "dark"] as const) {
      const context = await browser.newContext({ colorScheme: scheme });
      const page = await context.newPage();

      await page.goto("/");
      await expect(page.locator(".prio-sidebar")).toBeVisible();

      // No explicit choice stored: the media query decides.
      await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.*/);

      const sidebar = await page
        .locator(".prio-sidebar")
        .evaluate((el) => getComputedStyle(el).backgroundColor);

      if (scheme === "dark") {
        expect(luminance(sidebar)).toBeLessThan(0.3);
      } else {
        expect(luminance(sidebar)).toBeGreaterThan(0.7);
      }

      await context.close();
    }
  });

  test("an explicit light choice wins on a dark machine", async ({
    browser,
  }) => {
    const context = await browser.newContext({ colorScheme: "dark" });
    const page = await context.newPage();

    await page.goto("/");
    await page.getByRole("button", { name: /^Theme: / }).click();
    await page.getByRole("menuitemradio", { name: "Light" }).click();

    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    const sidebar = await page
      .locator(".prio-sidebar")
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(luminance(sidebar)).toBeGreaterThan(0.7);

    await context.close();
  });
});

test.describe("Mobile navigation", () => {
  test.use({ storageState: MEMBER_STATE });

  test("the drawer follows the theme and does not overflow", async ({
    page,
  }) => {
    await page.goto("/");
    await setViewport(page, 390, 844);

    for (const theme of ["light", "dark"] as const) {
      await setTheme(page, theme);

      await page.getByRole("button", { name: "Open navigation" }).click();
      const sidebar = page.locator(".prio-sidebar");
      await expect(sidebar).toBeVisible();

      const background = await sidebar.evaluate(
        (el) => getComputedStyle(el).backgroundColor,
      );
      if (theme === "light") {
        expect(luminance(background)).toBeGreaterThan(0.7);
      } else {
        expect(luminance(background)).toBeLessThan(0.3);
      }

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow, `overflow at 390px in ${theme}`).toBeLessThanOrEqual(1);

      await page.keyboard.press("Escape");
    }
  });
});

test.describe("Search shortcut", () => {
  test("Ctrl+K puts the caret in search from anywhere on the page", async ({
    page,
  }) => {
    await page.goto("/");

    const search = page.getByRole("searchbox", {
      name: "Search issues, bugs and projects",
    });
    await expect(search).not.toBeFocused();

    // Pressed with the body focused, which is the point of the shortcut.
    await page.locator("body").click({ position: { x: 5, y: 400 } });
    await page.keyboard.press("Control+k");

    await expect(search).toBeFocused();

    await page.keyboard.type("session");
    await page.keyboard.press("Enter");

    await expect(page).toHaveURL(/\/search\?q=session/);
  });

  test("shows the shortcut on the field and hides it while typing", async ({
    page,
  }) => {
    await page.goto("/");

    const hint = page.locator(".prio-search__kbd");
    await expect(hint).toContainText(/K/);

    const before = await hint.evaluate((el) => getComputedStyle(el).opacity);
    expect(Number(before)).toBeGreaterThan(0.5);

    await page
      .getByRole("searchbox", { name: "Search issues, bugs and projects" })
      .focus();

    await expect
      .poll(async () => hint.evaluate((el) => Number(getComputedStyle(el).opacity)))
      .toBeLessThan(0.5);
  });

  test("does not steal the key while someone is writing a comment", async ({
    page,
  }) => {
    await page.goto("/issues/eng-1");

    const field = page.getByPlaceholder("Write a comment…");
    await field.click();
    await field.type("looks ok");

    // Ctrl+K inside a text field still belongs to the field's own editing.
    await page.keyboard.press("Control+k");

    // The composer keeps focus and its content; search is not summoned.
    await expect(field).toBeFocused();
    await expect(field).toHaveValue(/looks ok/);
  });
});
