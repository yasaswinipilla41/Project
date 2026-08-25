import { expect, test } from "@playwright/test";
import { setViewport, watchForProblems } from "./support";

/**
 * Brand integration.
 *
 * The mark is one asset used on both light and dark grounds, and the wordmark
 * is live text whose colour comes from tokens. These tests pin that contract:
 * one implementation, correct tone per surface, no filters, no broken requests.
 */

test.describe("Brand assets", () => {
  test("every declared icon and the manifest resolve", async ({ request }) => {
    const assets = [
      ["/brand/prio-mark.svg", "image/svg+xml"],
      ["/favicon.ico", "image/x-icon"],
      ["/apple-touch-icon.png", "image/png"],
      ["/manifest.webmanifest", "application/manifest+json"],
      ["/brand/icon-192.png", "image/png"],
      ["/brand/icon-512.png", "image/png"],
    ] as const;

    for (const [url, type] of assets) {
      const response = await request.get(url);
      expect(response.status(), `${url} status`).toBe(200);
      expect(response.headers()["content-type"], `${url} type`).toContain(type);
      expect((await response.body()).length, `${url} size`).toBeGreaterThan(200);
    }
  });

  test("the master mark is true vector, not a wrapped raster", async ({
    request,
  }) => {
    const svg = await (await request.get("/brand/prio-mark.svg")).text();

    expect(svg).toContain("<svg");
    expect(svg).toContain("viewBox");
    // A raster wrapped in an <svg> element does not scale, which is the whole
    // point of shipping a vector.
    expect(svg).not.toContain("data:image/");
    expect(svg).not.toContain("<image");
    // Both brand hues are present in the geometry.
    expect(svg.toLowerCase()).toMatch(/#(3b82f6|4c8df8|3172f2|2563eb|2258e8)/);
    expect(svg.toLowerCase()).toMatch(/#(a855f7|7c3aed|c79cfb|a164f5)/);
    // No fixed width/height would fight the layout.
    expect(svg).not.toMatch(/<svg[^>]*\swidth="\d/);
  });

  test("the manifest declares maskable and any-purpose icons", async ({
    request,
  }) => {
    const manifest = await (await request.get("/manifest.webmanifest")).json();

    expect(manifest.name).toContain("Prio");
    expect(manifest.short_name).toBe("Prio");
    expect(manifest.theme_color).toBeTruthy();

    const purposes = manifest.icons.map((i: { purpose: string }) => i.purpose);
    expect(purposes).toContain("maskable");
    expect(purposes).toContain("any");
  });

  test("the document head links the icon set", async ({ page }) => {
    /*
     * Any route works: the icons come from the root layout. Deliberately not
     * /sign-in — this spec runs with a session, which redirects that route to
     * the shell and leaves the assertions racing the navigation.
     */
    await page.goto("/");
    await expect(page.locator(".prio-sidebar")).toBeVisible();

    const icons = await page.evaluate(() =>
      Array.from(document.querySelectorAll('link[rel*="icon"]')).map((l) => ({
        rel: l.getAttribute("rel"),
        href: l.getAttribute("href"),
      })),
    );

    expect(icons.some((i) => i.href?.includes("prio-mark.svg"))).toBe(true);
    expect(icons.some((i) => i.href?.includes("favicon.ico"))).toBe(true);
    expect(icons.some((i) => i.rel?.includes("apple-touch-icon"))).toBe(true);

    const manifest = await page
      .locator('link[rel="manifest"]')
      .getAttribute("href");
    expect(manifest).toBe("/manifest.webmanifest");

    await expect(page).toHaveTitle(/Prio/);
  });
});

test.describe("Logo rendering on the sign-in page", () => {
  // Signed out: an authenticated session redirects /sign-in away to the shell.
  test.use({ storageState: { cookies: [], origins: [] } });

  test("shows the lockup on both grounds", async ({ page }) => {
    const { consoleErrors, failedRequests } = watchForProblems(page);
    await page.goto("/sign-in");

    const lockups = page.locator(".prio-logo--lockup");
    // One on the dark brand panel, one on the light form panel.
    await expect(lockups).toHaveCount(2);

    const tones = await page
      .locator(".prio-wordmark")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-tone")));
    expect(tones).toContain("dark");
    expect(tones).toContain("light");

    // The wordmark colour comes from the token, and differs per ground.
    const colours = await page
      .locator(".prio-wordmark")
      .evaluateAll((els) => els.map((e) => getComputedStyle(e).color));
    expect(new Set(colours).size).toBe(2);

    // The purple dot survives on both.
    const dots = await page
      .locator(".prio-wordmark__dot")
      .evaluateAll((els) => els.map((e) => getComputedStyle(e).backgroundColor));
    expect(dots.length).toBe(2);
    for (const dot of dots) expect(dot).not.toBe("rgba(0, 0, 0, 0)");

    expect(consoleErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
  });

  test("scales without clipping or overflow at every breakpoint", async ({
    page,
  }) => {
    for (const [width, height, label] of [
      [1440, 900, "desktop"],
      [1024, 768, "laptop"],
      [768, 1024, "tablet"],
      [390, 844, "mobile"],
    ] as const) {
      await page.goto("/sign-in");
      await page.setViewportSize({ width, height });

      /*
       * Below 900px the dark brand panel is hidden and the form panel shows its
       * own lockup, so assert that *a* logo is visible rather than a particular
       * one — both are in the DOM at every width.
       */
      const visibleCount = await page
        .locator(".prio-logo__mark")
        .evaluateAll(
          (els) => els.filter((e) => (e as HTMLElement).offsetParent !== null).length,
        );
      expect(visibleCount, `no visible logo at ${label}`).toBeGreaterThan(0);

      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth >
          document.documentElement.clientWidth + 1,
      );
      expect(overflow, `overflow at ${label}`).toBe(false);

      await page.screenshot({
        path: `test-results/brand-signin-${label}.png`,
      });
    }
  });

  test("the mark is never recoloured with a CSS filter", async ({ page }) => {
    await page.goto("/sign-in");
    await expect(page.locator(".prio-logo__mark").first()).toBeVisible();

    const filters = await page
      .locator(".prio-logo__mark")
      .evaluateAll((els) => els.map((e) => getComputedStyle(e).filter));

    // A single asset works on both grounds; inverting it would break the
    // gradient the brand depends on.
    for (const filter of filters) {
      expect(["none", ""]).toContain(filter);
    }
  });

});

test.describe("Logo rendering in the app shell", () => {
  test("the mark keeps its aspect ratio wherever it appears", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator(".prio-sidebar")).toBeVisible();

    const marks = await page.locator(".prio-logo__mark").evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        return { w: r.width, h: r.height };
      }),
    );

    expect(marks.length).toBeGreaterThan(0);
    for (const mark of marks) {
      expect(mark.w).toBeGreaterThan(0);
      // The mark is square; any drift means flex has stretched it.
      expect(Math.abs(mark.w - mark.h)).toBeLessThan(1);
    }
  });

  test("the sidebar swaps lockup for mark when collapsed", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".prio-sidebar")).toBeVisible();

    const brand = page.locator(".prio-sidebar__brand");
    await expect(brand.locator(".prio-wordmark")).toBeVisible();

    await page.getByRole("button", { name: "Collapse sidebar" }).click();

    // Collapsed: mark only, no wordmark, and it must still fit the rail.
    await expect(brand.locator(".prio-wordmark")).toHaveCount(0);
    const mark = brand.locator(".prio-logo__mark");
    await expect(mark).toBeVisible();

    const fits = await page.evaluate(() => {
      const rail = document.querySelector(".prio-sidebar")!.getBoundingClientRect();
      const img = document
        .querySelector(".prio-sidebar__brand .prio-logo__mark")!
        .getBoundingClientRect();
      return img.left >= rail.left && img.right <= rail.right;
    });
    expect(fits).toBe(true);

    await page.getByRole("button", { name: "Expand sidebar" }).click();
    await expect(brand.locator(".prio-wordmark")).toBeVisible();
  });

  test("the logo links home with an accessible name, announced once", async ({
    page,
  }) => {
    await page.goto("/");

    const link = page.locator(".prio-sidebar__brand a");
    await expect(link).toHaveAttribute("aria-label", "Prio home");
    await expect(link).toHaveAttribute("href", "/");

    // The mark is decorative inside a named link, so its alt is empty and the
    // product name is not repeated to a screen reader.
    const alt = await link.locator("img").getAttribute("alt");
    expect(alt).toBe("");

    await link.click();
    await expect(page).toHaveURL(/localhost:3000\/$/);
  });

  test("there is exactly one logo implementation", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".prio-sidebar")).toBeVisible();

    // Every rendered mark comes from PrioLogo, so all of them carry its class
    // and point at the single master asset.
    const images = await page
      .locator('img[src*="prio-mark"], img[src*="brand/"]')
      .evaluateAll((els) =>
        els.map((e) => ({
          src: e.getAttribute("src"),
          cls: e.getAttribute("class"),
        })),
      );

    expect(images.length).toBeGreaterThan(0);
    for (const image of images) {
      expect(image.src).toContain("prio-mark.svg");
      expect(image.cls).toContain("prio-logo__mark");
    }

    // No stray inline <svg> logo duplicating the mark.
    const inlineLogos = await page.locator("svg#prio-logo, svg.prio-logo").count();
    expect(inlineLogos).toBe(0);
  });
});

test.describe("Brand across surfaces and sizes", () => {
  const surfaces = [
    "/",
    "/projects",
    "/projects/eng",
    "/issues",
    "/bugs",
    "/reports",
  ];

  test("the sidebar mark renders on every main surface", async ({ page }) => {
    const { consoleErrors, failedRequests } = watchForProblems(page);

    for (const surface of surfaces) {
      await page.goto(surface);
      await expect(
        page.locator(".prio-sidebar__brand .prio-logo__mark"),
        `mark missing on ${surface}`,
      ).toBeVisible();
    }

    expect(consoleErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
  });

  test("the create dialog does not disturb the brand chrome", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator(".prio-sidebar")).toBeVisible();

    const before = await page
      .locator(".prio-sidebar__brand .prio-logo__mark")
      .boundingBox();

    await page.locator(".prio-create__main").click();
    await expect(page.getByRole("dialog")).toBeVisible();

    const during = await page
      .locator(".prio-sidebar__brand .prio-logo__mark")
      .boundingBox();

    expect(during?.x).toBeCloseTo(before!.x, 1);
    expect(during?.y).toBeCloseTo(before!.y, 1);
    expect(during?.width).toBeCloseTo(before!.width, 1);
  });

  test("the app shell keeps the brand intact on mobile", async ({ page }) => {
    await page.goto("/");
    await setViewport(page, 390, 844);

    // The sidebar is off-canvas on mobile; opening it must show the lockup.
    await page.getByRole("button", { name: "Open navigation" }).click();
    await expect(
      page.locator(".prio-sidebar__brand .prio-logo__mark"),
    ).toBeVisible();

    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth + 1,
    );
    expect(overflow).toBe(false);

    await page.screenshot({ path: "test-results/brand-mobile-nav.png" });
  });
});
