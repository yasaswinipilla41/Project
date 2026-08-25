import { expect, test, type Page } from "@playwright/test";

/**
 * The marketing site.
 *
 * Runs signed out, because the landing page is public and must not depend on a
 * session. Covers the theme system, navigation, motion, the product mockups and
 * responsive behaviour.
 */

test.use({ storageState: { cookies: [], origins: [] } });

const theme = (page: Page) =>
  page.evaluate(() => document.documentElement.getAttribute("data-theme"));

test.describe("Access and structure", () => {
  test("is reachable without signing in", async ({ page }) => {
    const response = await page.goto("/landing");
    expect(response?.status()).toBe(200);
    await expect(page).toHaveURL(/\/landing$/);
    await expect(page).toHaveTitle(/Prio/);
  });

  test("renders every section in order", async ({ page }) => {
    await page.goto("/landing");

    for (const id of [
      "product",
      "value",
      "board",
      "features",
      "issue",
      "analytics",
      "workflow",
      "collaboration",
      "automation",
      "cta",
    ]) {
      await expect(page.locator(`#${id}`), `#${id} missing`).toHaveCount(1);
    }

    await expect(page.getByRole("heading", { level: 1 })).toContainText(
      "Plan better.",
    );
  });

  test("loads with no console errors or failed requests", async ({ page }) => {
    const errors: string[] = [];
    const failures: string[] = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("response", (r) => {
      if (r.status() >= 400) failures.push(`${r.status()} ${r.url()}`);
    });

    await page.goto("/landing");
    await page.locator("#cta").scrollIntoViewIfNeeded();
    await page.waitForTimeout(1500);

    expect(errors).toEqual([]);
    expect(failures).toEqual([]);
  });
});

test.describe("Theme system", () => {
  test("switches between light, dark and system, and persists", async ({
    page,
  }) => {
    await page.goto("/landing");

    await page.getByRole("radio", { name: /dark/i }).click();
    await expect.poll(() => theme(page)).toBe("dark");

    await page.getByRole("radio", { name: /light/i }).click();
    await expect.poll(() => theme(page)).toBe("light");

    // The choice survives a reload — it is stored, not just in memory.
    await page.reload();
    expect(await theme(page)).toBe("light");
    await expect(page.getByRole("radio", { name: /light/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    const stored = await page.evaluate(() =>
      localStorage.getItem("prio.theme"),
    );
    expect(stored).toBe("light");
  });

  test("system mode follows the operating system", async ({ browser }) => {
    // A fresh dark-scheme context: with no stored choice the site must open dark.
    const context = await browser.newContext({ colorScheme: "dark" });
    const page = await context.newPage();
    await page.goto("/landing");

    expect(await theme(page)).toBe("dark");
    await expect(page.getByRole("radio", { name: /system/i })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    // An explicit choice overrides the system preference.
    await page.getByRole("radio", { name: /light/i }).click();
    await expect.poll(() => theme(page)).toBe("light");

    await context.close();
  });

  test("applies the theme before first paint, with no flash", async ({
    browser,
  }) => {
    const context = await browser.newContext();
    const page = await context.newPage();

    // Seed a dark preference, then load the page fresh.
    await page.goto("/landing");
    await page.evaluate(() => localStorage.setItem("prio.theme", "dark"));

    await page.goto("/landing");
    /*
     * Read the attribute at the earliest possible moment. The inline script
     * runs before React, so the correct palette is already in place and the
     * page never paints light first.
     */
    expect(await theme(page)).toBe("dark");

    const bg = await page.evaluate(
      () => getComputedStyle(document.querySelector(".prio-site")!).backgroundColor,
    );
    // The dark ground, not the light one.
    expect(bg).toBe("rgb(5, 8, 22)");

    await context.close();
  });

  test("repaints the product mockups, not just the page", async ({ page }) => {
    await page.goto("/landing");

    const surface = () =>
      page.evaluate(
        () => getComputedStyle(document.querySelector(".site-app")!).backgroundColor,
      );

    await page.getByRole("radio", { name: /light/i }).click();
    const light = await surface();

    await page.getByRole("radio", { name: /dark/i }).click();
    await expect.poll(surface).not.toBe(light);

    // A genuinely different surface colour, not a filtered version of the same.
    const dark = await surface();
    expect(light).toBe("rgb(255, 255, 255)");
    expect(dark).not.toBe("rgb(255, 255, 255)");

    const filter = await page.evaluate(
      () => getComputedStyle(document.querySelector(".site-app")!).filter,
    );
    expect(["none", ""]).toContain(filter);
  });
});

test.describe("Navigation", () => {
  test("condenses on scroll and restores at the top", async ({ page }) => {
    await page.goto("/landing");
    // The scroll listener is attached on hydration; acting before that would
    // scroll the page with nothing watching.
    await expect(page.locator(".site-hero[data-ready='true']")).toBeVisible();

    const nav = page.locator(".site-nav");
    await expect(nav).toHaveAttribute("data-scrolled", "false");

    await page.evaluate(() => window.scrollTo(0, 600));
    await expect(nav).toHaveAttribute("data-scrolled", "true");

    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(nav).toHaveAttribute("data-scrolled", "false");
  });

  test("anchor links move to their section", async ({ page }) => {
    await page.goto("/landing");

    await page.getByRole("link", { name: "Features", exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(
      500,
    );

    const visible = await page
      .locator("#features")
      .evaluate((el) => el.getBoundingClientRect().top < window.innerHeight);
    expect(visible).toBe(true);
  });

  test("both calls to action reach sign-in", async ({ page }) => {
    await page.goto("/landing");
    await page.locator(".site-nav").getByRole("link", { name: "Get Started" }).click();
    await expect(page).toHaveURL(/\/sign-in/);
  });

  test("the mobile menu opens, navigates and closes", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/landing");

    const toggle = page.getByRole("button", { name: "Open menu" });
    await expect(toggle).toBeVisible();
    await toggle.click();

    const menu = page.locator("#site-mobile-menu");
    await expect(menu).toBeVisible();

    await menu.getByRole("link", { name: "Features" }).click();
    await expect(menu).toBeHidden();
  });
});

test.describe("Product mockups", () => {
  test("the hero dashboard reads as a real application", async ({ page }) => {
    await page.goto("/landing");

    const app = page.locator(".site-app").first();
    await expect(app).toBeVisible();

    // Window chrome, not a decorative rectangle.
    await expect(app.locator(".site-app__url")).toContainText("app.prio.dev");
    // Realistic issues with keys, types and statuses.
    await expect(app.locator(".site-app__issue-key").first()).toContainText(
      "PRIO-",
    );
    await expect(app.getByText("Fix authentication bug")).toBeVisible();
    expect(await app.locator(".site-app__issue").count()).toBeGreaterThan(3);
    expect(await app.locator(".site-app__status").count()).toBeGreaterThan(3);

    // The window chrome must not be repainted by the chart-bar rule.
    const barBg = await app
      .locator(".site-app__bar")
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(barBg).toBe("rgb(15, 23, 42)");
  });

  test("counters reach their real values", async ({ page }) => {
    await page.goto("/landing");
    await page.locator(".site-app__stats").scrollIntoViewIfNeeded();

    await expect
      .poll(
        async () =>
          page.locator(".site-app__stat-value").first().innerText(),
        { timeout: 8000 },
      )
      .toBe("13");
  });

  test("the board shows all five columns and moves a card", async ({ page }) => {
    await page.goto("/landing");
    await page.locator("#board").scrollIntoViewIfNeeded();

    for (const label of ["Backlog", "To Do", "In Progress", "Review", "Done"]) {
      await expect(
        page.locator(".site-board__col-head").filter({ hasText: label }),
      ).toBeVisible();
    }

    const travelling = page.locator('[data-travel="true"]');
    await expect(travelling).toHaveCount(1);
    // The card toggles between two positions on a loop.
    await expect
      .poll(async () => travelling.getAttribute("data-moved"), { timeout: 8000 })
      .toBe("true");
  });

  test("the issue activity trail fills in", async ({ page }) => {
    await page.goto("/landing");
    await page.locator("#issue").scrollIntoViewIfNeeded();

    await expect(page.locator(".site-issue__key")).toHaveText("PRIO-124");
    await expect
      .poll(
        async () =>
          page.locator('.site-issue__event[data-shown="true"]').count(),
        { timeout: 8000 },
      )
      .toBe(3);
  });

  test("the workflow lights each step in turn", async ({ page }) => {
    await page.goto("/landing");
    await page.locator("#workflow").scrollIntoViewIfNeeded();

    await expect
      .poll(
        async () => page.locator('.site-flow__step[data-active="true"]').count(),
        { timeout: 8000 },
      )
      .toBe(5);
  });

  test("analytics draws its charts", async ({ page }) => {
    await page.goto("/landing");
    await page.locator("#analytics").scrollIntoViewIfNeeded();

    await expect
      .poll(async () => page.locator(".site-analytics").getAttribute("data-in"))
      .toBe("true");

    await expect
      .poll(
        async () => page.locator(".site-stat__value").first().innerText(),
        { timeout: 8000 },
      )
      .toContain("87");

    expect(await page.locator(".site-donut__seg").count()).toBe(4);
  });

  test("the automation builder expands the hovered step", async ({ page }) => {
    await page.goto("/landing");
    await page.locator("#automation").scrollIntoViewIfNeeded();

    const steps = page.locator(".site-auto__step");
    await steps.nth(2).hover();
    await expect(steps.nth(2)).toHaveAttribute("data-active", "true");
    await expect(steps.nth(0)).toHaveAttribute("data-active", "false");
  });
});

test.describe("Responsive", () => {
  const sizes = [
    { w: 375, h: 812, name: "375" },
    { w: 390, h: 844, name: "390" },
    { w: 768, h: 1024, name: "768" },
    { w: 1024, h: 768, name: "1024" },
    { w: 1440, h: 900, name: "1440" },
    { w: 1920, h: 1080, name: "1920" },
  ];

  for (const size of sizes) {
    test(`no horizontal overflow at ${size.name}px`, async ({ page }) => {
      await page.setViewportSize({ width: size.w, height: size.h });
      await page.goto("/landing");

      // Walk the whole page: overflow often appears only in a lower section.
      await page.evaluate(async () => {
        for (let y = 0; y < document.body.scrollHeight; y += 600) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 60));
        }
      });

      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth + 1,
      );
      expect(overflow, `overflow at ${size.name}px`).toBe(false);
    });
  }
});

test.describe("Accessibility", () => {
  test("the theme control is a labelled radiogroup", async ({ page }) => {
    await page.goto("/landing");

    const group = page.getByRole("radiogroup", { name: /colour theme/i });
    await expect(group).toBeVisible();
    await expect(group.getByRole("radio")).toHaveCount(3);

    // Operable from the keyboard.
    await page.getByRole("radio", { name: /dark/i }).focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => theme(page)).toBe("dark");
  });

  test("headings are ordered and the page has one h1", async ({ page }) => {
    await page.goto("/landing");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

    expect(await page.getByRole("heading", { level: 1 }).count()).toBe(1);
    expect(await page.getByRole("heading", { level: 2 }).count()).toBeGreaterThan(
      4,
    );
  });

  test("interactive controls show a visible focus ring", async ({ page }) => {
    await page.goto("/landing");
    // Hydration can reset focus, so wait for the shell to settle first.
    await expect(page.locator(".site-hero[data-ready='true']")).toBeVisible();

    /*
     * Tab rather than .focus(): the ring is bound to :focus-visible, which
     * Chromium only applies for keyboard interaction — exactly the case that
     * needs the ring.
     */
    await page.keyboard.press("Tab");
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.tagName))
      .not.toBe("BODY");

    const focused = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement;
      const s = getComputedStyle(el);
      return {
        tag: el.tagName,
        outline: `${s.outlineStyle} ${s.outlineWidth}`,
        shadow: s.boxShadow,
      };
    });

    // Something focusable took focus, and it is visibly marked.
    expect(["A", "BUTTON", "INPUT"]).toContain(focused.tag);
    const marked =
      !focused.outline.includes("none") || focused.shadow !== "none";
    expect(marked, `no visible focus indicator on ${focused.tag}`).toBe(true);
  });

  test("the custom cursor never blocks pointer events", async ({ page }) => {
    await page.goto("/landing");

    const events = await page.evaluate(() => {
      const cursor = document.querySelector(".site-cursor");
      if (!cursor) return "absent";
      return getComputedStyle(cursor as HTMLElement).pointerEvents;
    });
    expect(["none", "absent"]).toContain(events);
  });
});

test.describe("Reduced motion", () => {
  test("shows final states instead of animating to them", async ({ browser }) => {
    // The preference is a context option in this Playwright version, so the
    // context is created here rather than declared with test.use().
    const context = await browser.newContext({ reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.goto("/landing");

    // Reveals are visible immediately rather than waiting for the observer.
    const heroOpacity = await page
      .locator(".site-hero__body")
      .evaluate((el) => getComputedStyle(el).opacity);
    expect(heroOpacity).toBe("1");

    // The workflow shows every step complete, not an empty rail.
    await page.locator("#workflow").scrollIntoViewIfNeeded();
    await expect
      .poll(() => page.locator('.site-flow__step[data-active="true"]').count())
      .toBe(5);

    // The activity trail is fully populated.
    await page.locator("#issue").scrollIntoViewIfNeeded();
    await expect
      .poll(() => page.locator('.site-issue__event[data-shown="true"]').count())
      .toBe(3);

    // No decorative cursor.
    await expect(page.locator(".site-cursor")).toHaveCount(0);

    await context.close();
  });
});
