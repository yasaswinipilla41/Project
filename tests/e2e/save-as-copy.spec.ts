import { expect, test, type Locator, type Page } from "@playwright/test";
import { waitForNextFrame, watchForProblems } from "./support";

/**
 * Save, and Save as copy (§ Attachments).
 *
 * Editing a screenshot nearly always means the screenshot was wrong and this
 * is what it should have been, so Save writes over it and the panel keeps one
 * row. Occasionally the opposite is true: the plain capture is the evidence
 * and the arrows are the explanation, and a defect report is worse for having
 * lost either. Save as copy is that case, and these hold the difference — one
 * button leaves one attachment with new bytes, the other leaves two, with the
 * first exactly as it was.
 */

/** A real, tiny PNG — the server sniffs magic bytes, so this has to be genuine. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFUlEQVR4nGP8z8DwnwEJMDEQCXAAADuIA/9LWl2XAAAAAElFTkSuQmCC";
const PNG_BYTES = Buffer.from(PNG_BASE64, "base64");

/** Every attachment on the page, with the bytes actually served for it. */
async function attachmentFiles(page: Page) {
  return page.evaluate(async () => {
    const links = [
      ...document.querySelectorAll<HTMLAnchorElement>(".prio-attachment__name"),
    ];
    return Promise.all(
      links.map(async (link) => {
        const response = await fetch(link.href);
        return {
          name: (link.textContent ?? "").trim(),
          size: (await response.blob()).size,
        };
      }),
    );
  });
}

/** Draws a stroke across the middle of the editor's annotation canvas. */
async function scribble(page: Page, editor: Locator) {
  await expect(editor.getByText("Loading image…")).toBeHidden();
  await expect(editor.locator("canvas").first()).toBeVisible();
  await waitForNextFrame(page);

  await editor.getByRole("button", { name: "Draw", exact: true }).click();
  const box = await editor.locator("canvas").nth(1).boundingBox();
  if (!box) throw new Error("Canvas has no bounding box.");

  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.75, box.y + box.height * 0.5, {
    steps: 6,
  });
  await page.mouse.up();
}

/** Creates an ENG issue carrying one screenshot, and lands on its page. */
async function issueWithScreenshot(page: Page, title: string) {
  await page.goto("/");
  await page.locator(".prio-create__main").click();

  const dialog = page.getByRole("dialog", { name: /create/i });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Project").selectOption({ label: "Engineering (ENG)" });
  await dialog.getByLabel("Summary").fill(title);

  await page.getByLabel("Attachments", { exact: true }).setInputFiles({
    name: "evidence.png",
    mimeType: "image/png",
    buffer: PNG_BYTES,
  });
  await expect(
    dialog.getByRole("button", { name: /Annotate|Edit markup/ }),
  ).toBeVisible();

  await dialog
    .getByRole("button", { name: /^create (issue|task|bug|story|epic|feature)$/i })
    .click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/issues\/eng-\d+/i);
}

test.describe("Editing a screenshot that is already attached", () => {
  test("Save writes over it, leaving one attachment", async ({ page }) => {
    const { consoleErrors } = watchForProblems(page);
    await issueWithScreenshot(page, `Save in place ${Date.now()}`);

    await expect(page.locator(".prio-attachment")).toHaveCount(1);
    const before = await attachmentFiles(page);
    expect(before[0]!.size).toBe(PNG_BYTES.length);

    await page.getByRole("button", { name: /^Annotate evidence/ }).click();
    const editor = page.getByRole("dialog", { name: "Edit screenshot" });
    await scribble(page, editor);
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor).toBeHidden();

    // Still one row, same name, different bytes.
    await expect(page.locator(".prio-attachment")).toHaveCount(1);
    await expect
      .poll(async () => (await attachmentFiles(page))[0]?.size)
      .not.toBe(PNG_BYTES.length);

    const after = await attachmentFiles(page);
    expect(after).toHaveLength(1);
    expect(after[0]!.name).toBe(before[0]!.name);

    await page.reload();
    expect((await attachmentFiles(page))[0]!.size).toBe(after[0]!.size);
    expect(consoleErrors).toEqual([]);
  });

  test("Save as copy adds a second one and leaves the first untouched", async ({
    page,
  }) => {
    const { consoleErrors } = watchForProblems(page);
    await issueWithScreenshot(page, `Save as copy ${Date.now()}`);

    await expect(page.locator(".prio-attachment")).toHaveCount(1);
    const before = await attachmentFiles(page);

    await page.getByRole("button", { name: /^Annotate evidence/ }).click();
    const editor = page.getByRole("dialog", { name: "Edit screenshot" });
    await scribble(page, editor);
    await editor.getByRole("button", { name: "Save as copy" }).click();
    await expect(editor).toBeHidden();

    await expect(page.locator(".prio-attachment")).toHaveCount(2);

    const after = await attachmentFiles(page);
    const original = after.find((file) => file.name === before[0]!.name);
    const copy = after.find((file) => file.name !== before[0]!.name);

    expect(original, "the picture it started from is still there").toBeTruthy();
    expect(
      original!.size,
      "and is byte-identical to what was uploaded",
    ).toBe(PNG_BYTES.length);

    expect(copy, "the marked-up one is beside it").toBeTruthy();
    expect(copy!.name).toContain("annotated");
    expect(copy!.size).not.toBe(PNG_BYTES.length);

    // Both were really stored, not just rendered.
    await page.reload();
    await expect(page.locator(".prio-attachment")).toHaveCount(2);
    expect(consoleErrors).toEqual([]);
  });
});

test.describe("Editing a screenshot before the issue exists", () => {
  test("Save as copy stages a second file and keeps the first", async ({
    page,
  }) => {
    await page.goto("/");
    await page.locator(".prio-create__main").click();

    const dialog = page.getByRole("dialog", { name: /create/i });
    await expect(dialog).toBeVisible();
    await dialog
      .getByLabel("Project")
      .selectOption({ label: "Engineering (ENG)" });

    const title = `Staged copy ${Date.now()}`;
    await dialog.getByLabel("Summary").fill(title);

    await page.getByLabel("Attachments", { exact: true }).setInputFiles({
      name: "evidence.png",
      mimeType: "image/png",
      buffer: PNG_BYTES,
    });
    await expect(dialog.getByRole("button", { name: "Remove" })).toHaveCount(1);

    await dialog.getByRole("button", { name: /Annotate|Edit markup/ }).click();
    const editor = page.getByRole("dialog", { name: "Edit screenshot" });
    await scribble(page, editor);
    await editor.getByRole("button", { name: "Save as copy" }).click();
    await expect(editor).toBeHidden();

    // Two staged rows, and the summary typed earlier is still there.
    await expect(dialog.getByRole("button", { name: "Remove" })).toHaveCount(2);
    await expect(dialog.getByLabel("Summary")).toHaveValue(title);

    await dialog
      .getByRole("button", {
        name: /^create (issue|task|bug|story|epic|feature)$/i,
      })
      .click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/issues\/eng-\d+/i);

    await expect(page.locator(".prio-attachment")).toHaveCount(2);
    const files = await attachmentFiles(page);
    expect(files.some((file) => file.size === PNG_BYTES.length)).toBe(true);
    expect(files.some((file) => file.name.includes("annotated"))).toBe(true);
  });
});

test.describe("The screenshot editor's toolbar", () => {
  test("offers every drawing tool, the colour and width controls, and history", async ({
    page,
  }) => {
    await issueWithScreenshot(page, `Toolbar ${Date.now()}`);
    await page.getByRole("button", { name: /^Annotate evidence/ }).click();

    const editor = page.getByRole("dialog", { name: "Edit screenshot" });
    await expect(editor.locator("canvas").first()).toBeVisible();

    for (const tool of [
      "Draw",
      "Highlight",
      "Rectangle",
      "Oval",
      "Arrow",
      "Line",
      "Text",
      "Blur",
      "Erase",
      "Crop",
    ]) {
      const button = editor.getByRole("button", { name: tool, exact: true });
      await expect(button, `${tool} is offered`).toBeVisible();
      await button.click();
      // The chosen tool says so, rather than leaving it to be guessed.
      await expect(button).toHaveAttribute("data-active", "true");
    }

    await expect(editor.getByLabel("Stroke width")).toBeVisible();
    await expect(editor.getByLabel("Custom color")).toBeVisible();
    await expect(editor.getByRole("button", { name: "Undo" })).toBeVisible();
    await expect(editor.getByRole("button", { name: "Redo" })).toBeVisible();
    await expect(editor.getByRole("button", { name: "Clear all" })).toBeVisible();
    await expect(editor.getByLabel("Zoom in")).toBeVisible();
    await expect(editor.getByLabel("Zoom out")).toBeVisible();
    await expect(editor.getByRole("button", { name: "Fit" })).toBeVisible();

    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(editor).toBeHidden();
  });

  test("Cancel crop puts the picture back the size it was", async ({ page }) => {
    await issueWithScreenshot(page, `Cancel crop ${Date.now()}`);
    await page.getByRole("button", { name: /^Annotate evidence/ }).click();

    const editor = page.getByRole("dialog", { name: "Edit screenshot" });
    await expect(editor.locator("canvas").first()).toBeVisible();
    await waitForNextFrame(page);

    const canvas = editor.locator("canvas").nth(1);
    const size = async () =>
      canvas.evaluate((el: HTMLCanvasElement) => `${el.width}x${el.height}`);
    const before = await size();

    await editor.getByRole("button", { name: "Crop", exact: true }).click();
    const box = await canvas.boundingBox();
    if (!box) throw new Error("Canvas has no bounding box.");
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.8, {
      steps: 6,
    });
    await page.mouse.up();

    // The selection is a proposal until it is applied.
    await expect(editor.getByRole("button", { name: "Cancel crop" })).toBeVisible();
    expect(await size()).toBe(before);

    await editor.getByRole("button", { name: "Cancel crop" }).click();
    expect(await size(), "the image is untouched").toBe(before);

    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
  });
});
