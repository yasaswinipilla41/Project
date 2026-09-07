import { expect, test, type Page } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, MEMBER_EMAIL, MEMBER_PASSWORD } from "./support";

/**
 * The two final requirements, checked in the browser rather than in the source.
 *
 *   - Light is what Prio opens in when nobody has chosen a theme — including
 *     straight after an Admin or a Team Member signs in;
 *   - Reject / Not an Issue is yellow, Cancelled is still grey, and the nine
 *     statuses are nine distinguishable colours in both themes.
 *
 * Every theme case starts from a context with no storage at all, because "no
 * saved preference" is precisely the state under test — reusing the suite's
 * signed-in state would carry a preference in with it and prove nothing.
 */

const STATUS_HEX: Record<string, string> = {
  BACKLOG: "#506078",
  TODO: "#609ffa",
  IN_PROGRESS: "#f0961f",
  IN_REVIEW: "#8b5cf6",
  IN_QA: "#0d9488",
  DONE: "#0f8b5f",
  REOPENED: "#e5484d",
  CANCELLED: "#94a3bb",
};

function rgbToHex(rgb: string): string {
  const [r, g, b] = rgb.match(/\d+/g)!.slice(0, 3).map(Number);
  return `#${[r, g, b].map((n) => n!.toString(16).padStart(2, "0")).join("")}`;
}

/** Perceptual distance between two colours, so "distinguishable" is measured. */
function distance(a: string, b: string): number {
  const parse = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [r1, g1, b1] = parse(a);
  const [r2, g2, b2] = parse(b);
  return Math.sqrt(
    2 * (r1! - r2!) ** 2 + 4 * (g1! - g2!) ** 2 + 3 * (b1! - b2!) ** 2,
  );
}

/** The resolved value of a status token, read from the live document. */
async function token(page: Page, name: string): Promise<string> {
  return rgbToHex(
    await page.evaluate((n) => {
      const probe = document.createElement("span");
      probe.style.color = `var(${n})`;
      document.body.appendChild(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value;
    }, name),
  );
}

/* ------------------------------------------------------------------ theme */

test.describe("Light is the default", () => {
  // No stored preference, and no signed-in session carried in.
  test.use({ storageState: { cookies: [], origins: [] } });

  for (const scheme of ["light", "dark"] as const) {
    test(`sign-in opens in Light on a ${scheme} machine`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto("/sign-in");
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    });
  }

  for (const [role, email, password] of [
    ["Admin", ADMIN_EMAIL, ADMIN_PASSWORD],
    ["Team Member", MEMBER_EMAIL, MEMBER_PASSWORD],
  ] as const) {
    test(`${role} signing in lands on a Light dashboard`, async ({ page }) => {
      // A dark machine, so following the OS would be visible if it happened.
      await page.emulateMedia({ colorScheme: "dark" });

      for (let attempt = 0; attempt < 4; attempt += 1) {
        await page.goto("/sign-in");
        await page.getByLabel("Work email").fill(email);
        await page.getByLabel("Password", { exact: true }).fill(password);
        await page.getByRole("button", { name: /sign in to prio/i }).click();
        try {
          await expect(page.locator(".prio-sidebar")).toBeVisible({
            timeout: 8_000,
          });
          break;
        } catch {
          // better-auth throttles sign-in; wait the window out and retry.
          await page.waitForTimeout(11_000);
        }
      }

      await expect(page.locator(".prio-sidebar")).toBeVisible();
      // The login redirect did not force dark, and did not follow the machine.
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

      const background = await page
        .locator("body")
        .evaluate((el) => getComputedStyle(el).backgroundColor);
      const rgb = background.match(/\d+/g)!.map(Number);
      expect((rgb[0]! + rgb[1]! + rgb[2]!) / 3).toBeGreaterThan(128);

      // Dark is still there, still works, and still persists across a reload.
      await page.getByRole("button", { name: /^Theme: / }).click();
      await page.getByRole("menuitemradio", { name: "Dark" }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

      // …and back to Light, which also persists.
      await page.getByRole("button", { name: /^Theme: / }).click();
      await page.getByRole("menuitemradio", { name: "Light" }).click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    });
  }
});

/* --------------------------------------------------------- status colours */

test.describe("The nine status colours", () => {
  for (const theme of ["light", "dark"] as const) {
    test(`are nine distinguishable colours in ${theme} mode`, async ({ page }) => {
      await page.goto("/projects/eng/summary");
      await page.evaluate((t) => {
        document.documentElement.setAttribute("data-theme", t);
      }, theme);

      const dots: Record<string, string> = {};
      for (const status of [...Object.keys(STATUS_HEX), "REJECTED"]) {
        const name =
          status === "IN_PROGRESS"
            ? "progress"
            : status === "IN_REVIEW"
              ? "review"
              : status === "IN_QA"
                ? "qa"
                : status.toLowerCase();
        dots[status] = await token(page, `--prio-status-${name}-dot`);
      }

      // Reject is not Cancelled's grey any more, and Cancelled still is grey.
      expect(dots.REJECTED).not.toBe(dots.CANCELLED);
      if (theme === "light") {
        // The eight unchanged statuses keep exactly the values they had.
        for (const [status, hex] of Object.entries(STATUS_HEX)) {
          expect(dots[status], `${status} is unchanged`).toBe(hex);
        }
        // Yellow: more yellow than the In Progress orange, and clearly not it.
        expect(dots.REJECTED).toBe("#d4b106");
      }

      // Nine marks, and no two of them close enough to be confused.
      const entries = Object.entries(dots);
      expect(entries.length).toBe(9);
      for (let i = 0; i < entries.length; i += 1) {
        for (let j = i + 1; j < entries.length; j += 1) {
          const [a, ca] = entries[i]!;
          const [b, cb] = entries[j]!;
          expect(
            distance(ca, cb),
            `${a} (${ca}) vs ${b} (${cb}) must be distinguishable`,
          ).toBeGreaterThan(60);
        }
      }

      // The label stays readable on its own tint.
      const fg = await token(page, "--prio-status-rejected-fg");
      const bg = await token(page, "--prio-status-rejected-bg");
      expect(distance(fg, bg)).toBeGreaterThan(150);
    });
  }

  test("the legend swatch and the ring segment are the same colour", async ({
    page,
  }) => {
    await page.goto("/projects/eng/summary");
    const rows = page.locator(".prio-donut__legenditem");
    await expect(rows.first()).toBeVisible();

    for (let i = 0; i < (await rows.count()); i += 1) {
      const row = rows.nth(i);
      const status = (await row.getAttribute("data-status"))!;
      const swatch = rgbToHex(
        await row
          .locator(".prio-donut__swatch")
          .evaluate((el) => getComputedStyle(el).backgroundColor),
      );
      const segment = rgbToHex(
        await page
          .locator(`.prio-donut__seg[data-status="${status}"]`)
          .evaluate((el) => getComputedStyle(el).stroke),
      );
      expect(swatch, `${status}: swatch matches its ring segment`).toBe(segment);
    }
  });

  test("a rejected issue's pill carries the yellow, in both themes", async ({
    page,
  }) => {
    /* The Summary's status distribution lists every status, whatever its
       count, so the pill is here to look at even when nothing is rejected. */
    await page.goto("/projects/eng/summary");
    const pill = page.locator('.prio-status[data-status="REJECTED"]').first();
    await expect(pill).toBeVisible();

    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((t) => {
        document.documentElement.setAttribute("data-theme", t);
      }, theme);
      const background = rgbToHex(
        await pill.evaluate((el) => getComputedStyle(el).backgroundColor),
      );
      const cancelled = await token(page, "--prio-status-cancelled-bg");
      expect(background, `${theme}: not Cancelled's grey`).not.toBe(cancelled);
      expect(background).toBe(await token(page, "--prio-status-rejected-bg"));
    }
  });
});
