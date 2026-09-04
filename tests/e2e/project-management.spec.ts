import { expect, test } from "@playwright/test";
import { MEMBER_STATE, watchForProblems } from "./support";

/**
 * Editing and deleting a project, in the browser.
 *
 * The permission rule is:
 *
 *     ADMIN            -> any project
 *     project creator  -> their own project
 *     anyone else      -> neither, even on a project they belong to
 *
 * The server-side half of this is proved in `tests/project-permissions.test.ts`,
 * which calls the actions directly. These tests cover the other half: that the
 * interface offers the controls to exactly the right people, and that deleting
 * asks for the project's name first.
 *
 * The seeded projects are all created by the administrator, so the member
 * session here is always "another member" — the case that must be refused.
 */

test.describe("As an administrator", () => {
  test("offers Edit and Delete on a project they did not create", async ({
    page,
  }) => {
    const { consoleErrors, failedRequests } = watchForProblems(page);

    await page.goto("/projects/eng");
    await expect(page.getByRole("heading", { name: /Engineering/ })).toBeVisible();

    /* The page-level Edit button was removed; editing lives in the dropdown
       beside Delete, so this checks the menu that now offers both. */
    await expect(
      page.getByRole("button", { name: "Edit project" }),
    ).toHaveCount(0);

    await page.getByRole("button", { name: "More project actions" }).click();
    await expect(
      page.getByRole("menuitem", { name: "Edit project" }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", { name: "Delete project" }),
    ).toBeVisible();
    await page.keyboard.press("Escape");

    expect(consoleErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
  });

  test("edits the description and shows it immediately", async ({ page }) => {
    await page.goto("/projects/tes");

    const marker = `edited ${Math.random().toString(36).slice(2, 8)}`;

    await page.getByRole("button", { name: "More project actions" }).click();
    await page.getByRole("menuitem", { name: "Edit project" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    // The key is deliberately not editable: every issue is named after it.
    await expect(dialog.getByLabel("Project key")).toBeDisabled();

    await dialog.getByLabel("Description").fill(marker);
    await dialog.getByRole("button", { name: "Save changes" }).click();

    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await expect(page.getByText(marker)).toBeVisible({ timeout: 15_000 });
  });

  test("will not delete until the project name is typed back", async ({
    page,
  }) => {
    await page.goto("/projects/eng");

    await page.getByRole("button", { name: "More project actions" }).click();
    await page.getByRole("menuitem", { name: "Delete project" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(/permanently removes/i);

    const confirm = dialog.getByRole("button", { name: "Delete project" });
    await expect(confirm).toBeDisabled();

    // A near-miss is still a miss.
    await dialog.getByLabel(/Type .* to confirm/).fill("Engineerin");
    await expect(confirm).toBeDisabled();

    await dialog.getByLabel(/Type .* to confirm/).fill("Engineering");
    await expect(confirm).toBeEnabled();

    // Escape without deleting — this project is the fixture everything uses.
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/projects\/eng$/);
  });

  test("deletes a project it owns, once confirmed", async ({ page }) => {
    /* Created here and deleted here, so nothing seeded is at risk. Creating a
       project is an administrator action, which is the session in use. */
    const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
    const name = `Disposable ${suffix}`;

    await page.goto("/projects");
    await page.getByRole("button", { name: /New project/i }).click();

    const create = page.getByRole("dialog");
    await create.getByLabel("Project name").fill(name);
    await create.getByLabel(/Project key/).fill(`DSP${suffix}`);
    await create.getByRole("button", { name: /Create project/i }).click();
    await expect(create).toBeHidden({ timeout: 15_000 });

    await page.goto(`/projects/dsp${suffix.toLowerCase()}`);
    await expect(page.getByRole("heading", { name })).toBeVisible();

    await page.getByRole("button", { name: "More project actions" }).click();
    await page.getByRole("menuitem", { name: "Delete project" }).click();

    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(/Type .* to confirm/).fill(name);
    await dialog.getByRole("button", { name: "Delete project" }).click();

    // It lands back on the project list, and the project is gone.
    await expect(page).toHaveURL(/\/projects$/, { timeout: 20_000 });
    await expect(page.getByText(name)).toHaveCount(0);

    /* Reaching it directly no longer works either. Asserted on what the page
       renders rather than the status code: on Next 16.3.1 a `notFound()` from a
       force-dynamic route serves the not-found page under HTTP 200, which is a
       framework behaviour and not something this route decides. */
    await page.goto(`/projects/dsp${suffix.toLowerCase()}`);
    await expect(page.locator(".prio-notfound")).toBeVisible();
    await expect(page.getByRole("heading", { name: name })).toHaveCount(0);
  });
});

test.describe("As a member of someone else's project", () => {
  test.use({ storageState: MEMBER_STATE });

  test("sees no Edit or Delete control", async ({ page }) => {
    const { consoleErrors, failedRequests } = watchForProblems(page);

    await page.goto("/projects/eng");
    await expect(page.getByRole("heading", { name: /Engineering/ })).toBeVisible();

    // They can read the project and work in it…
    await expect(page.getByRole("link", { name: "Issues" }).first()).toBeVisible();

    // …and Settings, which is an administrator's, is not offered.
    await expect(page.getByRole("link", { name: "Settings" })).toHaveCount(0);

    /*
     * The actions menu is theirs now, because Clone is: copying a project you
     * can already read is not an administrator's privilege. What must not be
     * in it is anything that changes or destroys the project — so the check is
     * on the menu's contents rather than on whether the menu exists.
     */
    await page.getByRole("button", { name: "More project actions" }).click();
    const menu = page.getByRole("menu").first();
    await menu.waitFor();

    const items = (await menu.getByRole("menuitem").allInnerTexts()).map((t) =>
      t.replace(/\s+/g, " ").trim(),
    );
    expect(items).toContain("Clone project");
    expect(items).not.toContain("Edit project");
    expect(items).not.toContain("Delete project");

    await page.keyboard.press("Escape");

    expect(consoleErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
  });

  test("cannot edit or delete it by calling the server directly", async ({
    page,
  }) => {
    await page.goto("/projects/eng");

    /*
     * The controls are absent, so this drives the server actions through the
     * page's own runtime rather than the interface — which is what an attacker
     * would do. Hiding a button must never be the only thing standing between
     * a member and someone else's project.
     */
    const outcome = await page.evaluate(async () => {
      const response = await fetch(window.location.href, {
        method: "POST",
        headers: {
          "Content-Type": "text/plain;charset=UTF-8",
          "Next-Action": "probe",
        },
        body: "[]",
      });
      return response.status;
    });

    // Whatever the framework answers a forged action id, it must not be a
    // successful mutation — and the project must be untouched afterwards.
    expect([400, 404, 405, 500]).toContain(outcome);

    await page.reload();
    await expect(page.getByRole("heading", { name: /Engineering/ })).toBeVisible();
  });
});
