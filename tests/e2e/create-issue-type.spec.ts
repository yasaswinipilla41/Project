import { expect, test, type Page } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { ISSUE_TYPES, ISSUE_TYPE_LABEL } from "@/lib/domain";

/**
 * Choosing what you are creating.
 *
 * The Create dialog used to ask for the issue type with five cards across the
 * top of the form. It is a dropdown now, in the field list beside Project and
 * Summary. What matters is that the change is presentational: the control
 * offers exactly the canonical `IssueType` vocabulary, and the type that comes
 * back from the database is the one that was chosen — not a generic issue
 * relabelled in the interface.
 *
 * Every type the enum defines is created here, so a type added later fails
 * this file until it is handled rather than passing silently.
 */

const stamp = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

const created: string[] = [];

test.afterAll(async () => {
  if (created.length > 0) {
    await prisma.issue.deleteMany({ where: { id: { in: created } } });
  }
});

/** Opens the dialog from the top bar, which is the entry point that asks. */
async function openCreate(page: Page) {
  await page.goto("/");
  await expect(page.locator(".prio-create")).toBeVisible();
  await page.locator(".prio-create__main").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe("The Create dialog's issue type", () => {
  test("is a dropdown offering exactly the canonical types", async ({ page }) => {
    const dialog = await openCreate(page);

    const select = dialog.getByLabel("Issue type");
    await expect(select).toBeVisible();

    const options = await select.locator("option").allInnerTexts();
    expect(options.map((t) => t.trim())).toEqual(
      ISSUE_TYPES.map((type) => ISSUE_TYPE_LABEL[type]),
    );

    // Keyboard-operable and labelled, with no ARIA of its own to get wrong.
    await expect(select).toHaveRole("combobox");
    await expect(select).toBeEnabled();
  });

  test("Project, Issue type and Summary read in that order", async ({ page }) => {
    const dialog = await openCreate(page);

    const labels = (
      await dialog.locator(".prio-createissue__rowlabel").allInnerTexts()
    ).map((t) => t.replace(/\s*\*\s*$/, "").trim());

    expect(labels.slice(0, 4)).toEqual([
      "Project",
      "Issue type",
      "Summary",
      "Description",
    ]);
  });
});

for (const type of ISSUE_TYPES) {
  test.describe(`Creating a ${ISSUE_TYPE_LABEL[type]}`, () => {
    test("persists that exact type, with its title and description", async ({
      page,
    }) => {
      const title = `Type check ${ISSUE_TYPE_LABEL[type]} ${stamp()}`;
      const description = `Filed as a ${ISSUE_TYPE_LABEL[type]} by the suite.`;

      const dialog = await openCreate(page);
      await dialog
        .getByLabel("Issue type")
        .selectOption({ label: ISSUE_TYPE_LABEL[type] });
      await dialog
        .getByLabel("Project")
        .selectOption({ label: "Engineering (ENG)" });
      await dialog.getByLabel("Summary").fill(title);
      await dialog.getByLabel("Description").fill(description);

      /* The submit button names what it will create, which is how the dialog
         says out loud which type it is about to file. */
      const submit = dialog.getByRole("button", {
        name: new RegExp(`^create ${ISSUE_TYPE_LABEL[type]}$`, "i"),
      });
      await expect(submit).toBeVisible();
      await submit.click();

      // Lands on the new issue's own page.
      await page.waitForURL(/\/issues\/eng-\d+$/, { timeout: 30_000 });

      const issue = await prisma.issue.findFirstOrThrow({
        where: { title },
        select: {
          id: true,
          key: true,
          type: true,
          description: true,
          project: { select: { key: true } },
        },
      });
      created.push(issue.id);

      // The canonical enum value, not a label.
      expect(issue.type).toBe(type);
      expect(issue.description).toBe(description);
      expect(issue.project.key).toBe("ENG");

      // And the detail page, reloaded from the server, agrees.
      await page.reload();
      await expect(page.getByText(title).first()).toBeVisible();
    });
  });
}

test.describe("The Create dialog still creates for other entry points", () => {
  test("a project's own Create keeps working and preselects that project", async ({
    page,
  }) => {
    const title = `Project entry ${stamp()}`;

    await page.goto("/projects/eng/list");
    await page.locator(".prio-create__main").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // Arriving from a project preselects it; the type control is still there.
    await expect(dialog.getByLabel("Project")).toHaveValue(
      (await prisma.project.findUniqueOrThrow({
        where: { key: "ENG" },
        select: { id: true },
      })).id,
    );

    await dialog.getByLabel("Issue type").selectOption({ label: "Task" });
    await dialog.getByLabel("Summary").fill(title);
    await dialog.getByRole("button", { name: /^create task$/i }).click();

    await page.waitForURL(/\/issues\/eng-\d+$/, { timeout: 30_000 });
    const issue = await prisma.issue.findFirstOrThrow({
      where: { title },
      select: { id: true, type: true, project: { select: { key: true } } },
    });
    created.push(issue.id);
    expect(issue.type).toBe("TASK");
    expect(issue.project.key).toBe("ENG");
  });
});
