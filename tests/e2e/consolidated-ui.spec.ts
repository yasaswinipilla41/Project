import { expect, test, type Page } from "@playwright/test";
import { prisma } from "@/lib/prisma";

/**
 * Three surfaces that changed together, each verified where it is used.
 *
 *   - the Create dialog's label control, which now shows the project's own
 *     vocabulary instead of waiting to be guessed at;
 *   - the sidebar's project rows, whose hover controls have a fixed order and
 *     a fixed alignment across Pinned and Recents;
 *   - a project's List tab, which no longer offers a Project filter it cannot
 *     act on.
 */

async function aProject(): Promise<{ key: string; name: string }> {
  return prisma.project.findFirstOrThrow({
    where: { isArchived: false },
    select: { key: true, name: true },
    orderBy: { name: "asc" },
  });
}

async function aProjectKey(): Promise<string> {
  return (await aProject()).key;
}

/** How the Create dialog's Project select labels one project. */
function projectOption(project: { key: string; name: string }): string {
  return `${project.name} (${project.key})`;
}

async function openCreateDialog(page: Page) {
  await page.goto("/issues");
  await page.getByRole("button", { name: /^Create$/ }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Project")).toBeVisible();
  return dialog;
}

test.describe("The Create dialog's label control", () => {
  test("lists the project's existing labels before anything is typed", async ({
    page,
  }) => {
    const project = await aProject();
    const key = project.key;
    const labels = await prisma.label.findMany({
      where: { project: { key } },
      select: { name: true },
      orderBy: { name: "asc" },
    });
    expect(
      labels.length,
      "the fixture needs a project with labels",
    ).toBeGreaterThan(0);

    const dialog = await openCreateDialog(page);
    await dialog
      .getByLabel("Project")
      .selectOption({ label: projectOption(project) });

    const input = dialog.getByLabel("Search or create a label");
    await expect(input).toBeEnabled();
    await input.click();

    // Opening it is enough: the vocabulary is on screen, unprompted.
    const options = dialog.locator(".prio-labelpicker__option");
    await expect(options.first()).toBeVisible();

    const shown = (await options.allInnerTexts()).map((t) => t.trim());
    for (const label of labels) {
      expect(
        shown.some((text) => text.includes(label.name)),
        `${label.name} must be selectable without typing it`,
      ).toBe(true);
    }
  });

  test("selects an existing label, and offers to create only a new one", async ({
    page,
  }) => {
    const project = await aProject();
    const key = project.key;
    const existing = await prisma.label.findFirstOrThrow({
      where: { project: { key } },
      select: { name: true },
      orderBy: { name: "asc" },
    });

    const dialog = await openCreateDialog(page);
    await dialog
      .getByLabel("Project")
      .selectOption({ label: projectOption(project) });

    const input = dialog.getByLabel("Search or create a label");
    await input.click();
    await dialog
      .locator(".prio-labelpicker__option")
      .filter({ hasText: existing.name })
      .first()
      .click();

    // Picked labels become removable chips on the form.
    await expect(
      dialog.locator(".prio-chipset__chip").filter({ hasText: existing.name }),
    ).toBeVisible();

    /* A name the project already has is never offered for creation — that is
       what stops "QA" and "qa" becoming two labels. */
    await input.click();
    await input.fill(existing.name.toUpperCase());
    await expect(
      dialog.locator(".prio-labelpicker__option[data-create]"),
    ).toHaveCount(0);

    // A name it does not have is.
    await input.fill(`Novel label ${Date.now()}`);
    await expect(
      dialog.locator(".prio-labelpicker__option[data-create]"),
    ).toBeVisible();
  });

  test("creates a custom label and keeps it in the project's list", async ({
    page,
  }) => {
    const project = await aProject();
    const key = project.key;
    const name = `Custom ${Date.now()}`;

    const dialog = await openCreateDialog(page);
    await dialog
      .getByLabel("Project")
      .selectOption({ label: projectOption(project) });

    const input = dialog.getByLabel("Search or create a label");
    await input.click();
    await input.fill(name);
    await dialog.locator(".prio-labelpicker__option[data-create]").click();

    await expect(
      dialog.locator(".prio-chipset__chip").filter({ hasText: name }),
    ).toBeVisible({ timeout: 20_000 });

    // Persisted through the project's own label store, not a form-local list.
    await expect
      .poll(async () => prisma.label.count({ where: { project: { key }, name } }), {
        timeout: 20_000,
      })
      .toBe(1);

    // And it is there, once, the next time the dialog is opened.
    await page.keyboard.press("Escape");
    const again = await openCreateDialog(page);
    await again
      .getByLabel("Project")
      .selectOption({ label: projectOption(project) });
    const reopened = again.getByLabel("Search or create a label");
    await reopened.click();
    await reopened.fill(name);
    await expect(
      again.locator(".prio-labelpicker__option").filter({ hasText: name }),
    ).toHaveCount(1);
    await expect(
      again.locator(".prio-labelpicker__option[data-create]"),
    ).toHaveCount(0);

    await prisma.label.deleteMany({ where: { project: { key }, name } });
  });
});

test.describe("Sidebar project rows", () => {
  /** The Recents section, which is the one that is not the Pinned toggle. */
  function recentsSection(page: Page) {
    return page
      .locator(".prio-sidebar__section")
      .filter({ has: page.getByText("Recents", { exact: true }) });
  }

  function pinnedSection(page: Page) {
    return page.locator(
      ".prio-sidebar__section:has(.prio-sidebar__section-label--toggle)",
    );
  }

  /** Makes sure there is one pinned row and one unpinned row to compare. */
  async function withBothSections(page: Page) {
    await page.goto("/");
    const rows = page.locator(".prio-sidebar__project-row");
    test.skip((await rows.count()) < 2, "needs at least two sidebar projects");

    const pinned = pinnedSection(page).locator(".prio-sidebar__project-row");
    if ((await pinned.count()) === 0) {
      const first = rows.first();
      await first.hover();
      await first.getByRole("button", { name: /^Pin / }).click();
      await expect(pinned).toHaveCount(1, { timeout: 20_000 });
    }

    const recent = recentsSection(page).locator(".prio-sidebar__project-row");
    test.skip((await recent.count()) === 0, "needs a project in Recents");

    return { pinned: pinned.first(), recent: recent.first() };
  }

  test("shows Pin only on hover, and never on a pinned row", async ({ page }) => {
    const { pinned, recent } = await withBothSections(page);

    // At rest the Pin is present but invisible — it does not occupy the row.
    const pin = recent.getByRole("button", { name: /^Pin / });
    await page.mouse.move(0, 0);
    await expect
      .poll(async () => pin.evaluate((el) => getComputedStyle(el).opacity))
      .toBe("0");

    await recent.hover();
    await expect
      .poll(async () => pin.evaluate((el) => getComputedStyle(el).opacity))
      .toBe("1");

    // A pinned row carries no Pin at all; the section it is in already says so.
    await pinned.hover();
    await expect(pinned.getByRole("button", { name: /^Pin / })).toHaveCount(0);
  });

  test("orders the hover controls, and aligns them across both sections", async ({
    page,
  }) => {
    const { pinned, recent } = await withBothSections(page);

    /* Recents: name -> Pin -> Favorite. Read as x positions, which is what
       the requirement is actually about. The row's "..." menu was removed,
       so Favorite is the last control on the row. */
    await recent.hover();
    const recentPin = await recent
      .getByRole("button", { name: /^Pin / })
      .boundingBox();
    const recentFav = await recent
      .locator(".prio-sidebar__project-fav")
      .boundingBox();

    expect(recentPin!.x).toBeLessThan(recentFav!.x);

    // Pinned: name -> Favorite, with the Pin's space still held open.
    await pinned.hover();
    const pinnedFav = await pinned
      .locator(".prio-sidebar__project-fav")
      .boundingBox();

    /* And the two sections line up: Favorite sits at the same x in Pinned as
       in Recents, so it does not shift as the eye crosses a section. */
    expect(Math.abs(pinnedFav!.x - recentFav!.x)).toBeLessThanOrEqual(1);
  });

  /*
   * The row's "..." menu is gone, from the markup and not merely from view.
   *
   * It used to sit at the end of every project row, invisible until hover,
   * holding Favorite, Pin and Share. Favorite and Pin are buttons on the row
   * itself and do the same job in one click; the menu is not hidden, it is
   * not rendered, which is what this asserts — a `toBeHidden` would pass just
   * as well against `opacity: 0`.
   */
  test("no project row renders a three-dots menu at all", async ({ page }) => {
    await page.goto("/");
    const rows = page.locator(".prio-sidebar__project-row");
    await expect(rows.first()).toBeVisible();

    expect(await rows.count()).toBeGreaterThan(0);

    // Nowhere in the sidebar, hovered or not.
    await expect(
      page.locator(".prio-sidebar").getByRole("button", { name: /More actions/ }),
    ).toHaveCount(0);

    for (let i = 0; i < (await rows.count()); i += 1) {
      const row = rows.nth(i);
      await row.hover();
      await expect(
        row.getByRole("button", { name: /More actions/ }),
        "a hovered row must not reveal a menu either",
      ).toHaveCount(0);
      // The controls that remain, and nothing else.
      await expect(row.locator(".prio-sidebar__project-fav")).toHaveCount(1);
      expect(await row.getByRole("button").count()).toBeLessThanOrEqual(2);
    }
  });

  test("Pin and Favorite still work from the row itself", async ({ page }) => {
    await page.goto("/");
    const recent = recentsSection(page).locator(".prio-sidebar__project-row");
    test.skip((await recent.count()) === 0, "needs a project in Recents");

    const row = recent.first();
    const name = await row.locator(".prio-navitem__label").innerText();

    // Favourite it from the row, and read the state back from the database.
    await row.hover();
    await row.locator(".prio-sidebar__project-fav").click();
    await expect
      .poll(async () =>
        prisma.projectFavorite.count({ where: { project: { name } } }),
      )
      .toBeGreaterThan(0);

    // And unfavourite it again, leaving the fixture as it was found.
    await row.hover();
    await row.locator(".prio-sidebar__project-fav").click();
    await expect
      .poll(async () =>
        prisma.projectFavorite.count({ where: { project: { name } } }),
      )
      .toBe(0);
  });

  test("a project favorited from the Flow Board is starred in the sidebar", async ({
    page,
  }) => {
    const key = await aProjectKey();

    await page.goto(`/projects/${key.toLowerCase()}/board`);
    const star = page.locator(".prio-board__favorite");
    await expect(star).toBeVisible();

    if ((await star.getAttribute("aria-pressed")) === "true") {
      await star.click();
      await expect(star).toHaveAttribute("aria-pressed", "false");
    }

    await star.click();
    await expect(star).toHaveAttribute("aria-pressed", "true");

    /* The sidebar reads the same `ProjectFavorite` row the board just wrote,
       so the star lights up beside the project name without a reload. */
    const row = page
      .locator(".prio-sidebar__project-row")
      .filter({ has: page.locator(`.prio-project-chip:text-is("${key.slice(0, 2)}")`) })
      .first();
    await expect(row.locator(".prio-sidebar__project-fav[data-on]")).toHaveCount(
      1,
      { timeout: 20_000 },
    );

    // Leave the fixture as it was found.
    await star.click();
    await expect(star).toHaveAttribute("aria-pressed", "false");
  });
});

test.describe("Home's due bar", () => {
  /*
   * The bucket has to be non-empty for the link to exist at all, and the seed
   * makes no promises about due dates, so the fixture is created here and
   * removed afterwards rather than hoped for.
   */
  let seeded: string | null = null;

  test.afterEach(async () => {
    if (seeded) {
      await prisma.issue.delete({ where: { id: seeded } }).catch(() => undefined);
      seeded = null;
    }
  });

  test("\"due this week\" opens the week's work, not everything open", async ({
    page,
  }) => {
    const admin = await prisma.user.findFirstOrThrow({
      where: { role: "ADMIN", isActive: true },
      select: { id: true },
      orderBy: { createdAt: "asc" },
    });
    const project = await prisma.project.findFirstOrThrow({
      where: { isArchived: false },
      select: { id: true, key: true, issueSequence: true },
      orderBy: { name: "asc" },
    });

    const today = new Date();
    today.setHours(12, 0, 0, 0);

    const number = project.issueSequence + 1;
    const issue = await prisma.issue.create({
      data: {
        projectId: project.id,
        number,
        key: `${project.key}-${number}`,
        type: "TASK",
        title: `Due today ${Date.now()}`,
        status: "TODO",
        priority: "MEDIUM",
        reporterId: admin.id,
        assigneeId: admin.id,
        dueDate: today,
      },
      select: { id: true },
    });
    seeded = issue.id;
    await prisma.project.update({
      where: { id: project.id },
      data: { issueSequence: number },
    });

    await page.goto("/");

    const link = page.locator(".prio-duebar__item", { hasText: "due this week" });
    await expect(link.first()).toBeVisible({ timeout: 20_000 });

    /* The filter the count was made with. Without it the link opened every
       open issue assigned to the reader, overdue and undated alike. */
    const href = await link.first().getAttribute("href");
    expect(href).toContain("dueWeek=1");

    await link.first().click();
    await expect(page).toHaveURL(/dueWeek=1/);

    // The list renders; what it contains is pinned by the unit tests, which
    // can create issues on either side of every boundary.
    await expect(page.locator(".prio-filters__total")).toBeVisible();
  });
});

test.describe("A project's List tab", () => {
  test("has no Project dropdown, and keeps every other filter", async ({
    page,
  }) => {
    const key = await aProjectKey();
    await page.goto(`/projects/${key.toLowerCase()}/list`);

    const chips = page.locator(".prio-filters__chips");
    await expect(chips).toBeVisible();

    await expect(
      chips.getByRole("button", { name: "Project", exact: true }),
    ).toHaveCount(0);

    for (const label of [
      "Type",
      "Status",
      "Priority",
      "Severity",
      "Assignee",
      "Reporter",
      "More",
    ]) {
      await expect(
        chips.getByRole("button", { name: label, exact: true }),
        `${label} must still be offered`,
      ).toBeVisible();
    }

    // Search and the result count are untouched too.
    await expect(page.getByLabel("Search issues")).toBeVisible();
    await expect(page.locator(".prio-filters__total")).toBeVisible();
  });

  test("still offers the Project dropdown on the global Issues list", async ({
    page,
  }) => {
    await page.goto("/issues");
    await expect(
      page
        .locator(".prio-filters__chips")
        .getByRole("button", { name: "Project", exact: true }),
    ).toBeVisible();
  });
});
