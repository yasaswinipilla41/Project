import { expect, test, type Page } from "@playwright/test";
import { watchForProblems } from "./support";

/**
 * The Snip Tool window (§ Create-flow attachments, Issue attachments).
 *
 * What is worth proving here is not that a screenshot can be taken — the unit
 * tests cover the capture library — but that the window is a window: that it
 * keeps what it is holding while the person goes and does something else, and
 * that a capture reaches the one place it was taken for and nowhere else.
 *
 * The browser's screen picker cannot be driven from a test, so the capture API
 * is replaced before the page loads with one that shares a canvas. That is a
 * genuine `MediaStream` with a genuine video track, so everything downstream —
 * the frame grab, the PNG encode, the recorder — is the real code path. Only
 * the choice of what to share is faked, which is the one part a person makes.
 */
async function stubDisplayCapture(page: Page) {
  await page.addInitScript(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 200;
    const context = canvas.getContext("2d");

    /* Repainted on a timer: a canvas that never changes produces a stream
       with no frames after the first, and a recorder on it writes nothing. */
    let tick = 0;
    setInterval(() => {
      if (!context) return;
      tick += 1;
      context.fillStyle = tick % 2 === 0 ? "#1d4ed8" : "#9333ea";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#ffffff";
      context.fillRect(20, 20, 120, 60);
    }, 100);

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        ...navigator.mediaDevices,
        getDisplayMedia: async () =>
          (canvas as HTMLCanvasElement & {
            captureStream: (fps?: number) => MediaStream;
          }).captureStream(30),
      },
    });
  });
}

/** The Snip Tool window, wherever in the shell it is showing. */
function snipWindow(page: Page) {
  return page.getByRole("dialog", { name: "Snip Tool" });
}

test.describe("Snip Tool", () => {
  test.beforeEach(async ({ page }) => {
    await stubDisplayCapture(page);
  });

  test("a capture taken from Create survives navigation, minimising and the dialog closing", async ({
    page,
  }) => {
    const { consoleErrors } = watchForProblems(page);

    await page.goto("/");
    await page.locator(".prio-create__main").click();

    const dialog = page.getByRole("dialog", { name: /create/i });
    await expect(dialog).toBeVisible();
    await dialog
      .getByLabel("Project")
      .selectOption({ label: "Engineering (ENG)" });

    const title = `Snip tool draft ${Date.now()}`;
    await dialog.getByLabel("Summary").fill(title);

    // Add files → Snip Tool → Screenshot.
    await dialog.getByRole("button", { name: "Add files" }).click();
    await page.getByRole("menuitem", { name: "Screenshot" }).click();

    /* A screenshot goes straight into the editor, because a screenshot is
       nearly always taken in order to point at something in it. */
    const editor = page.getByRole("dialog", { name: "Edit screenshot" });
    await expect(editor).toBeVisible();
    await expect(editor.locator("canvas").first()).toBeVisible();
    await editor.getByRole("button", { name: "Save" }).click();
    await expect(editor).toBeHidden();

    // The window is holding it, and says what it is holding it for.
    const snip = snipWindow(page);
    await expect(snip).toBeVisible();
    await expect(snip.getByText("New issue")).toBeVisible();
    await expect(snip.getByRole("button", { name: "Attach" })).toBeVisible();

    // Minimise: the window stays, the capture stays, the body folds away.
    await snip.getByRole("button", { name: "Minimise Snip Tool" }).click();
    await expect(snip.getByRole("button", { name: "Attach" })).toBeHidden();
    await snip.getByRole("button", { name: "Restore Snip Tool" }).click();
    await expect(snip.getByRole("button", { name: "Attach" })).toBeVisible();

    /*
     * Close the Create dialog and walk off to another page entirely. This is
     * the whole point of the window: a dropdown would have taken the capture
     * with it at the first click outside.
     *
     * Through the application's own navigation, because that is the claim —
     * the shell is not torn down when the page changes, so neither is the
     * window. A full browser reload is a different thing and does end a
     * capture; nothing here or in the interface says otherwise.
     */
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await page.locator('.prio-sidebar a[href="/issues"]').click();
    await expect(page).toHaveURL(/\/issues/);
    await expect(snip).toBeVisible();
    await expect(snip.getByRole("button", { name: "Attach" })).toBeVisible();

    /* Nothing to hand it to while the form is closed, and it says so rather
       than dropping the capture or attaching it somewhere else. */
    await snip.getByRole("button", { name: "Attach" }).click();
    await expect(snip.getByRole("alert")).toContainText("Open the form");
    await expect(snip.getByRole("button", { name: "Attach" })).toBeVisible();

    // Back to a Create form, and the capture it was taken for lands in it.
    await page.locator(".prio-create__main").click();
    const reopened = page.getByRole("dialog", { name: /create/i });
    await expect(reopened).toBeVisible();
    await snip.getByRole("button", { name: "Attach" }).click();

    await expect(
      reopened.getByRole("button", { name: /Annotate|Edit markup/ }),
    ).toHaveCount(1);

    /* Delivered once. The window has let it go, so there is no second press
       that could stage the same capture twice. */
    await expect(snip.getByRole("button", { name: "Attach" })).toBeHidden();
    await expect(snip.getByRole("button", { name: "New snip" })).toBeVisible();

    expect(consoleErrors).toEqual([]);
  });

  test("a capture taken on an issue uploads to that issue", async ({
    page,
  }) => {
    const { consoleErrors } = watchForProblems(page);

    await page.goto("/issues");
    await page.locator("a[href^='/issues/']").first().click();
    /* The list adds `?from=/issues` so the detail page can offer the way
       back, so the key is matched without anchoring to the end. */
    await expect(page).toHaveURL(/\/issues\/[a-z]+-\d+(\?|$)/i);

    const before = await page.locator(".prio-attachment").count();

    const panel = page
      .locator(".prio-dropzone")
      .filter({ has: page.getByRole("heading", { name: "Attachments" }) });
    await panel.getByRole("button", { name: "Add files" }).click();
    await page.getByRole("menuitem", { name: "Screenshot" }).click();

    const editor = page.getByRole("dialog", { name: "Edit screenshot" });
    await expect(editor).toBeVisible();
    await editor.getByRole("button", { name: "Save" }).click();

    const snip = snipWindow(page);
    await expect(snip.getByRole("button", { name: "Attach" })).toBeVisible();
    await snip.getByRole("button", { name: "Attach" }).click();

    // One more attachment, on the server — it is still there after a reload.
    await expect(page.locator(".prio-attachment")).toHaveCount(before + 1);
    await page.reload();
    await expect(page.locator(".prio-attachment")).toHaveCount(before + 1);

    expect(consoleErrors).toEqual([]);
  });
});
