import { expect, test, type Page } from "@playwright/test";
import { prisma } from "@/lib/prisma";

/**
 * Three surfaces that changed together, each verified where it is used.
 *
 *   - the Create dialog's label control, which now shows the project's own
 *     vocabulary instead of waiting to be guessed at;
 *   - the sidebar's single Projects section, which no longer has a Pinned
 *     section above it or any pin control on a row;
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
  /**
   * The one project section the sidebar has, now that Pinned is gone.
   *
   * Located by its section *label*, not by the text "Projects" anywhere in the
   * section: the navigation block above also contains a "Projects" link, and
   * matching on that would silently point every assertion below at the wrong
   * section. Case-insensitive because the stylesheet uppercases the label.
   */
  function projectsSection(page: Page) {
    return page.locator(".prio-sidebar__section").filter({
      has: page.locator(".prio-sidebar__section-label", {
        hasText: /^projects$/i,
      }),
    });
  }

  test("has one Projects section and no Pinned section", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".prio-sidebar__project-row").first()).toBeVisible();

    const sidebar = page.locator(".prio-sidebar");
    const headings = (
      await sidebar.locator(".prio-sidebar__section-label").allInnerTexts()
    ).map((t) => t.trim());

    /* Read as rendered — the stylesheet uppercases section labels. */
    const folded = headings.map((h) => h.toLowerCase());
    expect(folded).toContain("projects");
    expect(folded).not.toContain("pinned");
    expect(folded).not.toContain("recents");

    // Exactly one section holds the project rows.
    await expect(projectsSection(page)).toHaveCount(1);
  });

  /*
   * Pinning is gone from the markup, not merely from view. Counting elements
   * rather than checking visibility is the point: a `toBeHidden` would pass
   * against a button that is still there behind `opacity: 0`.
   */
  test("renders no pin control anywhere in the sidebar", async ({ page }) => {
    await page.goto("/");
    const sidebar = page.locator(".prio-sidebar");
    const rows = sidebar.locator(".prio-sidebar__project-row");
    await expect(rows.first()).toBeVisible();

    await expect(sidebar.getByRole("button", { name: /^Pin / })).toHaveCount(0);
    await expect(sidebar.getByRole("button", { name: /Unpin/i })).toHaveCount(0);
    // The "..." menu that used to hold Pin is gone too.
    await expect(
      sidebar.getByRole("button", { name: /More actions/ }),
    ).toHaveCount(0);

    for (let i = 0; i < (await rows.count()); i += 1) {
      const row = rows.nth(i);
      await row.hover();
      await expect(
        row.getByRole("button", { name: /^Pin |Unpin/i }),
        "a hovered row must not reveal a pin control either",
      ).toHaveCount(0);
    }
  });

  test("keeps the project rows themselves unchanged", async ({ page }) => {
    /* The rows are the sidebar's own list, in most-recently-opened order.
       What matters after removing a section is that the same projects are
       still listed, still named, still linked. */
    const projects = await prisma.project.findMany({
      where: { isArchived: false },
      select: { name: true, key: true },
    });
    const names = new Set(projects.map((p) => p.name));

    await page.goto("/");
    const rows = projectsSection(page).locator(".prio-sidebar__project-row");
    await expect(rows.first()).toBeVisible();

    expect(await rows.count()).toBeGreaterThan(0);

    for (let i = 0; i < (await rows.count()); i += 1) {
      const row = rows.nth(i);
      const name = (await row.locator(".prio-navitem__label").innerText()).trim();
      expect(names.has(name), `${name} is a real project`).toBe(true);
      // Its chip and its link both survive.
      await expect(row.locator(".prio-project-chip")).toHaveCount(1);
      await expect(row.locator("a.prio-sidebar__project-link")).toHaveCount(1);
    }
  });

  test("navigating from a project row still works", async ({ page }) => {
    await page.goto("/");
    const row = projectsSection(page).locator(".prio-sidebar__project-row").first();
    const name = (await row.locator(".prio-navitem__label").innerText()).trim();
    const project = await prisma.project.findFirstOrThrow({
      where: { name },
      select: { key: true },
    });

    await row.locator("a.prio-sidebar__project-link").click();
    await expect(page).toHaveURL(
      new RegExp(`/projects/${project.key.toLowerCase()}$`),
    );
  });

  test("Favorite still works from the row itself", async ({ page }) => {
    await page.goto("/");
    const row = projectsSection(page).locator(".prio-sidebar__project-row").first();
    const name = (await row.locator(".prio-navitem__label").innerText()).trim();

    await row.hover();
    await row.locator(".prio-sidebar__project-fav").click();
    await expect
      .poll(async () =>
        prisma.projectFavorite.count({ where: { project: { name } } }),
      )
      .toBeGreaterThan(0);

    // And back, leaving the fixture as it was found.
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
