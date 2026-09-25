import { expect, test, type Locator, type Page } from "@playwright/test";
import { ADMIN_STATE, MEMBER_STATE } from "./support";

/**
 * The four-way work breakdown drawn beside each project's progress bar on Home.
 *
 * The arithmetic is pinned by the unit tests; what is checked here is the part
 * only a browser can answer — that the bar is actually drawn, that the widths
 * in the markup are the exact ratios rather than the rounded legend figures,
 * that a group holding nothing occupies nothing, and that the two percentages
 * on the row are labelled as the different measurements they are.
 */

const CATEGORIES = ["completed", "inProgress", "notStarted", "other"] as const;

/** The legend's figures for one project row, read back off the page. */
async function legendOf(row: Locator) {
  const items = row.locator(".prio-distribution__legenditem");
  const entries: { label: string; count: number; percentage: number }[] = [];

  for (let i = 0; i < (await items.count()); i += 1) {
    const text = (await items.nth(i).innerText()).trim();
    /* "Completed — 5 (22%)", and the trailing "Total — 23 work items (100%)"
       which is matched separately below. */
    const match = /^(.+?) — (\d+) \((\d+)%\)$/.exec(text);
    if (match && !text.startsWith("Total")) {
      entries.push({
        label: match[1]!,
        count: Number(match[2]),
        percentage: Number(match[3]),
      });
    }
  }
  return entries;
}

/** The rendered segment widths, as the browser resolved them. */
async function widthsOf(row: Locator) {
  return row.locator(".prio-distribution__track .prio-distribution__bar").evaluateAll(
    (nodes) =>
      nodes.map((node) => ({
        bucket: (node as HTMLElement).dataset.bucket ?? "?",
        /* The inline style, not the computed pixels: this is the exact ratio
           the component asked for, before the browser rounds it to a device
           pixel. */
        declared: Number.parseFloat((node as HTMLElement).style.width),
        pixels: node.getBoundingClientRect().width,
      })),
  );
}

async function projectRows(page: Page) {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  const rows = page.locator(".prio-projrow");
  await expect(rows.first()).toBeVisible();
  return rows;
}

test.describe("the work breakdown on Home", () => {
  test.use({ storageState: ADMIN_STATE });

  test("draws a distribution bar beside every progress bar", async ({ page }) => {
    const rows = await projectRows(page);
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i += 1) {
      const row = rows.nth(i);
      /* The existing bar is still there and still first: the breakdown was
         added beside it, not in place of it. */
      await expect(row.locator(".prio-progress")).toHaveCount(1);
      await expect(row.locator(".prio-distribution__split")).toHaveCount(1);

      const progressBox = (await row.locator(".prio-progress").boundingBox())!;
      const splitBox = (await row
        .locator(".prio-distribution__split")
        .boundingBox())!;
      expect(splitBox.y).toBeGreaterThanOrEqual(progressBox.y);
    }
  });

  test("names each measurement, so two percentages are not read as one", async ({
    page,
  }) => {
    const row = (await projectRows(page)).first();

    /* The progress bar keeps its own long-standing line. */
    const stats = await row.locator(".prio-projrow__stats").innerText();
    expect(stats).toContain("% complete");

    /* And the breakdown says which question it answers, because closed work
       includes Rejected and Cancelled while Completed here does not — the two
       figures differ by design and must not look like the same one twice. */
    await expect(row.locator(".prio-distribution__caption")).toHaveText(
      "Work items by state",
    );
  });

  test("legend counts add up to the total it prints", async ({ page }) => {
    const rows = await projectRows(page);

    for (let i = 0; i < (await rows.count()); i += 1) {
      const row = rows.nth(i);
      const entries = await legendOf(row);

      /* Always the same four, always in the same order. */
      expect(entries.map((e) => e.label)).toEqual([
        "Completed",
        "In Progress",
        "Not Started",
        "Other",
      ]);

      const totalText = await row
        .locator(".prio-distribution__legenditem--total")
        .innerText();
      const printedTotal = Number(/— (\d+) work item/.exec(totalText)![1]);

      const summed = entries.reduce((sum, entry) => sum + entry.count, 0);
      expect(summed, `row ${i} counts must total the printed figure`).toBe(
        printedTotal,
      );

      /* Every work item is in exactly one group, so the four percentages are
         the whole of it — and they are corrected to read as exactly 100. */
      const percentages = entries.reduce((sum, entry) => sum + entry.percentage, 0);
      expect(percentages, `row ${i} legend must read 100%`).toBe(100);
      expect(totalText).toContain("(100%)");
    }
  });

  test("draws exact ratios, not the rounded legend figures", async ({ page }) => {
    const rows = await projectRows(page);

    for (let i = 0; i < (await rows.count()); i += 1) {
      const row = rows.nth(i);
      const entries = await legendOf(row);
      const widths = await widthsOf(row);
      const total = entries.reduce((sum, entry) => sum + entry.count, 0);
      if (total === 0) continue;

      /* A group holding nothing draws nothing at all — no segment, and so no
         minimum sliver claiming space it does not have. */
      const drawn = new Set(widths.map((w) => w.bucket));
      for (const [index, category] of CATEGORIES.entries()) {
        const count = entries[index]!.count;
        expect(drawn.has(category), `${category} drawn only when non-zero`).toBe(
          count > 0,
        );
      }

      /* And each segment that is drawn occupies its true share, which is what
         the rounded legend figure cannot be relied on for: a third is
         33.333…%, never the 33% or 34% printed beside it. */
      for (const width of widths) {
        const index = CATEGORIES.indexOf(width.bucket as (typeof CATEGORIES)[number]);
        const exact = (entries[index]!.count / total) * 100;
        expect(
          width.declared,
          `${width.bucket} must be drawn at its exact ratio`,
        ).toBeCloseTo(exact, 3);
      }

      const declared = widths.reduce((sum, w) => sum + w.declared, 0);
      expect(declared, `row ${i} segments must fill the bar`).toBeCloseTo(100, 3);
    }
  });

  test("the bar has real width, so the ratios are visible", async ({ page }) => {
    const row = (await projectRows(page)).first();

    const track = await row.locator(".prio-distribution__track").boundingBox();
    expect(track?.width ?? 0).toBeGreaterThan(20);

    /* A chart whose segments have collapsed still prints the right numbers,
       so the numbers alone do not prove it rendered. */
    for (const width of await widthsOf(row)) {
      expect(width.pixels, `${width.bucket} must draw`).toBeGreaterThan(0);
    }
  });

  test("holds its shape from desktop down to a phone", async ({ page }) => {
    const rows = await projectRows(page);
    const row = rows.first();

    for (const [width, height] of [
      [1440, 900],
      [900, 800],
      [390, 780],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(250);

      const track = await row.locator(".prio-distribution__track").boundingBox();
      expect(track, `${width}px track`).toBeTruthy();
      expect(track!.width, `${width}px track width`).toBeGreaterThan(20);

      /* The legend wraps rather than pushing the page sideways. */
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
      expect(overflow, `${width}px horizontal overflow`).toBeLessThanOrEqual(1);
    }
  });
});

test.describe("what a member's breakdown covers", () => {
  test.use({ storageState: MEMBER_STATE });

  /*
   * The role decides which projects are on the page; it must not change what
   * any status means. Both halves are checked: a member sees only their own
   * projects, and every row they do see still reads as a complete breakdown.
   */
  test("shows only their own projects, each still totalling 100%", async ({
    page,
  }) => {
    const rows = await projectRows(page);
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);

    /* Every project listed is one the member can actually open — the row is a
       link to it, and a project they cannot reach would not be listed. */
    for (let i = 0; i < count; i += 1) {
      const row = rows.nth(i);
      await expect(row).toHaveAttribute("href", /\/projects\/[a-z0-9-]+\/welcome/);

      const entries = await legendOf(row);
      expect(entries).toHaveLength(4);
      expect(entries.reduce((sum, e) => sum + e.percentage, 0)).toBe(100);
    }

    /* And the organisation-wide panel stays out of their page entirely, so no
       figure on it can leak a project they are not on. */
    await expect(page.getByRole("heading", { name: "Organisation" })).toHaveCount(0);
  });
});
