import { expect, test, type Page } from "@playwright/test";
import { prisma } from "@/lib/prisma";
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

  test("creates a Bug from a title alone, though it now offers more", async ({
    page,
  }) => {
    /*
     * A bug used to be *rejected* without a description. The reproduction,
     * expected and actual prompts have since come back — but as prompts, not
     * demands: the Bug form asks a tester the questions a tester should be
     * asked, and none of them block creation. That distinction is the whole
     * point of this test, so it checks both halves: the fields are there, and
     * a title on its own is still enough.
     */
    const title = `Title-only bug ${stamp()}`;
    const dialog = await openCreate(page, "Bug");

    for (const offered of [
      "Steps to reproduce",
      "Expected behaviour",
      "Actual behaviour",
    ]) {
      const field = dialog.getByLabel(offered);
      await expect(field).toHaveCount(1);
      await expect(field).not.toHaveAttribute("required", /.*/);
    }

    await dialog.getByLabel("Project").selectOption({ label: "Engineering (ENG)" });
    await dialog.getByLabel("Bug title").fill(title);
    await dialog.getByRole("button", { name: /^create bug$/i }).click();

    // It is created rather than refused, and lands on its own page.
    await expect(page).toHaveURL(/\/issues\/eng-\d+$/);
    await expect(page.locator("h1.prio-issue__title")).toHaveText(title);

    // This test now creates a real row, so it removes it again.
    await prisma.issue.deleteMany({ where: { title } });
  });

  test("cancel closes the dialog and creates nothing", async ({ page }) => {
    const title = `Cancelled task ${stamp()}`;
    const dialog = await openCreate(page, "Task");

    await dialog.getByLabel("Project").selectOption({ label: "Engineering (ENG)" });
    await dialog.getByLabel("Task title").fill(title);
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
    await dialog.getByLabel("Task title").fill(title);
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

  test("creates a real Bug, offering the tester prompts but demanding none", async ({
    page,
  }) => {
    const { consoleErrors, failedRequests } = watchForProblems(page);
    const title = `E2E bug ${stamp()}`;
    const dialog = await openCreate(page, "Bug");

    /*
     * The Bug form asks a tester what a tester should be asked — reproduction,
     * expected and actual behaviour, and the environment it happened in. What
     * did *not* come back is the old "Bug details" panel and its long tail of
     * browser/OS/build/module inputs, which asked for far more than anyone
     * filled in. Both halves are pinned here: what the form offers now, and
     * what deliberately stays gone.
     */
    for (const offered of [
      "Steps to reproduce",
      "Expected behaviour",
      "Actual behaviour",
      "Environment",
    ]) {
      await expect(dialog.getByLabel(offered)).toHaveCount(1);
    }

    await expect(dialog.getByText("Bug details")).toHaveCount(0);
    for (const gone of [
      "Expected result",
      "Actual result",
      "Browser",
      "Operating system",
      "Version / build",
      "Affected module",
    ]) {
      await expect(dialog.getByLabel(gone)).toHaveCount(0);
    }

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

  test("a bug recorded before the change keeps its data, but no longer displays the retired fields", async ({
    page,
  }) => {
    /*
     * Retiring the fields is a change to the *experience*, not a data
     * deletion. ENG-1 was reported when reproduction steps were mandatory, so
     * it is the row that proves both halves at once: the columns still hold
     * what was captured, while the page that used to render them no longer
     * does.
     */
    const stored = await prisma.issue.findUniqueOrThrow({
      where: { key: "ENG-1" },
      select: {
        stepsToReproduce: true,
        expectedResult: true,
        actualResult: true,
      },
    });

    // The history is still there, untouched.
    expect(stored.stepsToReproduce).toBeTruthy();
    expect(stored.expectedResult).toBeTruthy();
    expect(stored.actualResult).toBeTruthy();

    await page.goto("/issues/eng-1");

    // ...and the issue still renders, minus those three sections. The page's
    // heading is the issue title; the key sits beside it in the breadcrumb.
    await expect(page.locator("h1.prio-issue__title")).toBeVisible();
    await expect(page.locator(".prio-key", { hasText: "ENG-1" }).first()).toBeVisible();
    for (const heading of [
      "Steps to reproduce",
      "Expected result",
      "Actual result",
    ]) {
      await expect(page.getByRole("heading", { name: heading })).toHaveCount(0);
    }
  });

  test("severity belongs to bugs, and starts unset", async ({ page }) => {
    /* Severity is the impact of a defect, so the Create flow asks for it only
       where it means something. A Task is not asked; a Bug is, and still
       defaults to unset so an untouched bug stores no severity. */
    const taskDialog = await openCreate(page, "Task");
    await expect(taskDialog.getByLabel("Severity")).toHaveCount(0);
    await expect(taskDialog.getByLabel("Steps to reproduce")).toHaveCount(0);
    await page.keyboard.press("Escape");

    const bugDialog = await openCreate(page, "Bug");
    const severity = bugDialog.getByLabel("Severity");
    await expect(severity).toBeVisible();
    await expect(severity).toHaveValue("");

    // Choosing one is possible, and sticks.
    await severity.selectOption("MAJOR");
    await expect(severity).toHaveValue("MAJOR");
  });
});
