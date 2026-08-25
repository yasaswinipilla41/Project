import { expect, test, type Page } from "@playwright/test";
import { setViewport, watchForProblems } from "./support";

/**
 * The global "+ Create" split control (§9, §15).
 *
 * These assertions pin the exact geometry defect found earlier: the two halves
 * had full 7px radii on every corner and their own box-shadows, because the
 * rules sat at a specificity that lost to `.prio-btn` on source order.
 */

async function box(page: Page, selector: string) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return {
      x: r.x,
      y: r.y,
      w: r.width,
      h: r.height,
      right: r.right,
      bottom: r.bottom,
      radius: s.borderRadius,
      padding: s.padding,
      boxShadow: s.boxShadow,
      backgroundImage: s.backgroundImage,
    };
  }, selector);
}

test.describe("+ Create split button", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".prio-create")).toBeVisible();
  });

  test("renders as one unified control", async ({ page }) => {
    const main = await box(page, ".prio-create__main");
    const caret = await box(page, ".prio-create__caret");
    const wrap = await box(page, ".prio-create");

    // Same height, same vertical position — no misalignment.
    expect(caret.h).toBe(main.h);
    expect(caret.y).toBeCloseTo(main.y, 1);
    expect(caret.bottom).toBeCloseTo(main.bottom, 1);

    // Flush: no gap and no overlap between the halves. Compared with a
    // sub-pixel tolerance because layout at fractional widths lands on
    // fractional CSS pixels, which cannot render as a visible seam.
    expect(Math.abs(caret.x - main.right)).toBeLessThan(0.5);

    // The wrapper is exactly the two halves wide — no stray margin.
    expect(wrap.w).toBeCloseTo(main.w + caret.w, 1);

    // Outer corners rounded, inner corners square.
    expect(main.radius).toBe("7px 0px 0px 7px");
    expect(caret.radius).toBe("0px 7px 7px 0px");

    // One gradient on the wrapper; the halves are transparent so the sweep is
    // continuous rather than restarting on the caret.
    expect(wrap.backgroundImage).toContain("linear-gradient");
    expect(main.backgroundImage).toBe("none");
    expect(caret.backgroundImage).toBe("none");

    // A single shadow, cast by the wrapper only.
    expect(main.boxShadow).toBe("none");
    expect(caret.boxShadow).toBe("none");
    expect(wrap.boxShadow).not.toBe("none");

    // The caret is icon-only: inherited side padding would leave no content box.
    expect(caret.padding).toBe("0px");
  });

  test("keeps its icon and label centred", async ({ page }) => {
    const metrics = await page.evaluate(() => {
      const main = document.querySelector(".prio-create__main") as HTMLElement;
      const caret = document.querySelector(".prio-create__caret") as HTMLElement;
      const icon = caret.querySelector("svg") as SVGElement;

      const cr = caret.getBoundingClientRect();
      const ir = icon.getBoundingClientRect();

      return {
        caretCentreX: cr.x + cr.width / 2,
        caretCentreY: cr.y + cr.height / 2,
        iconCentreX: ir.x + ir.width / 2,
        iconCentreY: ir.y + ir.height / 2,
        mainAlign: getComputedStyle(main).alignItems,
        iconInsideCaret:
          ir.x >= cr.x && ir.right <= cr.right && ir.y >= cr.y && ir.bottom <= cr.bottom,
      };
    });

    expect(metrics.mainAlign).toBe("center");
    // The chevron sits centred in the caret, and does not overflow it.
    expect(metrics.iconCentreX).toBeCloseTo(metrics.caretCentreX, 0);
    expect(metrics.iconCentreY).toBeCloseTo(metrics.caretCentreY, 0);
    expect(metrics.iconInsideCaret).toBe(true);
  });

  test("hover and focus affect only one half, and never move the layout", async ({
    page,
  }) => {
    const before = await box(page, ".prio-create");

    const main = page.locator(".prio-create__main");
    await main.hover();
    const mainHoverBg = await main.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    const caretDuringMainHover = await page
      .locator(".prio-create__caret")
      .evaluate((el) => getComputedStyle(el).backgroundColor);

    // The hovered half tints; its sibling does not.
    expect(mainHoverBg).not.toBe(caretDuringMainHover);

    // Both halves are reachable by keyboard, and Tab moves from one to the
    // other, so the split control is not a single focus trap.
    await main.focus();
    const focusedMain = await page.evaluate(() => ({
      isMain: document.activeElement?.classList.contains("prio-create__main"),
      ring: getComputedStyle(document.activeElement as HTMLElement).boxShadow,
    }));
    expect(focusedMain.isMain).toBe(true);
    expect(focusedMain.ring).not.toBe("none");

    await page.keyboard.press("Tab");
    const focusedCaret = await page.evaluate(() =>
      document.activeElement?.classList.contains("prio-create__caret"),
    );
    expect(focusedCaret).toBe(true);

    const after = await box(page, ".prio-create");
    expect(after.w).toBeCloseTo(before.w, 1);
    expect(after.h).toBeCloseTo(before.h, 1);
  });

  test("the caret opens the type menu without shifting the control", async ({
    page,
  }) => {
    const before = await box(page, ".prio-create");

    await page.locator(".prio-create__caret").click();

    const menu = page.getByRole("menu", { name: /choose what to create/i });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Task" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Bug" })).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Story" })).toBeVisible();

    // Opening the menu must not move or resize the trigger.
    const during = await box(page, ".prio-create");
    expect(during.x).toBeCloseTo(before.x, 1);
    expect(during.w).toBeCloseTo(before.w, 1);
    expect(during.h).toBeCloseTo(before.h, 1);

    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();

    const after = await box(page, ".prio-create");
    expect(after.x).toBeCloseTo(before.x, 1);
    expect(after.w).toBeCloseTo(before.w, 1);
  });

  test("the two halves are independently clickable", async ({ page }) => {
    // The main half goes straight to a Task.
    await page.locator(".prio-create__main").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("heading", { name: "Create task" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();

    // The caret half opens the chooser instead.
    await page.locator(".prio-create__caret").click();
    await expect(
      page.getByRole("menu", { name: /choose what to create/i }),
    ).toBeVisible();
    await page.getByRole("menuitem", { name: "Bug" }).click();
    await expect(
      page.getByRole("dialog").getByRole("heading", { name: "Create bug" }),
    ).toBeVisible();
  });

  test.describe("responsive", () => {
    const viewports = [
      { name: "desktop", width: 1440, height: 900, labelVisible: true },
      { name: "laptop", width: 1280, height: 800, labelVisible: true },
      { name: "tablet", width: 768, height: 1024, labelVisible: false },
      { name: "mobile", width: 390, height: 844, labelVisible: false },
    ];

    for (const vp of viewports) {
      test(`stays aligned at ${vp.name} (${vp.width}px)`, async ({ page }) => {
        // Wait for the shell's width/margin transitions to settle before
        // measuring; a bare resize reads mid-animation geometry.
        await setViewport(page, vp.width, vp.height);

        const main = await box(page, ".prio-create__main");
        const caret = await box(page, ".prio-create__caret");

        expect(caret.h).toBe(main.h);
        expect(caret.y).toBeCloseTo(main.y, 1);
        expect(Math.abs(caret.x - main.right)).toBeLessThan(0.5);

        const labelShown = await page
          .locator(".prio-create__label")
          .isVisible();
        expect(labelShown).toBe(vp.labelVisible);

        // No horizontal overflow of the page at any size.
        const overflow = await page.evaluate(
          () =>
            document.documentElement.scrollWidth >
            document.documentElement.clientWidth,
        );
        expect(overflow).toBe(false);

        await page
          .locator(".prio-create")
          .screenshot({ path: `test-results/create-${vp.name}.png` });
      });
    }
  });

  test("produces no console errors or failed requests", async ({ page }) => {
    const { consoleErrors, failedRequests } = watchForProblems(page);

    await page.reload();
    await expect(page.locator(".prio-create")).toBeVisible();
    await page.locator(".prio-create__caret").click();
    await page.getByRole("menuitem", { name: "Story" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();

    expect(consoleErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
  });
});
