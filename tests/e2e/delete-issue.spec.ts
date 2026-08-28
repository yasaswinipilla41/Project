import { expect, test, type Page } from "@playwright/test";
import { MEMBER_STATE, watchForProblems } from "./support";

/**
 * Deleting an issue, in the browser.
 *
 * `deleteIssue` did not exist before this change — creating, editing,
 * assigning and changing status all had real end-to-end paths, but there was
 * no way to remove an issue at all. These tests exercise the two places that
 * now offer it (the table row menu and the issue's own page) and, just as
 * importantly, confirm the option is simply absent for someone who is not
 * allowed to use it — not present-but-disabled, not hidden-but-reachable.
 */

const stamp = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

/** Creates a real task as the signed-in user and returns its key. */
async function createTask(page: Page, title: string): Promise<string> {
  await page.goto("/");
  await page.locator(".prio-create__main").click();

  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Project").selectOption({ label: "Engineering (ENG)" });
  await dialog.getByLabel("Task title").fill(title);
  await dialog.getByRole("button", { name: /^create task$/i }).click();

  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/issues\/eng-\d+$/i);

  const url = page.url();
  return url.split("/").pop()!.toUpperCase();
}

test.describe("Deleting from the issue table", () => {
  test("the reporter can delete their own issue from its row menu", async ({
    page,
  }) => {
    const { consoleErrors, failedRequests } = watchForProblems(page);
    const title = `Row-delete fixture ${stamp()}`;
    const key = await createTask(page, title);

    await page.goto("/issues?q=" + encodeURIComponent(title));
    const row = page.locator("tr", { hasText: title });
    await expect(row).toBeVisible();

    await row.getByRole("button", { name: `Actions for ${key}` }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(/permanently removes it/i);

    await dialog.getByRole("button", { name: "Delete issue" }).click();
    await expect(dialog).toBeHidden();

    // The row is gone from the list without a full reload being required.
    await expect(page.locator("tr", { hasText: title })).toHaveCount(0);

    // And it is genuinely gone, not just filtered out client-side.
    await page.goto(`/issues/${key.toLowerCase()}`);
    await expect(page.locator(".prio-notfound")).toBeVisible();

    expect(consoleErrors).toEqual([]);
    expect(
      failedRequests.filter((f) => !f.includes(`/issues/${key.toLowerCase()}`)),
    ).toEqual([]);
  });

  test("Cancel leaves the issue exactly as it was", async ({ page }) => {
    const title = `Cancel-delete fixture ${stamp()}`;
    await createTask(page, title);

    await page.goto("/issues?q=" + encodeURIComponent(title));
    const row = page.locator("tr", { hasText: title });
    await row.getByRole("button", { name: /^Actions for/ }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();

    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();

    await page.reload();
    await expect(page.locator("tr", { hasText: title })).toBeVisible();
  });

  test("a member with no reporter/admin claim sees no Delete option", async ({
    browser,
  }) => {
    // Reported by the administrator.
    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    const title = `No-delete-for-others ${stamp()}`;
    const key = await createTask(adminPage, title);
    await adminContext.close();

    const memberContext = await browser.newContext({ storageState: MEMBER_STATE });
    const memberPage = await memberContext.newPage();

    await memberPage.goto("/issues?q=" + encodeURIComponent(title));
    const row = memberPage.locator("tr", { hasText: title });
    await expect(row).toBeVisible();

    await row.getByRole("button", { name: `Actions for ${key}` }).click();
    await expect(memberPage.getByRole("menuitem", { name: "Delete" })).toHaveCount(0);
    // Open/edit is still there — reading and editing are not restricted.
    await expect(
      memberPage.getByRole("menuitem", { name: "Open / edit" }),
    ).toBeVisible();

    await memberContext.close();
  });
});

test.describe("Deleting from the issue's own page", () => {
  test("shows a Delete control to the reporter and it works", async ({
    page,
  }) => {
    const title = `Detail-delete fixture ${stamp()}`;
    const key = await createTask(page, title);

    await expect(
      page.getByRole("button", { name: "Delete issue" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Delete issue" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Delete issue" }).click();

    // Sent back to the project, since the issue it was looking at is gone.
    await expect(page).toHaveURL(/\/projects\/eng$/, { timeout: 15_000 });

    await page.goto(`/issues/${key.toLowerCase()}`);
    await expect(page.locator(".prio-notfound")).toBeVisible();
  });

  test("offers no Delete control to a member who did not report it", async ({
    browser,
  }) => {
    const adminContext = await browser.newContext();
    const adminPage = await adminContext.newPage();
    const key = await createTask(adminPage, `No-detail-delete ${stamp()}`);
    await adminContext.close();

    const memberContext = await browser.newContext({ storageState: MEMBER_STATE });
    const memberPage = await memberContext.newPage();
    await memberPage.goto(`/issues/${key.toLowerCase()}`);

    await expect(
      memberPage.getByRole("button", { name: "Delete issue" }),
    ).toHaveCount(0);

    // Everything else about the page still works — this is a permission
    // boundary, not a broken page.
    await expect(memberPage.getByRole("heading", { name: "Activity" })).toBeVisible();

    await memberContext.close();
  });
});
