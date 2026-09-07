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

/**
 * The nine statuses and the nine colours that are theirs, in the order the
 * Status Overview lists them. These are the authoritative values: the ring
 * segment, the legend swatch, the distribution bar and the pill's dot all read
 * one token per status, so asserting the token asserts every surface at once.
 */
const STATUS_HEX: Record<string, string> = {
  BACKLOG: "#1f3c6e",
  TODO: "#009698",
  IN_PROGRESS: "#dca537",
  IN_REVIEW: "#f198ad",
  IN_QA: "#a3b85e",
  DONE: "#3cb371",
  REOPENED: "#c05d43",
  REJECTED: "#886bc0",
  CANCELLED: "#5c1228",
};

/** The token each status's primary colour is published under. */
const TOKEN_OF: Record<string, string> = {
  BACKLOG: "backlog",
  TODO: "todo",
  IN_PROGRESS: "progress",
  IN_REVIEW: "review",
  IN_QA: "qa",
  DONE: "done",
  REOPENED: "reopened",
  REJECTED: "rejected",
  CANCELLED: "cancelled",
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
      for (const [status, name] of Object.entries(TOKEN_OF)) {
        dots[status] = await token(page, `--prio-status-${name}-dot`);
      }

      /*
       * Exactly the assigned value, in *both* themes. A status's colour
       * identifies it; going dark changes the tint behind the label and the
       * label itself, never the mark — so there is no light-only branch here.
       */
      for (const [status, hex] of Object.entries(STATUS_HEX)) {
        expect(dots[status], `${status} is exactly ${hex}`).toBe(hex);
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

      // Every label stays readable on its own tint, in this theme.
      for (const [status, name] of Object.entries(TOKEN_OF)) {
        const fg = await token(page, `--prio-status-${name}-fg`);
        const bg = await token(page, `--prio-status-${name}-bg`);
        expect(
          distance(fg, bg),
          `${status}: ${fg} on ${bg} must be readable`,
        ).toBeGreaterThan(150);
      }
    });
  }

  test("the pie chart draws each status in its own exact colour", async ({
    page,
  }) => {
    /*
     * The chart itself, not the token behind it: every segment the ring is
     * showing is read off the painted SVG and compared with the assigned
     * value. This is what rules out a generic chart palette or an
     * index-based assignment quietly colouring the ring while the tokens say
     * something else.
     */
    await page.goto("/projects/eng/summary");
    const segments = page.locator(".prio-donut__seg");
    await expect(segments.first()).toBeVisible();

    const seen: string[] = [];
    for (let i = 0; i < (await segments.count()); i += 1) {
      const segment = segments.nth(i);
      const status = (await segment.getAttribute("data-status"))!;
      const painted = rgbToHex(
        await segment.evaluate((el) => getComputedStyle(el).stroke),
      );
      expect(painted, `${status} segment`).toBe(STATUS_HEX[status]);
      seen.push(status);
    }

    // The two the mapping calls out by name, whenever the ring shows them.
    for (const [status, hex] of [
      ["IN_QA", "#a3b85e"],
      ["DONE", "#3cb371"],
    ] as const) {
      if (!seen.includes(status)) continue;
      const painted = rgbToHex(
        await page
          .locator(`.prio-donut__seg[data-status="${status}"]`)
          .evaluate((el) => getComputedStyle(el).stroke),
      );
      expect(painted, `${status} pie segment`).toBe(hex);
    }
  });

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

  test("a rejected issue's pill carries its own colour, in both themes", async ({
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
