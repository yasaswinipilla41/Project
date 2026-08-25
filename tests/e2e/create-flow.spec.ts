import { expect, test, type Page } from "@playwright/test";
import { watchForProblems } from "./support";

/**
 * The complete creation flow (§9, §51): dialog, validation, persistence,
 * feedback, navigation, and the resulting detail page.
 *
 * Every assertion reads what the server rendered from PostgreSQL — the detail
 * page is a server component, so seeing a field there means the row exists.
 */

/** Unique-per-run titles so repeated runs never collide. */
const stamp = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

async function openCreate(page: Page, type: "Task" | "Bug" | "Story") {
  await page.goto("/");
  await expect(page.locator(".prio-create")).toBeVisible();

  if (type === "Task") {
    await page.locator(".prio-create__main").click();
  } else {
    await page.locator(".prio-create__caret").click();
    await page.getByRole("menuitem", { name: type }).click();
  }

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe("Create flow", () => {
  test("the dialog validates required fields before writing anything", async ({
    page,
  }) => {
    const dialog = await openCreate(page, "Task");

    // Submitting with nothing filled in must not create a row.
    await dialog.getByRole("button", { name: /^create task$/i }).click();

    // The dialog stays open and reports the problem.
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("alert").first()).toBeVisible();
  });

  test("a Bug still has to describe the problem", async ({ page }) => {
    const dialog = await openCreate(page, "Bug");

    // Fill only project + title, deliberately omitting the description.
    await dialog.getByLabel("Project").selectOption({ label: "Engineering (ENG)" });
    await dialog.getByLabel("Bug title").fill(`Incomplete ${stamp()}`);
    await dialog.getByRole("button", { name: /^create bug$/i }).click();

    // The server rule surfaces on the field it belongs to.
    await expect(dialog.getByText("Describe the problem.")).toBeVisible();
    await expect(dialog).toBeVisible();

    /* The reproduction write-up is no longer demanded — those fields were
       removed from creation, so a rule requiring them could never be met. */
    await expect(
      dialog.getByText("List the steps needed to reproduce this."),
    ).toHaveCount(0);
    await expect(dialog.getByText("State what should happen.")).toHaveCount(0);
    await expect(dialog.getByText("State what actually happens.")).toHaveCount(0);
  });

  test("cancel closes the dialog and creates nothing", async ({ page }) => {
    const title = `Cancelled task ${stamp()}`;
    const dialog = await openCreate(page, "Task");

    await dialog.getByLabel("Project").selectOption({ label: "Engineering (ENG)" });
    await dialog.getByLabel("Title").fill(title);
    await dialog.getByRole("button", { name: "Cancel" }).click();

    await expect(dialog).toBeHidden();

    // Nothing was written: the title is not findable anywhere.
    await page.goto("/projects/eng");
    await expect(page.getByText(title)).toHaveCount(0);
  });

  test("creates a real Task and lands on its detail page", async ({ page }) => {
    const { consoleErrors, failedRequests } = watchForProblems(page);
    const title = `E2E task ${stamp()}`;
    const dialog = await openCreate(page, "Task");

    await dialog.getByLabel("Project").selectOption({ label: "Engineering (ENG)" });
    await dialog.getByLabel("Title").fill(title);
    await dialog
      .getByLabel("Description")
      .fill("Created by the Playwright create-flow suite.");
    await dialog.getByLabel("Status").selectOption("TODO");
    await dialog.getByLabel("Priority").selectOption("HIGH");

    // The assignee list is populated from the chosen project's members.
    const assignee = dialog.getByLabel("Assignee");
    await expect(assignee.locator("option")).not.toHaveCount(1);
    await assignee.selectOption({ label: "Priya Nair" });

    // Labels belong to the project and toggle on click.
    const label = dialog.getByRole("button", { name: "backend" });
    await label.click();
    await expect(label).toHaveAttribute("aria-pressed", "true");

    // A parent may be chosen from the project's top-level issues.
    const parent = dialog.getByLabel("Parent issue");
    await expect(parent.locator("option")).not.toHaveCount(1);

    await dialog.getByRole("button", { name: /^create task$/i }).click();

    // Dialog closes, success feedback appears, and we navigate to the issue.
    await expect(dialog).toBeHidden();
    await expect(page.locator(".prio-toast")).toContainText("Created");
    await expect(page).toHaveURL(/\/issues\/eng-\d+$/i);

    // The detail page is server-rendered from PostgreSQL.
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await expect(page.locator(".prio-status").first()).toContainText("Todo");
    await expect(page.locator(".prio-issue__headmeta")).toContainText("High");
    await expect(page.locator(".prio-issue__aside")).toContainText("Priya Nair");
    await expect(page.locator(".prio-label-chip").first()).toContainText("backend");

    // The immutable trail recorded the creation.
    await expect(page.locator(".prio-activity")).toContainText(
      "created this issue",
    );

    // A Task must not show any bug-only section.
    await expect(page.getByText("Steps to reproduce")).toHaveCount(0);
    await expect(page.getByText("Expected result")).toHaveCount(0);

    expect(consoleErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
  });

  test("creates a real Bug — with no reproduction write-up to fill in", async ({
    page,
  }) => {
    const { consoleErrors, failedRequests } = watchForProblems(page);
    const title = `E2E bug ${stamp()}`;
    const dialog = await openCreate(page, "Bug");

    /*
     * The long-form "Bug details" section — steps to reproduce, expected
     * result, actual result and the environment fields — was removed from
     * creation. Nothing of it may remain: not the heading, not the inputs, and
     * not an empty container where it used to sit.
     */
    await expect(dialog.getByText("Bug details")).toHaveCount(0);
    await expect(dialog.getByLabel("Steps to reproduce")).toHaveCount(0);
    await expect(dialog.getByLabel("Expected result")).toHaveCount(0);
    await expect(dialog.getByLabel("Actual result")).toHaveCount(0);
    await expect(dialog.getByLabel("Environment")).toHaveCount(0);
    await expect(dialog.getByLabel("Browser")).toHaveCount(0);
    await expect(dialog.getByLabel("Operating system")).toHaveCount(0);
    await expect(dialog.getByLabel("Version / build")).toHaveCount(0);
    await expect(dialog.getByLabel("Affected module")).toHaveCount(0);

    const sections = dialog.locator(".prio-formsection");
    for (let i = 0; i < (await sections.count()); i += 1) {
      const label = await sections.nth(i).getAttribute("aria-label");
      expect(label).not.toBe("Bug details");
      // No section may be left standing with nothing inside it.
      const box = await sections.nth(i).boundingBox();
      expect(box?.height ?? 0).toBeGreaterThan(20);
    }

    await dialog.getByLabel("Project").selectOption({ label: "Engineering (ENG)" });
    await dialog.getByLabel("Bug title").fill(title);
    await dialog
      .getByLabel("Description")
      .fill("Session cookie is dropped after the tab is idle overnight.");
    await dialog.getByLabel("Severity").selectOption("CRITICAL");
    await dialog.getByLabel("Status").selectOption("TODO");
    await dialog.getByLabel("Priority").selectOption("URGENT");

    await dialog.getByRole("button", { name: /^create bug$/i }).click();

    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/issues\/eng-\d+$/i);
    await expect(page.getByRole("heading", { name: title })).toBeVisible();

    // Severity and priority are shown as separate, differently shaped
    // indicators — they are independent concepts.
    await expect(page.locator(".prio-severity").first()).toHaveAttribute(
      "data-severity",
      "CRITICAL",
    );
    await expect(page.locator(".prio-priority").first()).toHaveAttribute(
      "data-priority",
      "URGENT",
    );

    await expect(page.locator(".prio-activity")).toContainText(
      "reported this bug",
    );

    expect(consoleErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
  });

  test("a bug recorded before the change still shows everything it captured", async ({
    page,
  }) => {
    /*
     * Removing the fields from creation must not erase history. ENG-1 was
     * reported when reproduction steps were mandatory; its write-up has to keep
     * rendering exactly as it did.
     */
    await page.goto("/issues/eng-1");

    await expect(
      page.getByRole("heading", { name: "Steps to reproduce" }),
    ).toBeVisible();
    await expect(page.getByText("Sign in to Prio")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Expected result" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Actual result" }),
    ).toBeVisible();
  });

  test("switching type in the dialog adds and removes severity only", async ({
    page,
  }) => {
    const dialog = await openCreate(page, "Task");

    // Severity belongs to bugs; a task has none.
    await expect(dialog.getByLabel("Severity")).toHaveCount(0);
    await expect(dialog.getByLabel("Steps to reproduce")).toHaveCount(0);

    await dialog.getByRole("button", { name: /^Bug/ }).click();
    await expect(dialog.getByLabel("Severity")).toBeVisible();
    // …and still no reproduction write-up.
    await expect(dialog.getByLabel("Steps to reproduce")).toHaveCount(0);

    await dialog.getByRole("button", { name: /^Story/ }).click();
    await expect(dialog.getByLabel("Severity")).toHaveCount(0);
  });
});
