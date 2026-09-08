import path from "node:path";
import { expect, type Page } from "@playwright/test";

/** Stored sessions, written once by auth.setup.ts and reused by every spec. */
export const ADMIN_STATE = path.join("test-results", ".auth", "admin.json");
export const MEMBER_STATE = path.join("test-results", ".auth", "member.json");

/** Credentials come from the environment so nothing is hard-coded in source. */
export const ADMIN_EMAIL =
  process.env.SEED_ADMIN_EMAIL ?? "admin@symbiosystech.com";
export const ADMIN_PASSWORD =
  process.env.SEED_ADMIN_PASSWORD ?? "Prio@12345";
export const MEMBER_EMAIL = "priya.nair@symbiosystech.com";
export const MEMBER_PASSWORD =
  process.env.SEED_DEFAULT_PASSWORD ?? "Prio@12345";

/**
 * Signs in through the real form and waits for the app shell.
 *
 * better-auth throttles sign-in to 3 attempts per 10 seconds in production —
 * genuine brute-force protection, which a suite that signs in repeatedly will
 * trip. Retrying after the window keeps the tests honest about that behaviour
 * instead of disabling it.
 */
export async function signIn(
  page: Page,
  email: string = ADMIN_EMAIL,
  password: string = ADMIN_PASSWORD,
): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.goto("/sign-in");
    await page.getByLabel("Work email").fill(email);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: /sign in to prio/i }).click();

    try {
      await expect(page.locator(".prio-sidebar")).toBeVisible({ timeout: 8_000 });
      return;
    } catch {
      // Wait out the rate-limit window and try again.
      await page.waitForTimeout(11_000);
    }
  }

  await expect(page.locator(".prio-sidebar")).toBeVisible({ timeout: 15_000 });
}

/**
 * Changes the viewport and waits for the shell's width/margin transitions to
 * settle. Measuring immediately after a resize reads mid-animation geometry.
 */
export async function setViewport(
  page: Page,
  width: number,
  height: number,
): Promise<void> {
  await page.setViewportSize({ width, height });
  await page.waitForFunction(
    () => {
      /* `.prio-main` is the region the sidebar's width pushes around, so it is
         what actually animates — and unlike the create control, which a
         developer is not offered, it is on the page for everybody. A probe
         that some accounts do not have is a probe that hangs for them. */
      const el = document.querySelector(".prio-main") as HTMLElement | null;
      if (!el) return false;
      const w = el.getBoundingClientRect().width;
      // Two consecutive frames with the same width means nothing is animating.
      const previous = (window as unknown as { __prioW?: number }).__prioW;
      (window as unknown as { __prioW?: number }).__prioW = w;
      return previous !== undefined && Math.abs(previous - w) < 0.5;
    },
    undefined,
    { timeout: 5_000, polling: 100 },
  );
}

/**
 * Collects console errors and failed requests for a page.
 *
 * Next.js dev/prod both emit some benign noise; only genuine errors and
 * non-2xx/3xx responses are recorded.
 */
export function watchForProblems(page: Page) {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });

  page.on("pageerror", (error) => {
    consoleErrors.push(`pageerror: ${error.message}`);
  });

  page.on("response", (response) => {
    const status = response.status();
    if (status >= 400) {
      failedRequests.push(`${status} ${response.request().method()} ${response.url()}`);
    }
  });

  return { consoleErrors, failedRequests };
}

/**
 * Waits for a real paint frame in the page.
 *
 * A canvas that just became interactive (a `hidden` attribute just cleared,
 * a tool switch just committed) can have a brief window before its layout
 * has actually settled — a real user's mouse always takes at least this long
 * to travel to it, but a script's very next synthetic pointer event can land
 * inside that window. Await this before measuring a bounding box or starting
 * a drag on anything that just changed.
 */
export async function waitForNextFrame(page: Page): Promise<void> {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
}
