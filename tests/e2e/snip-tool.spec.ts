import { expect, test, type Locator, type Page } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { watchForProblems } from "./support";

/**
 * The Snip Tool window (§ Create-flow attachments, Issue attachments).
 *
 * What is worth proving here is not that a screenshot can be taken — the unit
 * tests cover the capture library — but the workflow around it: that opening
 * the tool captures nothing; that New Snip is a fresh capture every time and
 * goes straight from the area dragged out to Upload, with no editing step in
 * between; that what is uploaded lands on the work item the window was opened
 * for, and on no other, even after walking off to another page; and that the
 * window is a window — minimised, maximised and restored without losing
 * anything.
 *
 * The browser's screen picker cannot be driven from a test, so the capture API
 * is replaced before the page loads with one that shares a canvas. That is a
 * genuine `MediaStream` with a genuine video track, so everything downstream —
 * the frame grab, the PNG encode, the crop, the recorder — is the real code
 * path. Only the choice of what to share is faked, which is the one part a
 * person makes. The hints Prio asks the picker for are recorded, so the choice
 * of source can be checked too.
 */
async function stubDisplayCapture(page: Page) {
  await page.addInitScript(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 400;
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
      context.fillRect(40, 40, 240, 120);
    }, 100);

    const calls: unknown[] = [];
    (window as unknown as { __displayMediaCalls: unknown[] }).__displayMediaCalls =
      calls;

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        ...navigator.mediaDevices,
        getDisplayMedia: async (options: unknown) => {
          calls.push(options ?? null);
          return (
            canvas as HTMLCanvasElement & {
              captureStream: (fps?: number) => MediaStream;
            }
          ).captureStream(30);
        },
      },
    });
  });
}

/** The Snip Tool window, wherever in the shell it is showing. */
function snipWindow(page: Page) {
  return page.getByRole("dialog", { name: "Snip Tool" });
}

/** The snips taken in this session, scoped to the list that holds them. */
function snipRows(snip: Locator) {
  return snip.locator('[class*="snipList"] > li');
}

/** Drags out an area on the capture, as a fraction of its shown size. */
async function dragArea(
  page: Page,
  from: [number, number] = [0.1, 0.1],
  to: [number, number] = [0.6, 0.5],
) {
  const selector = page.getByRole("dialog", { name: "Select area to snip" });
  await expect(selector).toBeVisible();
  const image = selector.getByRole("img", {
    name: "The capture to select an area from",
  });
  await expect(image).toBeVisible();
  const box = (await image.boundingBox())!;

  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], {
    steps: 10,
  });
  await page.mouse.up();
  await expect(selector).toBeHidden();
}

/** The capture being reviewed, as opposed to the thumbnails of ones already sent. */
function previewImage(snip: Locator) {
  return snip.getByRole("img", { name: /^Snip: / });
}

/**
 * New Snip → drag an area → the preview of what was caught.
 *
 * There is no editor in this path any more. A capture used to be pushed
 * through the annotation editor before it could become an attachment, so the
 * ordinary case — take a picture of the thing, put it on the work item — cost
 * a crop tool, a Save and a choice about copies. The editor is still reachable
 * from the attachment itself for the times somebody wants to draw on a
 * screenshot; it is no longer the toll on the times they do not.
 */
async function newSnip(page: Page): Promise<Locator> {
  await snipWindow(page).getByRole("button", { name: "New Snip" }).click();
  await dragArea(page);
  const snip = snipWindow(page);
  await expect(snip.getByRole("button", { name: "Upload" })).toBeVisible();
  /* By its alt text, not `locator("img")`: every snip already sent shows a
     thumbnail in the list below, so the bare locator matches more and more
     images as a session goes on. Only the preview is captioned. */
  await expect(previewImage(snip)).toBeVisible();
  return snip;
}

/** An issue page, opened from the list, and its attachment count. */
async function openAnIssue(page: Page) {
  await page.goto("/issues");
  await page.locator("a[href^='/issues/']").first().click();
  /* The list adds `?from=/issues` so the detail page can offer the way
     back, so the key is matched without anchoring to the end. */
  await expect(page).toHaveURL(/\/issues\/[a-z]+-\d+(\?|$)/i);
  const key = /\/issues\/([a-z]+-\d+)/i.exec(page.url())![1]!.toUpperCase();
  const issue = await prisma.issue.findUniqueOrThrow({
    where: { key },
    select: { id: true, project: { select: { name: true, key: true } } },
  });
  return {
    key,
    issueId: issue.id,
    projectName: issue.project.name,
    projectKey: issue.project.key,
  };
}

async function openScreenshot(page: Page) {
  const panel = page
    .locator(".prio-dropzone")
    .filter({ has: page.getByRole("heading", { name: "Attachments" }) });
  await panel.getByRole("button", { name: "Add files" }).click();
  await page.getByRole("menuitem", { name: "Screenshot" }).click();
}

const createdAttachmentNames: string[] = [];

test.afterAll(async () => {
  if (createdAttachmentNames.length > 0) {
    await prisma.attachment.deleteMany({
      where: { filename: { in: createdAttachmentNames } },
    });
  }
});

test.describe("Snip Tool — screenshot workflow on an issue", () => {
  test.beforeEach(async ({ page }) => {
    await stubDisplayCapture(page);
  });

  test("opens on New Snip and Recorder, and captures nothing by itself", async ({
    page,
  }) => {
    const { consoleErrors } = watchForProblems(page);
    const { key, projectName } = await openAnIssue(page);
    await openScreenshot(page);

    const snip = snipWindow(page);
    await expect(snip).toBeVisible();
    // Bound for this issue, in this project — said in the title bar.
    await expect(snip).toContainText(key);
    await expect(snip).toContainText(projectName);

    // Nothing was captured just by opening it.
    expect(
      await page.evaluate(
        () => (window as unknown as { __displayMediaCalls: unknown[] }).__displayMediaCalls.length,
      ),
    ).toBe(0);

    /*
     * Two things to choose between, and nothing else.
     *
     * The window used to open on a choice of capture source — "This tab" or
     * "Another tab or window" — which asked a question the browser is about to
     * ask anyway, and asked it before the person had said what they wanted to
     * do. There is no source control at all now: New Snip goes to the
     * browser's own picker, which is the only thing that can offer another
     * tab.
     */
    await expect(snip.getByRole("button", { name: "New Snip" })).toBeEnabled();
    await expect(snip.getByRole("button", { name: "Recorder" })).toBeEnabled();
    await expect(snip.getByRole("radio")).toHaveCount(0);

    // Minimise, restore, maximise, restore — the window survives all of it.
    await snip.getByRole("button", { name: "Minimise Snip Tool" }).click();
    await expect(snip.getByRole("button", { name: "New Snip" })).toBeHidden();
    await snip.getByRole("button", { name: "Restore Snip Tool" }).click();
    await expect(snip.getByRole("button", { name: "New Snip" })).toBeVisible();

    const floating = (await snip.boundingBox())!;
    await snip.getByRole("button", { name: "Maximise Snip Tool" }).click();
    const big = (await snip.boundingBox())!;
    expect(big.width).toBeGreaterThan(floating.width * 2);
    expect(big.height).toBeGreaterThan(floating.height);
    await snip.getByRole("button", { name: "Restore Snip Tool size" }).click();
    const restored = (await snip.boundingBox())!;
    expect(Math.round(restored.width)).toBe(Math.round(floating.width));

    // Close still closes.
    await snip.getByRole("button", { name: "Close Snip Tool" }).click();
    await expect(snip).toBeHidden();

    expect(consoleErrors).toEqual([]);
  });

  test("New Snip → area → preview → Upload lands on the same issue", async ({
    page,
  }) => {
    const { consoleErrors } = watchForProblems(page);
    const { issueId } = await openAnIssue(page);
    const before = await prisma.attachment.count({ where: { issueId } });

    await openScreenshot(page);
    const snip = await newSnip(page);

    /*
     * The area dragged out is the picture, not the whole 640×400 frame: 50%
     * by 40% of it. Read off the preview image itself, which is what the
     * person is looking at when they decide whether to upload.
     */
    const size = await previewImage(snip).evaluate((img: HTMLImageElement) => [
      img.naturalWidth,
      img.naturalHeight,
    ]);
    expect(size[0]).toBeGreaterThan(280);
    expect(size[0]).toBeLessThan(360);
    expect(size[1]).toBeGreaterThan(130);
    expect(size[1]).toBeLessThan(190);

    /*
     * Two actions and no more. There is no Save, no Save as copy and no
     * editing step between the capture and the attachment — marking a
     * screenshot up is still possible from the attachment itself, and is no
     * longer the toll on the ordinary case.
     */
    await expect(snip.getByRole("button", { name: "Upload" })).toBeVisible();
    await expect(snip.getByRole("button", { name: "Cancel" })).toBeVisible();
    await expect(snip.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
    await expect(snip.getByRole("button", { name: "Save as copy" })).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "Edit screenshot" })).toHaveCount(0);

    await snip.getByRole("button", { name: "Upload" }).click();

    await expect.poll(() => prisma.attachment.count({ where: { issueId } })).toBe(before + 1);

    const saved = await prisma.attachment.findFirstOrThrow({
      where: { issueId },
      orderBy: { createdAt: "desc" },
      select: { id: true, filename: true },
    });
    createdAttachmentNames.push(saved.filename);
    expect(saved.filename).toMatch(/^screenshot-.*\.png$/);

    // Visible in the issue's own Attachments without a reload.
    await expect(
      page.locator(".prio-attachment").filter({ hasText: saved.filename }),
    ).toHaveCount(1);

    expect(consoleErrors).toEqual([]);
  });

  test("Cancel keeps the capture off the work item", async ({ page }) => {
    const { issueId } = await openAnIssue(page);
    const before = await prisma.attachment.count({ where: { issueId } });

    await openScreenshot(page);
    const snip = await newSnip(page);

    await snip.getByRole("button", { name: "Cancel" }).click();

    /* Back to where a fresh capture starts, and nothing was attached. */
    await expect(snip.getByRole("button", { name: "New Snip" })).toBeVisible();
    await expect(snip.getByRole("button", { name: "Upload" })).toHaveCount(0);
    expect(await prisma.attachment.count({ where: { issueId } })).toBe(before);
  });

  test("each New Snip is separate, and the issue stays the one it was opened for across navigation", async ({
    page,
  }) => {
    const { consoleErrors } = watchForProblems(page);
    const { key, issueId } = await openAnIssue(page);
    const before = await prisma.attachment.count({ where: { issueId } });

    await openScreenshot(page);
    const snip = snipWindow(page);

    // Snip one.
    await newSnip(page);
    await snip.getByRole("button", { name: "Upload" }).click();
    await expect.poll(() => prisma.attachment.count({ where: { issueId } })).toBe(before + 1);

    /* Walk off to another page, the ordinary way — through Prio's own sidebar.
       The window is mounted by the shell rather than by the page, so it comes
       along, and it is still for the issue it was opened on. */
    await page.locator('.prio-sidebar a[href="/projects"]').click();
    await expect(page).toHaveURL(/\/projects$/);
    await expect(snip).toContainText(key);

    // Snip two, of that page, uploaded while the issue is not on screen.
    await newSnip(page);
    await snip.getByRole("button", { name: "Upload" }).click();
    await expect.poll(() => prisma.attachment.count({ where: { issueId } })).toBe(before + 2);

    // Two rows, two different files, both on that issue and no other.
    await expect(snipRows(snip)).toHaveCount(2);
    const saved = await prisma.attachment.findMany({
      where: { issueId },
      orderBy: { createdAt: "desc" },
      take: 2,
      select: { filename: true, issueId: true },
    });
    createdAttachmentNames.push(...saved.map((row) => row.filename));
    expect(new Set(saved.map((row) => row.filename)).size).toBe(2);
    for (const row of saved) expect(row.issueId).toBe(issueId);

    // The window offers the way back, and the issue shows both.
    await snip.getByRole("link", { name: `Open ${key}` }).click();
    await expect(page).toHaveURL(new RegExp(`/issues/${key.toLowerCase()}`));
    for (const row of saved) {
      await expect(
        page.locator(".prio-attachment").filter({ hasText: row.filename }),
      ).toHaveCount(1);
    }

    expect(consoleErrors).toEqual([]);
  });

  test("Ctrl+Shift+A snips from wherever you are, and typing an A is still an A", async ({
    page,
  }) => {
    const { consoleErrors } = watchForProblems(page);
    const { issueId } = await openAnIssue(page);
    const before = await prisma.attachment.count({ where: { issueId } });

    await openScreenshot(page);
    const snip = snipWindow(page);
    await expect(snip).toBeVisible();

    /*
     * Not while typing.
     *
     * The shortcut is off inside a field, so the combination means whatever
     * the browser makes of it in a comment box rather than silently taking a
     * picture of the screen. Checked first, because a shortcut that fires
     * here is worse than one that never fires at all.
     */
    await snip.getByRole("button", { name: "Close Snip Tool" }).click();
    await expect(snip).toBeHidden();
    const comment = page.getByRole("textbox", { name: /comment/i }).first();
    await comment.click();
    await comment.press("Control+Shift+A");
    await expect(
      page.getByRole("dialog", { name: "Select area to snip" }),
    ).toHaveCount(0);

    /*
     * And from the page itself it takes one — bringing the window back with
     * it. Closing leaves the target behind, which is what lets the shortcut
     * know where the picture goes; the window has to return for the preview
     * to be somewhere a person can see it.
     */
    await page.locator("h1").first().click();
    await page.keyboard.press("Control+Shift+A");
    await dragArea(page);

    await expect(snip).toBeVisible();
    await expect(snip.getByRole("button", { name: "Upload" })).toBeVisible();
    await snip.getByRole("button", { name: "Upload" }).click();

    await expect
      .poll(() => prisma.attachment.count({ where: { issueId } }))
      .toBe(before + 1);
    const saved = await prisma.attachment.findFirstOrThrow({
      where: { issueId },
      orderBy: { createdAt: "desc" },
      select: { filename: true },
    });
    createdAttachmentNames.push(saved.filename);

    expect(consoleErrors).toEqual([]);
  });

  test("New Snip asks the browser once, and keeps that surface for the next one", async ({
    page,
  }) => {
    await openAnIssue(page);
    await openScreenshot(page);
    const snip = snipWindow(page);

    const pickerCalls = () =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              __displayMediaCalls: {
                preferCurrentTab?: boolean;
                selfBrowserSurface?: string;
              }[];
            }
          ).__displayMediaCalls,
      );

    /*
     * The picker is the browser's, and it is what makes another tab reachable
     * at all: a page cannot enumerate your tabs and should not be able to.
     * Prio asks for it when the first snip is taken rather than when the
     * window opens, so opening the tool costs nothing.
     */
    await snip.getByRole("button", { name: "New Snip" }).click();
    await dragArea(page);
    await expect(snip.getByRole("button", { name: "Upload" })).toBeVisible();

    const afterFirst = await pickerCalls();
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst.at(-1)?.selfBrowserSurface).toBe("exclude");

    /*
     * And back on the opening screen the window says what it is holding.
     *
     * Said there rather than over the preview, deliberately: it comes with
     * Release source beside it, and an offer to let go of the surface is
     * only useful where taking another snip is the next thing on offer. The
     * preview is about the picture just taken.
     */
    await snip.getByRole("button", { name: "Cancel" }).click();
    await expect(snip.getByText(/^Capturing from/)).toBeVisible();

    /*
     * And the second snip comes from the surface already being shared: the
     * picker is not asked again. That is the whole point of retaining it —
     * being re-prompted per snip would both interrupt and undo the navigation
     * the person just did to reach what they wanted.
     */
    await snip.getByRole("button", { name: "New Snip" }).click();
    const selector = page.getByRole("dialog", { name: "Select area to snip" });
    await expect(selector).toBeVisible();
    expect(await pickerCalls()).toHaveLength(1);

    // Escape cancels the snip without making one, and keeps the share.
    await page.keyboard.press("Escape");
    await expect(selector).toBeHidden();
    await expect(snip).toBeVisible();
    await expect(snip.getByText(/^Capturing from/)).toBeVisible();

    /* Releasing is the person's to do. Worded as capture rather than sharing:
       nothing leaves the machine, and the browser's own "Stop sharing" bar is
       a separate control. */
    await snip.getByRole("button", { name: "Release source" }).click();
    await expect(snip.getByText(/^Capturing from/)).toHaveCount(0);
  });
});

/**
 * The Create form, where a snip is staged rather than uploaded — the path
 * where "the second one overwrote the first" would actually show, because
 * every row is visible side by side before anything is sent.
 */
test.describe("Snip Tool — on the Create form", () => {
  test.beforeEach(async ({ page }) => {
    await stubDisplayCapture(page);
  });

  /** A Create dialog with a project chosen and a summary typed in. */
  async function openCreateWithDraft(page: Page, summary: string) {
    await page.goto("/");
    await page.locator(".prio-create__main").click();

    const dialog = page.getByRole("dialog", { name: /create/i });
    await expect(dialog).toBeVisible();
    await dialog
      .getByLabel("Project")
      .selectOption({ label: "Engineering (ENG)" });
    await dialog.getByLabel("Summary").fill(summary);
    return dialog;
  }

  test("each snip stages as its own row, and the draft underneath is untouched", async ({
    page,
  }) => {
    const { consoleErrors } = watchForProblems(page);
    const dialog = await openCreateWithDraft(page, `Many snips ${Date.now()}`);

    await dialog.getByRole("button", { name: "Add files" }).click();
    await page.getByRole("menuitem", { name: "Screenshot" }).click();
    const snip = snipWindow(page);
    await expect(snip).toContainText("New issue");

    const rows = dialog.getByRole("button", { name: /Annotate|Edit markup/ });

    await newSnip(page);
    await snip.getByRole("button", { name: "Upload" }).click();
    await expect(rows).toHaveCount(1);

    await newSnip(page);
    await snip.getByRole("button", { name: "Upload" }).click();
    await expect(rows).toHaveCount(2);

    /* Two separate files, not one written over twice — the failure this path
       exists to catch, and the reason the staged rows are checked here rather
       than on an issue where they are uploaded out of sight. */
    const names = await dialog
      .getByRole("link", { name: /^Open .+ in a new tab$/ })
      .evaluateAll((links: Element[]) =>
        links.map((link) => link.getAttribute("aria-label")),
      );
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);

    /*
     * And the editor is still reachable from a staged row.
     *
     * Marking a screenshot up did not go away — it stopped being compulsory.
     * Annotate on the row opens the same editor it always did.
     */
    await rows.first().click();
    const editor = page.getByRole("dialog", { name: "Edit screenshot" });
    await expect(editor).toBeVisible();
    /* Exactly "Cancel": the editor's toolbar also has "Cancel crop". */
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(editor).toBeHidden();

    // And the draft underneath is untouched by any of it.
    await expect(dialog.getByLabel("Summary")).not.toHaveValue("");

    expect(consoleErrors).toEqual([]);
  });

  test("a snip saved while the form is closed waits, and saves to the form when it is back", async ({
    page,
  }) => {
    const { consoleErrors } = watchForProblems(page);
    const dialog = await openCreateWithDraft(page, `Waiting snip ${Date.now()}`);

    await dialog.getByRole("button", { name: "Add files" }).click();
    await page.getByRole("menuitem", { name: "Screenshot" }).click();
    const snip = snipWindow(page);
    await expect(snip).toBeVisible();

    // Close the form, then snip: there is nowhere to save to yet.
    await dialog.getByRole("button", { name: "Close dialog" }).click();
    await expect(dialog).toBeHidden();

    await newSnip(page);
    await snip.getByRole("button", { name: "Upload" }).click();
    await expect(snip.getByRole("alert")).toContainText("Open the form");
    const name = (await snip.locator("li [title]").first().getAttribute("title"))!;
    await expect(snip.getByRole("button", { name: `Save ${name}` })).toBeVisible();

    // Walk off to another page; the snip is still held.
    await page.locator('.prio-sidebar a[href="/issues"]').click();
    await expect(page).toHaveURL(/\/issues/);
    await expect(snip.getByRole("button", { name: `Save ${name}` })).toBeVisible();

    // A Create form again, and Save puts it there — once.
    await page.locator(".prio-create__main").click();
    const reopened = page.getByRole("dialog", { name: /create/i });
    await expect(reopened).toBeVisible();
    await snip.getByRole("button", { name: `Save ${name}` }).click();
    await expect(
      reopened.getByRole("button", { name: /Annotate|Edit markup/ }),
    ).toHaveCount(1);
    await expect(snip.getByRole("button", { name: `Save ${name}` })).toBeHidden();

    expect(consoleErrors).toEqual([]);
  });

  test("the window can be dragged by its title bar, and stays on screen", async ({
    page,
  }) => {
    const { consoleErrors } = watchForProblems(page);

    const dialog = await openCreateWithDraft(page, `Dragged ${Date.now()}`);
    await dialog.getByRole("button", { name: "Add files" }).click();
    await page.getByRole("menuitem", { name: "Screenshot" }).click();

    const snip = snipWindow(page);
    await expect(snip).toBeVisible();
    const before = (await snip.boundingBox())!;

    /*
     * By the bar, which is the handle a window has. The target label is a
     * plain span inside it, so grabbing there is grabbing the bar and not one
     * of its buttons. Moved in steps so the pointer actually travels.
     */
    const grip = snip.getByText("New issue", { exact: true });
    const from = (await grip.boundingBox())!;
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x - 200, from.y - 150, { steps: 12 });
    await page.mouse.up();

    const after = (await snip.boundingBox())!;
    expect(after.x).toBeLessThan(before.x - 100);
    expect(after.y).toBeLessThan(before.y - 100);

    /* Dragged at the top left corner, it stops at the edge instead of
       disappearing behind it. */
    const handle = (await grip.boundingBox())!;
    await page.mouse.move(handle.x + 4, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(0, 0, { steps: 12 });
    await page.mouse.up();

    const parked = (await snip.boundingBox())!;
    expect(parked.y).toBeGreaterThanOrEqual(0);
    expect(parked.x + parked.width).toBeGreaterThan(24);
    await expect(snip.getByRole("button", { name: "Close Snip Tool" })).toBeVisible();

    expect(consoleErrors).toEqual([]);
  });

  test("Record stands the window down, runs from a strip, and attaches as a WebM", async ({
    page,
  }) => {
    /* The strip on the page, which is where it stays in a browser without
       Document Picture-in-Picture. Where the browser has it, the strip moves
       into a floating window instead — covered by the test below. */
    await page.addInitScript(() => {
      delete (window as { documentPictureInPicture?: unknown })
        .documentPictureInPicture;
    });
    const { consoleErrors } = watchForProblems(page);

    const dialog = await openCreateWithDraft(page, `Recorded ${Date.now()}`);

    await dialog.getByRole("button", { name: "Add files" }).click();
    await page.getByRole("menuitem", { name: "Record" }).click();

    const snip = snipWindow(page);

    /*
     * The window goes away, and a strip takes over.
     *
     * Controls that sit over the thing being recorded end up in the file.
     * The window is therefore stood down for the whole of the recording, and
     * the one control that is genuinely needed while it runs — Stop — lives
     * on a small strip instead. Asserting the window is gone is the point:
     * it is the behaviour, not an incidental.
     */
    await expect(snip).toBeHidden();

    /* Matched on either word it can say: filtering on "Recording" alone is
       a locator that stops resolving the moment the thing it describes is
       paused, which is exactly when the test needs it. */
    const bar = page
      .getByRole("status")
      .filter({ hasText: /(Recording|Paused) \d/ });
    await expect(bar).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Stop recording" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Discard recording" }),
    ).toBeVisible();

    /*
     * This tab was left out of the picker.
     *
     * The recording controls are part of this page, so recording this page
     * would put them in the file. Asking the browser to exclude its own
     * surface is what prevents that, and it is the only part of the guarantee
     * Prio controls — a person who picks a whole screen is recording the
     * screen the controls are on, which no page can prevent.
     */
    const recordHints = await page.evaluate(
      () =>
        (
          window as unknown as {
            __displayMediaCalls: {
              preferCurrentTab?: boolean;
              selfBrowserSurface?: string;
              audio?: unknown;
              video?: { cursor?: string };
            }[];
          }
        ).__displayMediaCalls,
    );
    const asked = recordHints.at(-1);
    expect(asked?.selfBrowserSurface).toBe("exclude");
    expect(asked?.preferCurrentTab).not.toBe(true);
    /* A recording asks for sound and for the pointer to be drawn in. Both are
       offers the browser may refuse; asking is what Prio controls. */
    expect(asked?.audio).toBeTruthy();
    expect(asked?.video?.cursor).toBe("always");

    /* Pausing is offered only where the recorder actually implements it. */
    const pause = page.getByRole("button", { name: "Pause recording" });
    if ((await pause.count()) > 0) {
      await pause.click();
      await expect(bar).toContainText("Paused");
      await page.getByRole("button", { name: "Resume recording" }).click();
      await expect(bar).toContainText("Recording");
    }

    /* Long enough for the recorder's one-second timeslice to deliver a chunk;
       a stop before that produces an empty blob and a refusal instead. */
    await page.waitForTimeout(1_600);
    await expect(bar).not.toContainText("Recording 0:00");

    await page.getByRole("button", { name: "Stop recording" }).click();

    /*
     * Stopping brings the window back, on the preview.
     *
     * A recording previews as a video and offers no Annotate — the editor is
     * for stills — and the three things worth doing with it are here: keep
     * it, take another, or drop it.
     */
    await expect(snip).toBeVisible();
    await expect(snip.locator("video")).toBeVisible();
    await expect(snip.getByRole("button", { name: "Annotate" })).toHaveCount(0);
    await expect(
      snip.getByRole("button", { name: "Record Again" }),
    ).toBeVisible();
    await expect(snip.getByRole("button", { name: "Cancel" })).toBeVisible();

    await snip.getByRole("button", { name: "Upload" }).click();
    await expect(snip.getByRole("button", { name: "Upload" })).toBeHidden();

    await expect(
      dialog.locator(".prio-field").getByTitle(/^recording-.*\.webm$/),
    ).toHaveCount(1);
    await expect(dialog.locator(".prio-field video")).toHaveCount(1);
    await expect(
      dialog.locator(".prio-field").getByRole("button", { name: "Rename" }),
    ).toHaveCount(1);

    expect(consoleErrors).toEqual([]);
  });

  test("a recording's strip floats above other tabs, and runs the same recorder from there", async ({
    page,
  }) => {
    const { consoleErrors } = watchForProblems(page);

    /* The recorder is watched from outside, so "paused" below means the
       MediaRecorder paused rather than that a label changed. */
    await page.addInitScript(() => {
      const watched = window as unknown as {
        __recorders: MediaRecorder[];
        MediaRecorder: typeof MediaRecorder;
      };
      watched.__recorders = [];
      const Original = watched.MediaRecorder;
      watched.MediaRecorder = class extends Original {
        constructor(...args: ConstructorParameters<typeof MediaRecorder>) {
          super(...args);
          watched.__recorders.push(this);
        }
      };
    });

    const dialog = await openCreateWithDraft(page, `Floated ${Date.now()}`);
    const floatable = await page.evaluate(
      () => "documentPictureInPicture" in window,
    );
    test.skip(!floatable, "This browser has no Document Picture-in-Picture.");
    await dialog.getByRole("button", { name: "Add files" }).click();
    await page.getByRole("menuitem", { name: "Record" }).click();

    /* What the floating window shows, and what the recorder is doing. */
    const read = () =>
      page.evaluate(() => {
        const floating = (
          window as unknown as {
            documentPictureInPicture: { window: Window | null };
          }
        ).documentPictureInPicture.window;
        const recorders = (
          window as unknown as { __recorders: MediaRecorder[] }
        ).__recorders;
        return {
          floating: Boolean(floating),
          text:
            floating?.document.querySelector("[role=status]")?.textContent ??
            null,
          recorders: recorders.length,
          state: recorders.at(-1)?.state ?? null,
        };
      });
    const press = (label: string) =>
      page.evaluate((name) => {
        const floating = (
          window as unknown as {
            documentPictureInPicture: { window: Window | null };
          }
        ).documentPictureInPicture.window;
        floating?.document
          .querySelector<HTMLButtonElement>(`button[aria-label='${name}']`)
          ?.click();
      }, label);

    await expect.poll(async () => (await read()).floating).toBe(true);
    const onPage = page
      .getByRole("status")
      .filter({ hasText: /(Recording|Paused) \d/ });
    /* Moved, not copied: one strip, in the floating window. */
    await expect(onPage).toHaveCount(0);
    await expect.poll(async () => (await read()).text).toMatch(/Recording \d/);

    await press("Pause recording");
    await expect.poll(async () => (await read()).state).toBe("paused");
    expect((await read()).text).toMatch(/Paused \d/);

    await press("Resume recording");
    await expect.poll(async () => (await read()).state).toBe("recording");

    /* Closing the floating window is not stopping: the recording runs on and
       the strip comes back to the page, with the way to float it again. */
    await page.evaluate(() =>
      (
        window as unknown as {
          documentPictureInPicture: { window: Window | null };
        }
      ).documentPictureInPicture.window?.close(),
    );
    await expect(onPage).toBeVisible();
    expect((await read()).state).toBe("recording");
    await page
      .getByRole("button", { name: "Float recording controls over other tabs" })
      .click();
    await expect.poll(async () => (await read()).floating).toBe(true);
    await expect(onPage).toHaveCount(0);

    await page.waitForTimeout(1_600);
    await press("Stop recording");

    /* Stopped from the floating window: it closes, and the Snip Tool comes
       back on the preview exactly as a stop from the page does. */
    await expect.poll(async () => (await read()).floating).toBe(false);
    const after = await read();
    expect(after.state).toBe("inactive");
    expect(after.recorders).toBe(1);
    const snip = snipWindow(page);
    await expect(snip).toBeVisible();
    await expect(snip.locator("video")).toBeVisible();

    expect(consoleErrors).toEqual([]);
  });
});
