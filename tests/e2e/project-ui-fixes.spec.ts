import { expect, test, type Page } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { MEMBER_STATE } from "./support";

/**
 * Four small, separate fixes, each verified where it shows.
 *
 *   - the calendar's day composer opens upwards when there is no room below;
 *   - a project's Activity tab no longer offers a Project filter it cannot act
 *     on;
 *   - Clone Project sits in the project's own actions menu, and is available to
 *     a member of the project rather than to administrators alone;
 *   - the comment toolbar says what the caret is actually sitting in.
 */

const createdProjects: string[] = [];

test.afterAll(async () => {
  if (createdProjects.length > 0) {
    await prisma.project.deleteMany({ where: { id: { in: createdProjects } } });
  }
});

/* ------------------------------------------------------------- calendar */

test.describe("The calendar's day composer", () => {
  test("opens below when there is room, and above when there is not", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/projects/eng/calendar");
    await page.waitForSelector(".prio-calendar");

    const days = page.locator(".prio-calendar__cell:not([data-empty])");
    const composer = page.locator(".prio-calendar__composer");

    /**
     * Opens a day's composer with that day deliberately placed in the window.
     *
     * The side is decided by the room actually below the day, so a test that
     * merely picked "an early day" would be at the mercy of where scrolling
     * left it — which is how this test first failed. The day is scrolled to a
     * known position instead, and the assertion is about what the panel does
     * with the space it is given.
     */
    async function openWithDayAt(index: number, where: "top" | "bottom") {
      const cell = days.nth(index);
      await cell.evaluate((el, position) => {
        el.scrollIntoView({ block: position === "top" ? "start" : "end" });
      }, where);
      await page.waitForTimeout(100);

      await cell.hover();
      await cell.locator(".prio-calendar__add").click();
      await expect(composer).toBeVisible();

      return {
        box: (await composer.boundingBox())!,
        place: await composer.getAttribute("data-place"),
        viewport: page.viewportSize()!,
      };
    }

    // A day sitting at the top of the window has room beneath it.
    const roomBelow = await openWithDayAt(0, "top");
    expect(roomBelow.place).toBe("below");
    await page.keyboard.press("Escape");
    await expect(composer).toBeHidden();

    // The same control on a day at the foot of the window opens upwards.
    const noRoomBelow = await openWithDayAt((await days.count()) - 1, "bottom");
    expect(noRoomBelow.place).toBe("above");

    /* Whichever way it opened, the whole panel is on screen: not off the
       bottom, not off the top, and not off either side. */
    for (const { box, viewport } of [roomBelow, noRoomBelow]) {
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    }

    await page.keyboard.press("Escape");
  });

  test("stays on screen at a smaller window too", async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 600 });
    await page.goto("/projects/eng/calendar");
    await page.waitForSelector(".prio-calendar");

    const days = page.locator(".prio-calendar__cell:not([data-empty])");
    const composer = page.locator(".prio-calendar__composer");

    /* Every day in the month, at a window short enough that most of them have
       no room below — the panel has to be fully visible on all of them. */
    const total = await days.count();
    for (const index of [0, Math.floor(total / 2), total - 1]) {
      const cell = days.nth(index);
      await cell.scrollIntoViewIfNeeded();
      await cell.hover();
      await cell.locator(".prio-calendar__add").click();
      await expect(composer).toBeVisible();

      const box = (await composer.boundingBox())!;
      const viewport = page.viewportSize()!;
      expect(box.y, `day ${index} runs off the top`).toBeGreaterThanOrEqual(0);
      expect(
        box.y + box.height,
        `day ${index} runs off the bottom`,
      ).toBeLessThanOrEqual(viewport.height);

      await page.keyboard.press("Escape");
      await expect(composer).toBeHidden();
    }
  });
});

/* ------------------------------------------------------------- activity */

test.describe("A project's Activity tab", () => {
  test("has no Project dropdown, and keeps its other filters", async ({
    page,
  }) => {
    await page.goto("/projects/eng/activity");
    const chips = page.locator(".prio-filters__chips");
    await expect(chips).toBeVisible();

    await expect(
      chips.getByRole("button", { name: "Project", exact: true }),
    ).toHaveCount(0);

    for (const label of ["User", "Type"]) {
      await expect(
        chips.getByRole("button", { name: label, exact: true }),
        `${label} must still be offered`,
      ).toBeVisible();
    }

    // The feed itself still loads, and search is untouched.
    await expect(page.getByLabel(/search/i).first()).toBeVisible();
    await expect(page.locator(".prio-activity").first()).toBeVisible();
  });

  test("still offers the Project dropdown on the global Activity feed", async ({
    page,
  }) => {
    await page.goto("/activity");
    await expect(
      page
        .locator(".prio-filters__chips")
        .getByRole("button", { name: "Project", exact: true }),
    ).toBeVisible();
  });
});

/* ---------------------------------------------------------------- clone */

/** Opens the project's own actions menu, beside Settings. */
async function openProjectMenu(page: Page, key: string) {
  await page.goto(`/projects/${key.toLowerCase()}`);
  await page.getByRole("button", { name: "More project actions" }).click();
  const menu = page.getByRole("menu").first();
  await menu.waitFor();
  return menu;
}

test.describe("Clone Project in the project's actions menu", () => {
  test("is offered alongside the existing actions, for an administrator", async ({
    page,
  }) => {
    const menu = await openProjectMenu(page, "ENG");
    const items = (await menu.getByRole("menuitem").allInnerTexts()).map((t) =>
      t.replace(/\s+/g, " ").trim(),
    );

    expect(items).toContain("Clone project");
    // The menu it was added to keeps everything it had.
    expect(items).toContain("Edit project");
    expect(items).toContain("Delete project");
  });

  test("clones through the existing dialog and opens the copy", async ({
    page,
  }) => {
    const before = await prisma.project.count();

    const menu = await openProjectMenu(page, "WEB");
    await menu.getByRole("menuitem", { name: "Clone project" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Clone", exact: true }).click();

    // Lands on the copy's own board, as the clone flow already did.
    await page.waitForURL(/\/projects\/[^/]+\/board$/, { timeout: 60_000 });
    const key = /\/projects\/([^/]+)\/board$/.exec(page.url())![1]!.toUpperCase();
    expect(key).not.toBe("WEB");

    const clone = await prisma.project.findUniqueOrThrow({
      where: { key },
      select: { id: true, name: true },
    });
    createdProjects.push(clone.id);

    expect(await prisma.project.count()).toBe(before + 1);
    // The original is untouched.
    await expect
      .poll(async () =>
        prisma.project.count({ where: { key: "WEB", name: "Website" } }),
      )
      .toBe(1);
  });
});

test.describe("Clone Project as a member", () => {
  test.use({ storageState: MEMBER_STATE });

  test("a member of the project is offered it, and keeps their other access", async ({
    page,
  }) => {
    /* The correction this covers: a member is not a clone-only user. They see
       Clone because they can open the project, and everything else their role
       already allowed is still there. */
    const menu = await openProjectMenu(page, "ENG");
    const items = (await menu.getByRole("menuitem").allInnerTexts()).map((t) =>
      t.replace(/\s+/g, " ").trim(),
    );
    expect(items).toContain("Clone project");

    /* Not promoted: renaming and deleting a project stay with an administrator
       or its creator, so a plain member is not offered them. */
    expect(items).not.toContain("Delete project");

    await page.keyboard.press("Escape");

    // And their ordinary access is intact — they can still open and comment.
    await page.goto("/issues/eng-1");
    await expect(
      page.locator(".prio-conversation__composer .prio-composer"),
    ).toBeVisible();
  });
});

/* -------------------------------------------------------- editor toolbar */

test.describe("The comment toolbar", () => {
  test("reflects the formatting the caret is actually in", async ({ page }) => {
    await page.goto("/issues/eng-1");
    const composer = page.locator(".prio-conversation__composer .prio-composer");
    await expect(composer).toBeVisible();

    const editor = composer.locator('[contenteditable="true"]');
    const button = (name: string) =>
      composer.getByRole("button", { name, exact: true });

    await editor.click();
    // Nothing typed: nothing is active.
    await expect(button("Bold")).toHaveAttribute("aria-pressed", "false");

    // Turned on, and the button says so while the text is being typed.
    await button("Bold").click();
    await page.keyboard.type("bold words");
    await expect(button("Bold")).toHaveAttribute("aria-pressed", "true");

    // Turned off again, and it follows.
    await button("Bold").click();
    await page.keyboard.type(" plain");
    await expect(button("Bold")).toHaveAttribute("aria-pressed", "false");

    /* The case a hand-maintained state gets wrong: nothing was pressed, the
       caret simply moved back into text that is already bold. */
    for (let i = 0; i < 8; i += 1) await page.keyboard.press("ArrowLeft");
    await expect(button("Bold")).toHaveAttribute("aria-pressed", "true");
    await expect(button("Italic")).toHaveAttribute("aria-pressed", "false");

    // A block format reads from the document too.
    await button("Bulleted list").click();
    await expect(button("Bulleted list")).toHaveAttribute("aria-pressed", "true");
  });
});
