import { expect, test, type Page } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { ADMIN_EMAIL, ADMIN_STATE, setViewport, watchForProblems } from "./support";

/**
 * One project, one percentage, wherever it is drawn.
 *
 * The directory counts a project's finished work and divides it by all of it.
 * Home used to divide Done alone by the same total, and the project Summary
 * did too, so the same project honestly reported three different figures
 * depending on which page you had open. They now read from one contract.
 *
 * A unit test can prove the contract is a pure function of its counts. Only a
 * browser can prove the three pages are actually asking it, which is what this
 * file does: it reads the number off each rendered page and insists they match.
 */

test.use({ storageState: ADMIN_STATE });

/** The leading percentage out of any of the three captions. */
function share(text: string): number {
  const found = /(\d+)\s*%/.exec(text);
  if (!found) throw new Error(`No percentage in ${JSON.stringify(text)}`);
  return Number(found[1]);
}

/** A project that has work in it, so the figure under test is not just nought. */
async function busiestProject(page: Page) {
  await page.goto("/projects");
  const cards = page.locator(".prio-projectcard");
  await expect(cards.first()).toBeVisible();

  const count = await cards.count();
  let best: { key: string; percentage: number } | null = null;

  for (let i = 0; i < count; i += 1) {
    const card = cards.nth(i);
    const label = await card
      .locator(".prio-projectcard__progress-label")
      .innerText();
    if (label.includes("No issues yet")) continue;

    const href = await card
      .locator("a[href*='/welcome']")
      .first()
      .getAttribute("href");
    const key = /\/projects\/([^/]+)\//.exec(href ?? "")?.[1];
    if (!key) continue;

    const percentage = share(label);
    if (!best || percentage > best.percentage) best = { key, percentage };
  }

  if (!best) test.skip(true, "No project in this database has any work in it.");
  return best!;
}

test.describe("Project progress", () => {
  test("reads the same on the directory, Home and the project Summary", async ({
    page,
  }) => {
    const { consoleErrors } = watchForProblems(page);
    const project = await busiestProject(page);

    /* The directory, which is where the calculation lives. */
    const card = page.locator(
      `.prio-projectcard:has(a[href="/projects/${project.key}/welcome"])`,
    );
    const bar = card.getByRole("progressbar");
    await expect(bar).toHaveAttribute("aria-valuenow", String(project.percentage));
    await expect(bar).toHaveAttribute("aria-valuemin", "0");
    await expect(bar).toHaveAttribute("aria-valuemax", "100");

    /* Home, which used to divide Done alone by the total. */
    await page.goto("/");
    const row = page.locator(
      `a.prio-projrow[href="/projects/${project.key}/welcome"]`,
    );
    await expect(row).toHaveCount(1);
    expect(share(await row.locator(".prio-projrow__stats").innerText())).toBe(
      project.percentage,
    );

    /* And the project's own Summary. */
    await page.goto(`/projects/${project.key}/summary`);
    const caption = page.locator(".prio-summary__caption").first();
    await expect(caption).toBeVisible();
    expect(share(await caption.innerText())).toBe(project.percentage);

    expect(consoleErrors).toEqual([]);
  });

  test("says how much of what, not a bare percentage", async ({ page }) => {
    const project = await busiestProject(page);

    const label = await page
      .locator(`.prio-projectcard:has(a[href="/projects/${project.key}/welcome"])`)
      .locator(".prio-projectcard__progress-label")
      .innerText();

    /* "40% complete · 4 of 10" — the counts travel with the figure, so a
       reader can tell a small project from a stalled one. */
    const counts = /(\d+) of (\d+)/.exec(label);
    expect(counts, label).toBeTruthy();
    const [, completed, total] = counts!;
    expect(Number(total)).toBeGreaterThan(0);
    expect(Number(completed)).toBeLessThanOrEqual(Number(total));
    expect(Math.round((Number(completed) / Number(total)) * 100)).toBe(
      project.percentage,
    );
  });

  test("says a project with nothing in it is empty, not nought per cent", async ({
    page,
  }) => {
    /* Made rather than looked for: whether any seeded project happens to be
       empty is not something this assertion should depend on. It is removed
       again at the end, so the database is as it was found. */
    const admin = await prisma.user.findUniqueOrThrow({
      where: { email: ADMIN_EMAIL },
      select: { id: true },
    });
    const key = `E2E${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const made = await prisma.project.create({
      data: { name: `Empty ${key}`, key, createdById: admin.id },
      select: { id: true },
    });

    try {
      await page.goto("/projects");
      const card = page.locator(
        `.prio-projectcard:has(a[href="/projects/${key.toLowerCase()}/welcome"])`,
      );
      await expect(card).toBeVisible();

      /* The bar is still drawn, at nought width, so the card keeps its shape
         — and the label says there is nothing to measure rather than claiming
         the project has failed to finish anything. */
      await expect(card.getByRole("progressbar")).toHaveAttribute(
        "aria-valuenow",
        "0",
      );
      await expect(card.getByRole("progressbar")).toHaveAttribute(
        "aria-label",
        "No issues yet",
      );
      await expect(card.locator(".prio-projectcard__progress-label")).toHaveText(
        "No issues yet",
      );

      /* And its own Summary agrees, through the same contract. */
      await page.goto(`/projects/${key.toLowerCase()}/summary`);
      await expect(page.getByText("No issues yet").first()).toBeVisible();
      await expect(page.locator(".prio-summary__caption")).toHaveCount(0);
    } finally {
      await prisma.project.deleteMany({ where: { id: made.id } });
    }
  });

  test("is the project's figure, not the filtered list's", async ({ page }) => {
    /* Filters belong to the work list and say nothing about how far through a
       project is; the figure is the same before and after one is applied. */
    const project = await busiestProject(page);
    await page.goto(`/projects/${project.key}/summary`);
    const before = share(
      await page.locator(".prio-summary__caption").first().innerText(),
    );

    await page.goto(`/projects/${project.key}/list?status=DONE&page=1`);
    await page.goto(`/projects/${project.key}/summary`);

    expect(
      share(await page.locator(".prio-summary__caption").first().innerText()),
    ).toBe(before);
  });
});

test.describe("The shared bar itself", () => {
  test("is the directory's bar in both themes, not a second purple", async ({
    page,
  }) => {
    await page.goto("/projects");
    const fill = page.locator(".prio-projectcard .prio-progress__bar").first();
    await expect(fill).toBeAttached();

    async function paint() {
      return fill.evaluate((el) => {
        const style = getComputedStyle(el);
        const track = getComputedStyle(el.parentElement!);
        return {
          fill: style.backgroundImage,
          height: style.height,
          radius: style.borderTopLeftRadius,
          track: track.backgroundColor,
        };
      });
    }

    async function theme(choice: "light" | "dark") {
      await page.evaluate(
        (value) => document.documentElement.setAttribute("data-theme", value),
        choice,
      );
      /* One frame for the custom-property cascade to settle before measuring,
         the same wait the theme spec uses. */
      await page.waitForTimeout(120);
    }

    /* Both themes are set explicitly rather than assumed. Whatever this
       browser was left in by an earlier test, the comparison below is still
       light against dark. */
    await theme("light");
    const light = await paint();

    /* The fill is the brand gradient token, so it is a gradient rather than a
       flat colour somebody typed in beside it. */
    expect(light.fill).toContain("gradient");
    expect(light.height).toBe("6px");

    await theme("dark");
    const dark = await paint();

    /* Same fill, same geometry; the track follows the theme, which is what
       makes it the page's own bar rather than a fixed one painted over it. */
    expect(dark.fill).toBe(light.fill);
    expect(dark.height).toBe(light.height);
    expect(dark.radius).toBe(light.radius);
    expect(dark.track).not.toBe(light.track);
  });

  test("keeps its shape from desktop down to a phone", async ({ page }) => {
    await page.goto("/projects");
    const card = page.locator(".prio-projectcard").first();
    const bar = card.locator(".prio-progress").first();
    await expect(bar).toBeVisible();

    for (const [width, height] of [
      [1440, 900],
      [834, 1112],
      [390, 844],
    ] as const) {
      await setViewport(page, width, height);

      const [barBox, cardBox] = await Promise.all([
        bar.boundingBox(),
        card.boundingBox(),
      ]);

      /* Inside the card it belongs to, at every width, and never a hairline:
         a bar that overflowed or collapsed would still "be visible". */
      expect(barBox, `${width}px`).toBeTruthy();
      expect(barBox!.width).toBeGreaterThan(40);
      expect(Math.round(barBox!.height)).toBe(6);
      expect(barBox!.x).toBeGreaterThanOrEqual(Math.floor(cardBox!.x));
      expect(barBox!.x + barBox!.width).toBeLessThanOrEqual(
        Math.ceil(cardBox!.x + cardBox!.width) + 1,
      );
    }
  });
});
