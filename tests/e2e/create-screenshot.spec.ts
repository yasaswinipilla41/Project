import { expect, test, type Locator, type Page } from "@playwright/test";
import { prisma } from "@/lib/prisma";
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

/**
 * The field is labelled "Attachments" on every form now — it takes documents
 * and video, not only screenshots, and one term across the app says so. Exact
 * match, because a loose one would also catch each attached thumbnail's own
 * link once one exists.
 */
/**
 * The editor's canvas sizes itself from the decoded image — `width: 100%`
 * plus an aspect-ratio, capped at the image's natural width — so its box is
 * still settling for a frame or two after the editor reports ready. Measuring
 * mid-settle yields coordinates that no longer describe the element, and a
 * pointerdown landing outside it never starts a stroke. That is exactly how
 * this test failed intermittently under full-suite load while passing on its
 * own. Waiting for two consecutive identical boxes removes the race without
 * loosening anything the test asserts.
 */
async function settledBox(page: Page, canvas: Locator) {
  let previous = await canvas.boundingBox();
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await waitForNextFrame(page);
    const current = await canvas.boundingBox();
    if (
      previous &&
      current &&
      current.width > 0 &&
      current.height > 0 &&
      current.x === previous.x &&
      current.y === previous.y &&
      current.width === previous.width &&
      current.height === previous.height
    ) {
      return current;
    }
    previous = current;
  }
  throw new Error("The canvas box never settled.");
}

async function attachScreenshot(page: Page, label = "Attachments") {
  const input = page.getByLabel(label, { exact: true });
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
    await dialog.getByLabel("Summary").fill(title);

    await attachScreenshot(page);

    // A preview with Edit/Remove replaces the empty dropzone.
    await expect(dialog.getByRole("button", { name: /Annotate|Edit markup/ })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Remove" })).toBeVisible();

    await dialog.getByRole("button", { name: /Annotate|Edit markup/ }).click();

    const editor = page.getByRole("dialog", { name: "Edit screenshot" });
    await expect(editor).toBeVisible();
    // The image decodes asynchronously; drawing before it's ready is a no-op.
    await expect(editor.getByText("Loading image…")).toBeHidden();
    /* That text also disappears when the image FAILS to load, which
       leaves the editor not ready and every stroke a silent no-op.
       The canvas is hidden until it really is ready, so this is the
       signal that means "you can draw now". */
    await expect(editor.locator("canvas").first()).toBeVisible();
    await waitForNextFrame(page);

    const annotationCanvas = editor.locator("canvas").nth(1);
    const box = await settledBox(page, annotationCanvas);

    // Draw a freehand stroke with the default Pen tool. Well inside the
    // canvas rather than two pixels off its corner, so a sub-pixel layout
    // difference cannot put the press outside the element.
    await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.1);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.9, box.y + box.height * 0.9, {
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
    await expect(dialog.getByRole("button", { name: /Annotate|Edit markup/ })).toBeVisible();

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
    await expect(dialog.getByRole("button", { name: /Annotate|Edit markup/ })).toHaveCount(2);
    await expect(dialog.getByRole("button", { name: "Remove" })).toHaveCount(2);

    // Removing one leaves the other staged, not the empty dropzone.
    await dialog.getByRole("button", { name: "Remove" }).first().click();
    await expect(dialog.getByRole("button", { name: /Annotate|Edit markup/ })).toHaveCount(1);

    // Removing the last one returns to the empty dropzone.
    await dialog.getByRole("button", { name: "Remove" }).click();
    /* "Add attachments" now: the field takes documents and video, not only
       screenshots, and the wording says so. */
    await expect(
      dialog.getByRole("button", { name: "Add attachments" }),
    ).toBeVisible();
    await expect(dialog.getByRole("button", { name: /Annotate|Edit markup/ })).toHaveCount(0);
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

    /*
     * The project this creates is scaffolding, not a fixture — nothing else
     * refers to it, and every run would otherwise leave another one behind.
     * Eighteen had accumulated on the Projects page before this cleanup
     * existed. `finally`, because a run that fails half way through is
     * exactly the run most likely to leave a project standing.
     */
    try {
      await page.goto("/projects");
      await page.getByRole("button", { name: "New project" }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();

      await dialog.getByLabel("Project name").fill(name);
      await dialog.getByLabel("Project key").fill(key);
      await attachScreenshot(page, "Attachments");
      await expect(
        dialog.getByRole("button", { name: /Annotate|Edit markup/ }),
      ).toBeVisible();

      await dialog.getByRole("button", { name: "Create project" }).click();
      await expect(dialog).toBeHidden();
      /* On the new project — the dialog pushes its base path, which redirects
         into the workspace, so both spellings mean the same page. */
      await expect(page).toHaveURL(/\/projects\/[a-z0-9]+(\/summary)?$/i);
      await expect(page.getByRole("heading", { name })).toBeVisible();

      const attachment = page.locator(".prio-attachment").first();
      await expect(attachment).toBeVisible();
      await expect(attachment.locator("img")).toBeVisible();

      await page.reload();
      await expect(page.locator(".prio-attachment img").first()).toBeVisible();

      expect(consoleErrors).toEqual([]);
      expect(failedRequests).toEqual([]);
    } finally {
      // Cascades to the project's members, labels and the staged attachment.
      await prisma.project.deleteMany({ where: { key } });
    }
  });
});
