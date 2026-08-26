import { expect, test, type Page } from "@playwright/test";
import { waitForNextFrame, watchForProblems } from "./support";

/**
 * Screenshot attachments on every Create flow (§ Create-flow screenshots).
 *
 * Covers the whole path: pick an image, edit it (draw, crop, undo/redo),
 * save the edit, submit the form, and see the final attachment on the
 * resulting detail page — including after a reload, which is what proves it
 * was actually persisted and not just held in memory.
 */

/** A real, tiny PNG — the server sniffs magic bytes, so this has to be genuine. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFUlEQVR4nGP8z8DwnwEJMDEQCXAAADuIA/9LWl2XAAAAAElFTkSuQmCC";

async function attachScreenshot(page: Page) {
  // Exact match: a loose "Screenshot" substring also matches each attached
  // thumbnail's "Open screenshot N in a new tab" link once one exists.
  const input = page.getByLabel("Screenshots", { exact: true });
  await input.setInputFiles({
    name: "screenshot.png",
    mimeType: "image/png",
    buffer: Buffer.from(PNG_BASE64, "base64"),
  });
}

test.describe("Screenshot attachments in Create flows", () => {
  test("Create Task: attach, edit, save, submit, and it persists on the issue page", async ({
    page,
  }) => {
    const { consoleErrors, failedRequests } = watchForProblems(page);
    const title = `Screenshot task ${Date.now()}`;

    await page.goto("/");
    await page.locator(".prio-create__main").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    await dialog.getByLabel("Project").selectOption({ label: "Engineering (ENG)" });
    await dialog.getByLabel("Title").fill(title);

    await attachScreenshot(page);

    // A preview with Edit/Remove replaces the empty dropzone.
    await expect(dialog.getByRole("button", { name: "Edit" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Remove" })).toBeVisible();

    await dialog.getByRole("button", { name: "Edit" }).click();

    const editor = page.getByRole("dialog", { name: "Edit screenshot" });
    await expect(editor).toBeVisible();
    // The image decodes asynchronously; drawing before it's ready is a no-op.
    await expect(editor.getByText("Loading image…")).toBeHidden();
    await waitForNextFrame(page);

    const annotationCanvas = editor.locator("canvas").nth(1);
    const box = await annotationCanvas.boundingBox();
    if (!box) throw new Error("Canvas has no bounding box.");

    // Draw a freehand stroke with the default Pen tool.
    await page.mouse.move(box.x + 2, box.y + 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 2, box.y + box.height - 2, {
      steps: 5,
    });
    await page.mouse.up();

    // Undo/Redo become available once there is something to step through.
    const undo = editor.getByRole("button", { name: "Undo" });
    const redo = editor.getByRole("button", { name: "Redo" });
    await expect(undo).toBeEnabled();
    await expect(redo).toBeDisabled();
    await undo.click();
    await expect(redo).toBeEnabled();
    await redo.click();

    // Draw a rectangle too, to exercise a second tool before saving.
    const rectButton = editor.getByRole("button", { name: "Rectangle" });
    await rectButton.click();
    await expect(rectButton).toHaveAttribute("data-active", "true");
    await waitForNextFrame(page);
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7, {
      steps: 5,
    });
    await page.mouse.up();

    await editor.getByRole("button", { name: "Save" }).click();
    await expect(editor).toBeHidden();

    // Back on the Create form, the edited image is still staged.
    await expect(dialog.getByRole("button", { name: "Edit" })).toBeVisible();

    await dialog.getByRole("button", { name: /^create task$/i }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/issues\/eng-\d+$/i);
    await expect(page.getByRole("heading", { name: title })).toBeVisible();

    // The attachment made it onto the real, server-rendered issue.
    const attachment = page.locator(".prio-attachment").first();
    await expect(attachment).toBeVisible();
    await expect(attachment.locator("img")).toBeVisible();

    // Reload: this only stays true if the file was actually persisted server-side.
    await page.reload();
    await expect(page.locator(".prio-attachment img").first()).toBeVisible();

    expect(consoleErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
  });

  test("Create Task: multiple screenshots can be added and individually removed", async ({
    page,
  }) => {
    await page.goto("/");
    await page.locator(".prio-create__main").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    await attachScreenshot(page);
    await expect(dialog.getByRole("button", { name: "Remove" })).toHaveCount(1);

    // Adding again keeps the first and stages a second alongside it.
    await attachScreenshot(page);
    await expect(dialog.getByRole("button", { name: "Edit" })).toHaveCount(2);
    await expect(dialog.getByRole("button", { name: "Remove" })).toHaveCount(2);

    // Removing one leaves the other staged, not the empty dropzone.
    await dialog.getByRole("button", { name: "Remove" }).first().click();
    await expect(dialog.getByRole("button", { name: "Edit" })).toHaveCount(1);

    // Removing the last one returns to the empty dropzone.
    await dialog.getByRole("button", { name: "Remove" }).click();
    await expect(dialog.getByRole("button", { name: "Add screenshots" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Edit" })).toHaveCount(0);
  });

  test("Create Project: attaches a screenshot that appears on the project page", async ({
    page,
  }) => {
    const { consoleErrors, failedRequests } = watchForProblems(page);
    const name = `Screenshot project ${Date.now()}`;
    // The key auto-suggested from the name is not guaranteed unique across
    // runs (e.g. every current epoch timestamp starts with the digit "1"),
    // so it is set explicitly here rather than left to the suggestion.
    const key = `SC${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

    await page.goto("/projects");
    await page.getByRole("button", { name: "New project" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    await dialog.getByLabel("Project name").fill(name);
    await dialog.getByLabel("Project key").fill(key);
    await attachScreenshot(page);
    await expect(dialog.getByRole("button", { name: "Edit" })).toBeVisible();

    await dialog.getByRole("button", { name: "Create project" }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/projects\/[a-z0-9]+$/i);
    await expect(page.getByRole("heading", { name })).toBeVisible();

    const attachment = page.locator(".prio-attachment").first();
    await expect(attachment).toBeVisible();
    await expect(attachment.locator("img")).toBeVisible();

    await page.reload();
    await expect(page.locator(".prio-attachment img").first()).toBeVisible();

    expect(consoleErrors).toEqual([]);
    expect(failedRequests).toEqual([]);
  });
});
