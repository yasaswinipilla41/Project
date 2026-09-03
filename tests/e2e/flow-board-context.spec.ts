import { expect, test } from "@playwright/test";
import { prisma } from "@/lib/prisma";

/**
 * The Flow Board's two contexts.
 *
 * Prio has one board component and two ways in, and the difference between
 * them is the whole point of this file:
 *
 *   - **from the sidebar** (`/board`) — every project the viewer can see, with
 *     "All Projects" as the Project dropdown's selection and *no* "Back to …"
 *     control, because there is no project to go back to.
 *   - **from a project** (`/projects/<key>/board`) — that project's issues,
 *     with a visible "Back to <project>" that returns to it.
 *
 * A back link on the all-projects board could only ever point somewhere
 * arbitrary, which is why its absence is asserted rather than assumed.
 */

async function aProject() {
  return prisma.project.findFirstOrThrow({
    where: { isArchived: false },
    select: { key: true, name: true },
    orderBy: { name: "asc" },
  });
}

test.describe("Flow Board from the sidebar", () => {
  test("opens the all-projects board with no back link", async ({ page }) => {
    await page.goto("/");
    await page
      .locator(".prio-sidebar")
      .getByRole("link", { name: "Flow Board" })
      .click();

    await expect(page).toHaveURL(/\/board$/);
    await expect(
      page.locator(".prio-page-header__title", { hasText: "Flow Board" }),
    ).toBeVisible();

    // The distinguishing control: absent here, present on a project board.
    await expect(page.locator(".prio-backlink")).toHaveCount(0);
  });

  test("has a Project dropdown with All Projects selected", async ({ page }) => {
    const project = await aProject();

    await page.goto("/board");
    await page
      .locator(".prio-board__filters")
      .getByRole("button", { name: "Project" })
      .click();

    const menu = page.getByRole("menu").first();
    await menu.waitFor();

    const all = menu
      .locator('[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"]')
      .filter({ hasText: "All Projects" })
      .first();
    await expect(all).toBeVisible();
    /* Selected by default: the menu marks the current view, and on `/board`
       that view is every project. */
    await expect(all).toHaveAttribute("aria-checked", "true");

    // The individual projects are still offered, as the way into one board.
    await expect(
      menu
        .locator('[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"]')
        .filter({ hasText: project.name })
        .first(),
    ).toBeVisible();
  });

  test("shows work from more than one project at once", async ({ page }) => {
    const projects = await prisma.project.findMany({
      where: { isArchived: false },
      select: { key: true },
    });
    test.skip(projects.length < 2, "needs at least two projects to prove it");

    await page.goto("/board");
    await expect(page.locator(".prio-board__card").first()).toBeVisible();

    const keys = await page.locator(".prio-board__card .prio-key").allInnerTexts();
    const prefixes = new Set(
      keys.map((key) => key.trim().split("-")[0]).filter(Boolean),
    );
    expect(prefixes.size).toBeGreaterThan(1);
  });
});

test.describe("Flow Board from inside a project", () => {
  test("shows Back to <project>, and it returns there", async ({ page }) => {
    const project = await aProject();

    await page.goto(`/projects/${project.key.toLowerCase()}`);
    // The project's own tab strip, not the sidebar entry beside it.
    await page
      .locator(".prio-projectnav")
      .getByRole("link", { name: "Flow Board" })
      .click();

    await expect(page).toHaveURL(
      new RegExp(`/projects/${project.key.toLowerCase()}/board$`),
    );

    const back = page.locator(".prio-backlink");
    await expect(back).toBeVisible();
    await expect(back).toHaveText(new RegExp(`Back to ${project.name}`));

    await back.click();
    await expect(page).toHaveURL(
      new RegExp(`/projects/${project.key.toLowerCase()}$`),
    );
  });

  test("shows only that project's issues", async ({ page }) => {
    const project = await aProject();

    await page.goto(`/projects/${project.key.toLowerCase()}/board`);
    const keys = await page.locator(".prio-board__card .prio-key").allInnerTexts();

    for (const key of keys) {
      expect(key.trim().startsWith(`${project.key}-`)).toBe(true);
    }
  });
});
