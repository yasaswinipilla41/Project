import { expect, test, type Page } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { ISSUE_TYPES, OPEN_STATUSES } from "@/lib/domain";

/**
 * The Summary's balanced grid, and the two cards that are new in it.
 *
 * The layout claim is a measurement, not a class name: the six cards are two
 * equal columns on a desktop and one on a phone, and no card is wider than
 * another. That is the thing that broke before — a `col-xl-8` main column with
 * a `col-xl-4` rail beside it, where the same card looked like a different
 * component depending on which side of the page it landed on.
 *
 * Epic progress and Team workload are asserted against the project's own rows,
 * because a progress figure that is not derived from anything is exactly the
 * kind of number a summary page grows by accident.
 */

/** The six cards §27 pairs off, in the order the grid places them. */
const PRIMARY_CARDS = [
  "Overview",
  "Recent activity",
  "Priority breakdown",
  "Types of work",
  "Team workload",
  "Epic progress",
] as const;

function card(page: Page, title: string) {
  return page
    .locator(".prio-summary__grid > .prio-card")
    .filter({
      has: page.locator(".prio-issue__section-title", {
        hasText: new RegExp(`^\\s*${title}`, "i"),
      }),
    })
    .first();
}

test.describe("The Summary grid", () => {
  test("is two equal columns, and every card is the same width", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/projects/eng/summary");

    const grid = page.locator(".prio-summary__grid");
    await expect(grid).toBeVisible();

    const cards = grid.locator("> .prio-card");
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(PRIMARY_CARDS.length);

    const boxes = [];
    for (let i = 0; i < count; i += 1) {
      boxes.push((await cards.nth(i).boundingBox())!);
    }

    /* Equal width, every one of them — the property the old 8/4 split did not
       have and the reason a rail card read as a different component. */
    const widths = boxes.map((b) => Math.round(b.width));
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);

    // Two columns: exactly two distinct left edges, and the first two cards
    // share a row rather than stacking.
    const lefts = [...new Set(boxes.map((b) => Math.round(b.x)))];
    expect(lefts.length).toBe(2);
    expect(Math.abs(boxes[0]!.y - boxes[1]!.y)).toBeLessThan(4);
    expect(boxes[1]!.x).toBeGreaterThan(boxes[0]!.x);

    // …and each card is close to half the grid, gap allowed for.
    const gridBox = (await grid.boundingBox())!;
    expect(widths[0]!).toBeGreaterThan(gridBox.width / 2 - 40);
    expect(widths[0]!).toBeLessThan(gridBox.width / 2 + 1);
  });

  test("collapses to one column on a phone, without scrolling sideways", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await page.goto("/projects/eng/summary");

    const cards = page.locator(".prio-summary__grid > .prio-card");
    await expect(cards.first()).toBeVisible();

    const first = (await cards.nth(0).boundingBox())!;
    const second = (await cards.nth(1).boundingBox())!;

    // Stacked: same left edge, the second below the first.
    expect(Math.round(first.x)).toBe(Math.round(second.x));
    expect(second.y).toBeGreaterThan(first.y + first.height - 1);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test("pairs the six cards off in the order the layout calls for", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto("/projects/eng/summary");

    for (const title of PRIMARY_CARDS) {
      await expect(card(page, title), `${title} card`).toBeVisible();
    }

    /* Row by row: Overview beside Recent activity, Priority beside Types,
       Workload beside Epics — each pair sharing a row, left then right. */
    for (let i = 0; i < PRIMARY_CARDS.length; i += 2) {
      const left = (await card(page, PRIMARY_CARDS[i]!).boundingBox())!;
      const right = (await card(page, PRIMARY_CARDS[i + 1]!).boundingBox())!;
      expect(
        Math.abs(left.y - right.y),
        `${PRIMARY_CARDS[i]} and ${PRIMARY_CARDS[i + 1]} share a row`,
      ).toBeLessThan(4);
      expect(right.x).toBeGreaterThan(left.x);
    }
  });
});

test.describe("Types of work", () => {
  test("every bar's width is the share it reports", async ({ page }) => {
    await page.goto("/projects/eng/summary");

    const rows = card(page, "Types of work").locator(".prio-breakdown__row");
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBe(ISSUE_TYPES.length);

    const total = await prisma.issue.count({ where: { project: { key: "ENG" } } });

    for (let i = 0; i < (await rows.count()); i += 1) {
      const row = rows.nth(i);
      const value = await row.locator(".prio-breakdown__value").innerText();
      const count = Number(/\d+/.exec(value)![0]);
      const share = Number(
        /(\d+)%/.exec(
          await row.locator(".prio-breakdown__share").innerText(),
        )![1],
      );

      // The percentage is this project's, and the bar is the percentage.
      expect(share).toBe(Math.round((count / total) * 100));

      const track = (await row.locator(".prio-breakdown__track").boundingBox())!;
      const bar = (await row.locator(".prio-breakdown__bar").boundingBox())!;
      const drawn = (bar.width / track.width) * 100;
      expect(Math.abs(drawn - share)).toBeLessThan(2);
    }
  });
});

test.describe("Team workload", () => {
  test("names only people holding this project's open work", async ({ page }) => {
    await page.goto("/projects/eng/summary");

    const rows = card(page, "Team workload").locator(".prio-breakdown__row");
    if ((await rows.count()) === 0) {
      await expect(card(page, "Team workload")).toContainText(
        /no open work is assigned/i,
      );
      return;
    }

    const assigned = await prisma.issue.findMany({
      where: {
        project: { key: "ENG" },
        status: { in: [...OPEN_STATUSES] },
        assigneeId: { not: null },
      },
      select: { assignee: { select: { name: true } } },
      distinct: ["assigneeId"],
    });
    const allowed = new Set(assigned.map((i) => i.assignee!.name));
    allowed.add("Unassigned");

    let sum = 0;
    for (let i = 0; i < (await rows.count()); i += 1) {
      const row = rows.nth(i);
      const label = (await row.locator(".prio-breakdown__label").innerText())
        .split(/\r?\n/)
        .map((p) => p.trim())
        .filter(Boolean)
        .pop()!;
      expect(allowed.has(label), `${label} holds open work here`).toBe(true);

      sum += Number(
        /\d+/.exec(await row.locator(".prio-breakdown__value").innerText())![0],
      );

      // Long names truncate rather than pushing the bar out of the card.
      const name = row.locator(".prio-breakdown__label .prio-truncate");
      if ((await name.count()) > 0) {
        const cardBox = (await card(page, "Team workload").boundingBox())!;
        const nameBox = (await name.boundingBox())!;
        expect(nameBox.x + nameBox.width).toBeLessThanOrEqual(
          cardBox.x + cardBox.width + 1,
        );
      }
    }

    // The rows account for all of this project's open work, once each.
    const open = await prisma.issue.count({
      where: { project: { key: "ENG" }, status: { in: [...OPEN_STATUSES] } },
    });
    expect(sum).toBe(open);
  });
});

test.describe("Epic progress", () => {
  test("reports each epic's own children, not a placeholder", async ({
    page,
  }) => {
    const epics = await prisma.issue.findMany({
      where: { project: { key: "ENG" }, type: "EPIC" },
      orderBy: { createdAt: "asc" },
      take: 8,
      select: {
        key: true,
        title: true,
        children: { select: { status: true } },
      },
    });

    await page.goto("/projects/eng/summary");
    const panel = card(page, "Epic progress");
    await expect(panel).toBeVisible();

    if (epics.length === 0) {
      await expect(panel).toContainText(/no epics in this project yet/i);
      await expect(panel.locator(".prio-epics__row")).toHaveCount(0);
      return;
    }

    const rows = panel.locator(".prio-epics__row");
    expect(await rows.count()).toBe(epics.length);

    for (const [index, epic] of epics.entries()) {
      const row = rows.nth(index);
      await expect(row).toContainText(epic.key);

      const done = epic.children.filter((c) => c.status === "DONE").length;
      const expected =
        epic.children.length > 0
          ? Math.round((done / epic.children.length) * 100)
          : null;

      const meter = row.locator('[role="progressbar"]');
      // The progress is announced, not only drawn.
      await expect(meter).toHaveAttribute("aria-valuenow", /^\d+$/);

      if (expected !== null) {
        await expect(meter).toHaveAttribute("aria-valuenow", String(expected));
        await expect(row.locator(".prio-epics__figure")).toContainText(
          `${done} of ${epic.children.length}`,
        );
      } else {
        // No children is said, rather than dressed up as 0% of something.
        await expect(row.locator(".prio-epics__figure")).toContainText(
          /no child issues|closed/i,
        );
      }
    }
  });
});

test.describe("Recent activity", () => {
  test("shows this project's own trail, or says there is none", async ({
    page,
  }) => {
    const entries = await prisma.activityLogEntry.count({
      where: { issue: { project: { key: "ENG" } } },
    });

    await page.goto("/projects/eng/summary");
    const panel = card(page, "Recent activity");
    await expect(panel).toBeVisible();

    if (entries === 0) {
      await expect(panel).toContainText(/no activity yet/i);
      return;
    }

    const items = panel.locator(".prio-activity__item");
    await expect(items.first()).toBeVisible();
    // A sample, not the whole feed.
    expect(await items.count()).toBeLessThanOrEqual(6);

    /* Every entry names an issue in this project — the feed is fixed to the
       route rather than filtered in the page. */
    for (const href of await panel
      .locator('a[href^="/issues/"]')
      .evaluateAll((links) => links.map((l) => l.getAttribute("href")!))) {
      expect(href.toLowerCase()).toMatch(/^\/issues\/eng-\d+$/);
    }
  });
});
