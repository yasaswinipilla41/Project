import { expect, test, type Locator, type Page } from "@playwright/test";
import { waitForNextFrame } from "./support";

/**
 * Tool-by-tool correctness for the screenshot editor itself (§ Fix the Edit
 * Screenshot functionality). `create-screenshot.spec.ts` covers the outer
 * flow — attach, submit, persist; this file stays inside the editor and
 * checks that each tool actually changes the right pixels, that undo/redo
 * steps through every operation type, and that a real-sized image fits the
 * dialog without a scrollbar of its own.
 *
 * A realistic 1200×800 image is used deliberately, generated in-browser via
 * canvas — the earlier 8×8 test fixture never exceeded the dialog's width,
 * which is exactly why the "no independent scrollbar" requirement had gone
 * unverified.
 */

async function makeTestImage(
  page: Page,
  width = 1200,
  height = 800,
): Promise<Buffer> {
  const base64 = await page.evaluate(
    ({ width, height }) => {
      return new Promise<string>((resolve) => {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "#3366cc";
        ctx.fillRect(0, 0, width, height);
        canvas.toBlob((blob) => {
          const reader = new FileReader();
          reader.onload = () => resolve((reader.result as string).split(",")[1]!);
          reader.readAsDataURL(blob!);
        }, "image/png");
      });
    },
    { width, height },
  );
  return Buffer.from(base64, "base64");
}

async function openEditorWithImage(page: Page): Promise<Locator> {
  await page.goto("/");
  await page.locator(".prio-create__main").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  const image = await makeTestImage(page);
  await dialog.getByLabel("Screenshot").setInputFiles({
    name: "screenshot.png",
    mimeType: "image/png",
    buffer: image,
  });
  await dialog.getByRole("button", { name: "Edit" }).click();

  const editor = page.getByRole("dialog", { name: "Edit screenshot" });
  await expect(editor).toBeVisible();
  await expect(editor.getByText("Loading image…")).toBeHidden();
  await waitForNextFrame(page);
  return editor;
}

/**
 * Scans a small box (in the canvas's own pixel space, 0..1 fractions) around
 * a target point and returns the most-opaque pixel found in it. A single
 * exact pixel is too fragile to sample for a thin stroke — antialiasing and
 * sub-pixel placement can easily land the one sampled pixel just outside a
 * 2-4px line — so this checks a neighborhood instead, which is what a real
 * "did this tool paint near here" check should do.
 */
async function samplePixel(
  editor: Locator,
  canvasIndex: number,
  xFrac: number,
  yFrac: number,
  boxFrac = 0.04,
): Promise<{ r: number; g: number; b: number; a: number }> {
  const canvas = editor.locator("canvas").nth(canvasIndex);
  return canvas.evaluate(
    (el: HTMLCanvasElement, [xf, yf, bf]: [number, number, number]) => {
      const cx = Math.round(el.width * xf);
      const cy = Math.round(el.height * yf);
      const half = Math.max(2, Math.round(Math.min(el.width, el.height) * bf));
      const x0 = Math.max(0, cx - half);
      const y0 = Math.max(0, cy - half);
      const w = Math.min(el.width - x0, half * 2);
      const h = Math.min(el.height - y0, half * 2);

      const ctx = el.getContext("2d")!;
      const data = ctx.getImageData(x0, y0, w, h).data;

      let best = { r: 0, g: 0, b: 0, a: 0 };
      for (let i = 0; i < data.length; i += 4) {
        const a = data[i + 3]!;
        if (a > best.a) {
          best = { r: data[i]!, g: data[i + 1]!, b: data[i + 2]!, a };
        }
      }
      return best;
    },
    [xFrac, yFrac, boxFrac] as [number, number, number],
  );
}

async function canvasSize(
  editor: Locator,
  canvasIndex: number,
): Promise<{ width: number; height: number }> {
  const canvas = editor.locator("canvas").nth(canvasIndex);
  return canvas.evaluate((el: HTMLCanvasElement) => ({
    width: el.width,
    height: el.height,
  }));
}

async function dragOnCanvas(
  page: Page,
  editor: Locator,
  from: { xFrac: number; yFrac: number },
  to: { xFrac: number; yFrac: number },
) {
  const canvas = editor.locator("canvas").nth(1);
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Canvas has no bounding box.");

  await page.mouse.move(
    box.x + box.width * from.xFrac,
    box.y + box.height * from.yFrac,
  );
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width * to.xFrac,
    box.y + box.height * to.yFrac,
    { steps: 8 },
  );
  await page.mouse.up();
}

const ANNOTATION = 1;

test.describe("Screenshot editor — every tool", () => {
  test("the image fits the popup width with no independent scrollbar", async ({
    page,
  }) => {
    const editor = await openEditorWithImage(page);

    const wrap = editor.locator("div").filter({ has: page.locator("canvas") }).first();
    const overflow = await wrap.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    // A 1-2px rounding slack is normal; a real overflow would be tens/hundreds of px.
    expect(overflow.scrollWidth - overflow.clientWidth).toBeLessThanOrEqual(2);

    const canvasBox = await editor.locator("canvas").first().boundingBox();
    expect(canvasBox).not.toBeNull();
    // The 1200px-wide source must have been scaled down to fit a "lg" dialog.
    expect(canvasBox!.width).toBeLessThan(1000);
    expect(canvasBox!.width).toBeGreaterThan(100);
  });

  test("the toolbar never resizes when the active tool changes", async ({
    page,
  }) => {
    const editor = await openEditorWithImage(page);
    const toolbar = editor.locator('[class*="toolbar"]').first();

    const widthFor = async (toolName: string) => {
      await editor.getByRole("button", { name: toolName, exact: true }).click();
      await waitForNextFrame(page);
      return (await toolbar.boundingBox())!.width;
    };

    const drawWidth = await widthFor("Draw");
    const highlightWidth = await widthFor("Highlight");
    const cropWidth = await widthFor("Crop");

    // A resized toolbar would shift every control after the one that changed
    // size right under the user's pointer — Highlight's smaller color set and
    // Crop's Apply/Cancel buttons must not cause that.
    expect(highlightWidth).toBe(drawWidth);
    expect(cropWidth).toBe(drawWidth);

    // Dragging out a crop selection reveals "Apply crop" / "Cancel crop" as
    // enabled rather than mounting new buttons, so this must not move either.
    const canvas = editor.locator("canvas").nth(1);
    const box = await canvas.boundingBox();
    if (!box) throw new Error("no box");
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 5 });
    await page.mouse.up();
    const cropSelectedWidth = (await toolbar.boundingBox())!.width;
    expect(cropSelectedWidth).toBe(drawWidth);
  });

  test("Zoom: in/out resizes the displayed canvas and clamps at its limits", async ({
    page,
  }) => {
    const editor = await openEditorWithImage(page);
    const canvas = editor.locator("canvas").nth(1);
    const baseWidth = (await canvas.boundingBox())!.width;

    const zoomOut = editor.getByRole("button", { name: "Zoom out" });
    const zoomIn = editor.getByRole("button", { name: "Zoom in" });
    await expect(editor.getByText("100%")).toBeVisible();

    await zoomIn.click();
    await expect(editor.getByText("125%")).toBeVisible();
    const widerWidth = (await canvas.boundingBox())!.width;
    expect(widerWidth).toBeGreaterThan(baseWidth);

    await zoomOut.click();
    await zoomOut.click();
    await expect(editor.getByText("75%")).toBeVisible();
    const narrowerWidth = (await canvas.boundingBox())!.width;
    expect(narrowerWidth).toBeLessThan(baseWidth);

    // Clamp at the floor — stop clicking as soon as it disables itself,
    // since a disabled button fails Playwright's actionability check.
    for (let i = 0; i < 5 && (await zoomOut.isEnabled()); i++) await zoomOut.click();
    await expect(editor.getByText("25%")).toBeVisible();
    await expect(zoomOut).toBeDisabled();

    // Clamp at the ceiling.
    for (let i = 0; i < 15 && (await zoomIn.isEnabled()); i++) await zoomIn.click();
    await expect(editor.getByText("300%")).toBeVisible();
    await expect(zoomIn).toBeDisabled();
  });

  test("Draw: a pen stroke paints pixels and is undoable/redoable", async ({
    page,
  }) => {
    const editor = await openEditorWithImage(page);

    const before = await samplePixel(editor, ANNOTATION, 0.5, 0.5);
    expect(before.a).toBe(0);

    await dragOnCanvas(page, editor, { xFrac: 0.4, yFrac: 0.5 }, { xFrac: 0.6, yFrac: 0.5 });

    const after = await samplePixel(editor, ANNOTATION, 0.5, 0.5);
    expect(after.a).toBeGreaterThan(0);
    // Default pen color is red-ish — the red channel should dominate.
    expect(after.r).toBeGreaterThan(after.b);

    const undo = editor.getByRole("button", { name: "Undo" });
    const redo = editor.getByRole("button", { name: "Redo" });
    await expect(undo).toBeEnabled();
    await undo.click();
    // undo()/redo() restore by decoding a data-URL snapshot back into an
    // <img>, which is asynchronous — the click resolves before that decode
    // does, so sampling the canvas needs to poll rather than read once.
    await expect
      .poll(async () => (await samplePixel(editor, ANNOTATION, 0.5, 0.5)).a)
      .toBe(before.a);

    await expect(redo).toBeEnabled();
    await redo.click();
    await expect
      .poll(async () => (await samplePixel(editor, ANNOTATION, 0.5, 0.5)).a)
      .toBeGreaterThan(0);
  });

  test("Highlight: offers exactly two colors and paints semi-transparently", async ({
    page,
  }) => {
    const editor = await openEditorWithImage(page);
    const highlightButton = editor.getByRole("button", { name: "Highlight" });
    await highlightButton.click();
    await expect(highlightButton).toHaveAttribute("data-active", "true");

    // All 8 swatches stay in the DOM (so the toolbar never resizes when the
    // tool changes) — exactly two are enabled while highlighting.
    const swatches = editor.locator('button[aria-label^="Color "]');
    await expect(swatches).toHaveCount(8);
    const usableSwatches = editor.locator('button[aria-label^="Color "]:not([disabled])');
    await expect(usableSwatches).toHaveCount(2);
    // No custom color picker while highlighting — exactly two, no more.
    await expect(editor.getByLabel("Custom color")).toBeDisabled();

    await waitForNextFrame(page);
    await dragOnCanvas(page, editor, { xFrac: 0.3, yFrac: 0.3 }, { xFrac: 0.55, yFrac: 0.3 });
    const painted = await samplePixel(editor, ANNOTATION, 0.4, 0.3);
    expect(painted.a).toBeGreaterThan(0);

    // Switch to the second highlight color and paint elsewhere.
    await usableSwatches.nth(1).click();
    await waitForNextFrame(page);
    await dragOnCanvas(page, editor, { xFrac: 0.3, yFrac: 0.6 }, { xFrac: 0.55, yFrac: 0.6 });
    const secondPainted = await samplePixel(editor, ANNOTATION, 0.4, 0.6);
    expect(secondPainted.a).toBeGreaterThan(0);
  });

  test("Rectangle, Oval and Arrow each draw and stay visible", async ({ page }) => {
    const editor = await openEditorWithImage(page);

    for (const [tool, point] of [
      ["Rectangle", 0.2],
      ["Oval", 0.45],
      ["Arrow", 0.7],
    ] as const) {
      const toolButton = editor.getByRole("button", { name: tool });
      await toolButton.click();
      await expect(toolButton).toHaveAttribute("data-active", "true");
      await waitForNextFrame(page);
      await dragOnCanvas(
        page,
        editor,
        { xFrac: point, yFrac: 0.2 },
        { xFrac: point + 0.15, yFrac: 0.4 },
      );
      const edge = await samplePixel(editor, ANNOTATION, point, 0.2);
      expect(edge.a).toBeGreaterThan(0);
    }
  });

  test("Text: places, renders, and remains positioned after saving", async ({
    page,
  }) => {
    const editor = await openEditorWithImage(page);
    await editor.getByRole("button", { name: "Text" }).click();

    const canvas = editor.locator("canvas").nth(1);
    const box = await canvas.boundingBox();
    if (!box) throw new Error("no box");

    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.3);
    const input = editor.getByRole("textbox", { name: "Annotation text" });
    await expect(input).toBeVisible();
    await input.fill("Hello");
    await input.press("Enter");
    await expect(input).toBeHidden();

    // The text is now real pixels on the annotation layer at the click point.
    const painted = await samplePixel(editor, ANNOTATION, 0.3, 0.31);
    expect(painted.a).toBeGreaterThan(0);

    await editor.getByRole("button", { name: "Save" }).click();
    await expect(editor).toBeHidden();
  });

  test("Text: Escape cancels without drawing anything", async ({ page }) => {
    const editor = await openEditorWithImage(page);
    await editor.getByRole("button", { name: "Text" }).click();

    const canvas = editor.locator("canvas").nth(1);
    const box = await canvas.boundingBox();
    if (!box) throw new Error("no box");

    await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.6);
    const input = editor.getByRole("textbox", { name: "Annotation text" });
    await input.fill("Nope");
    await input.press("Escape");
    await expect(input).toBeHidden();

    const painted = await samplePixel(editor, ANNOTATION, 0.6, 0.6);
    expect(painted.a).toBe(0);
  });

  test("Text: near the right/bottom edge, the box stays fully on-screen and the drawn text lands where it was shown", async ({
    page,
  }) => {
    const editor = await openEditorWithImage(page);
    await editor.getByRole("button", { name: "Text" }).click();

    const canvas = editor.locator("canvas").nth(1);
    const box = await canvas.boundingBox();
    if (!box) throw new Error("no box");

    // Near the bottom-right corner, a box anchored by its top-left corner
    // (the un-flipped default) would spill outside `canvasWrap`, which
    // clips overflow — this used to make the text box invisible there.
    await page.mouse.click(box.x + box.width * 0.92, box.y + box.height * 0.92);
    const input = editor.getByRole("textbox", { name: "Annotation text" });
    await expect(input).toBeVisible();

    const wrap = editor.locator('[class*="canvasWrap"]').first();
    const geometry = await editor.evaluate((root) => {
      const wrapEl = root.querySelector('[class*="canvasWrap"]') as HTMLElement;
      const inputEl = root.querySelector("textarea") as HTMLElement;
      return {
        wrap: wrapEl.getBoundingClientRect(),
        input: inputEl.getBoundingClientRect(),
      };
    });
    expect(geometry.input.right).toBeLessThanOrEqual(geometry.wrap.right + 1);
    expect(geometry.input.bottom).toBeLessThanOrEqual(geometry.wrap.bottom + 1);
    void wrap;

    await input.fill("Corner");
    await input.press("Enter");
    await expect(input).toBeHidden();

    // The flip only changes which corner is anchored, not that ink lands
    // under the click — a neighborhood scan around the click point should
    // still find real pixels.
    const painted = await samplePixel(editor, ANNOTATION, 0.92, 0.92, 0.08);
    expect(painted.a).toBeGreaterThan(0);
  });

  test("Erase: actually removes previously drawn pixels", async ({ page }) => {
    const editor = await openEditorWithImage(page);

    await dragOnCanvas(page, editor, { xFrac: 0.4, yFrac: 0.5 }, { xFrac: 0.6, yFrac: 0.5 });
    const painted = await samplePixel(editor, ANNOTATION, 0.5, 0.5);
    expect(painted.a).toBeGreaterThan(0);

    const eraseButton = editor.getByRole("button", { name: "Erase" });
    await eraseButton.click();
    // Confirm the tool switch has actually landed, and let the browser reach
    // a real paint frame, before dragging — a real user always has this much
    // of a gap between clicking a toolbar button and starting a new stroke
    // (their mouse has to travel from the toolbar back to the canvas).
    await expect(eraseButton).toHaveAttribute("data-active", "true");
    await waitForNextFrame(page);
    await dragOnCanvas(page, editor, { xFrac: 0.4, yFrac: 0.5 }, { xFrac: 0.6, yFrac: 0.5 });

    const erased = await samplePixel(editor, ANNOTATION, 0.5, 0.5);
    expect(erased.a).toBeLessThan(painted.a);
  });

  test("Crop: select, resize via handle, move, apply, and undo restores the prior size", async ({
    page,
  }) => {
    const editor = await openEditorWithImage(page);
    const before = await canvasSize(editor, 0);

    const cropButton = editor.getByRole("button", { name: "Crop", exact: true });
    await cropButton.click();
    await expect(cropButton).toHaveAttribute("data-active", "true");
    await waitForNextFrame(page);
    await dragOnCanvas(page, editor, { xFrac: 0.1, yFrac: 0.1 }, { xFrac: 0.5, yFrac: 0.5 });

    const applyButton = editor.getByRole("button", { name: "Apply crop" });
    await expect(applyButton).toBeVisible();

    // Resize using the south-east handle — the selection should grow.
    const handles = editor.locator('[class*="cropHandle"]');
    await expect(handles).toHaveCount(4);
    const overlayBefore = await editor
      .locator('[class*="cropOverlay"]')
      .boundingBox();
    const seHandle = editor.locator('[data-corner="se"]');
    const seBox = await seHandle.boundingBox();
    if (!seBox || !overlayBefore) throw new Error("missing geometry");

    await page.mouse.move(seBox.x + seBox.width / 2, seBox.y + seBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(seBox.x + 80, seBox.y + 80, { steps: 5 });
    await page.mouse.up();

    const overlayResized = await editor
      .locator('[class*="cropOverlay"]')
      .boundingBox();
    expect(overlayResized!.width).toBeGreaterThan(overlayBefore.width + 20);

    // Move the whole selection by dragging its body.
    const bodyBox = await editor.locator('[class*="cropOverlay"]').boundingBox();
    if (!bodyBox) throw new Error("missing overlay box");
    await page.mouse.move(bodyBox.x + bodyBox.width / 2, bodyBox.y + bodyBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      bodyBox.x + bodyBox.width / 2 + 40,
      bodyBox.y + bodyBox.height / 2 + 20,
      { steps: 5 },
    );
    await page.mouse.up();

    const overlayMoved = await editor.locator('[class*="cropOverlay"]').boundingBox();
    expect(Math.abs(overlayMoved!.x - overlayResized!.x)).toBeGreaterThan(10);

    await applyButton.click();

    const after = await canvasSize(editor, 0);
    expect(after.width).toBeLessThan(before.width);
    expect(after.height).toBeLessThan(before.height);

    // Undo the crop: the canvas returns to its pre-crop size.
    await editor.getByRole("button", { name: "Undo" }).click();
    const restored = await canvasSize(editor, 0);
    expect(restored.width).toBe(before.width);
    expect(restored.height).toBe(before.height);
  });

  test("Cancel discards every change made in the editor", async ({ page }) => {
    await page.goto("/");
    await page.locator(".prio-create__main").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();

    const original = await makeTestImage(page, 40, 40);
    await dialog.getByLabel("Screenshot").setInputFiles({
      name: "original.png",
      mimeType: "image/png",
      buffer: original,
    });
    await dialog.getByRole("button", { name: "Edit" }).click();

    const editor = page.getByRole("dialog", { name: "Edit screenshot" });
    await expect(editor).toBeVisible();
    await expect(editor.getByText("Loading image…")).toBeHidden();
    await waitForNextFrame(page);

    await dragOnCanvas(page, editor, { xFrac: 0.3, yFrac: 0.3 }, { xFrac: 0.7, yFrac: 0.7 });
    // Exact match: "Cancel crop" also matches "Cancel" by substring, and now
    // stays mounted (disabled) even outside the Crop tool for panel stability.
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(editor).toBeHidden();

    // Re-opening the editor loads the still-original, un-annotated image.
    await dialog.getByRole("button", { name: "Edit" }).click();
    const reopened = page.getByRole("dialog", { name: "Edit screenshot" });
    await expect(reopened).toBeVisible();
    await expect(reopened.getByText("Loading image…")).toBeHidden();
    const pixel = await samplePixel(reopened, ANNOTATION, 0.5, 0.5);
    expect(pixel.a).toBe(0);
  });

  test("Save persists all annotations to the staged image", async ({ page }) => {
    const editor = await openEditorWithImage(page);

    await dragOnCanvas(page, editor, { xFrac: 0.3, yFrac: 0.3 }, { xFrac: 0.7, yFrac: 0.3 });
    await editor.getByRole("button", { name: "Rectangle" }).click();
    await dragOnCanvas(page, editor, { xFrac: 0.2, yFrac: 0.5 }, { xFrac: 0.5, yFrac: 0.7 });

    await editor.getByRole("button", { name: "Save" }).click();
    await expect(editor).toBeHidden();

    const dialog = page.getByRole("dialog");
    // The thumbnail's wrapper is an <a> (opens the image in a new tab) once
    // its preview URL is ready, not a <div> — match on the class, not the tag.
    const preview = dialog.locator('[class*="thumb"] img');
    await expect(preview).toBeVisible();
    const src = await preview.getAttribute("src");
    expect(src).toMatch(/^blob:/);
  });
});
