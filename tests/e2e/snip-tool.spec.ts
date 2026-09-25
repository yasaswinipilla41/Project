import { expect, test, type Locator, type Page } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { watchForProblems } from "./support";

/**
 * The Snip Tool window (§ Create-flow attachments, Issue attachments).
 *
 * What is worth proving here is not that a screenshot can be taken — the unit
 * tests cover the capture library — but the workflow around it: that opening
 * the tool captures nothing; that Select is a fresh capture every time and
 * goes from the area dragged out straight into the editor, where saving is
 * the whole of keeping it; that what is saved lands on the work item the
 * window was opened for, and on no other, even after walking off to another
 * page; and that the window is a window — minimised, maximised and restored
 * without losing anything.
 *
 * The browser's screen picker cannot be driven from a test, so the capture API
 * is replaced before the page loads with one that shares a canvas. That is a
 * genuine `MediaStream` with a genuine video track, so everything downstream —
 * the frame grab, the PNG encode, the crop, the recorder — is the real code
 * path. Only the choice of what to share is faked, which is the one part a
 * person makes. The hints Prio asks the picker for are recorded, so the choice
 * of source can be checked too, and so are the streams themselves: a
 * screenshot has to stop capturing the moment it has its frame, and a stopped
 * track is the only honest evidence of that.
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

    /*
     * Every stream handed over, so a test can ask what became of its tracks.
     *
     * A screenshot must stop capturing the instant it has its frame, and
     * "stopped" is a fact about the track rather than about the interface —
     * `readyState` is the only place it can be read.
     */
    const streams: MediaStream[] = [];
    (window as unknown as { __captureTracks: () => string[] }).__captureTracks =
      () =>
        streams.flatMap((stream) =>
          stream.getTracks().map((track) => track.readyState),
        );

    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: {
        ...navigator.mediaDevices,
        getDisplayMedia: async (options: unknown) => {
          calls.push(options ?? null);
          const stream = (
            canvas as HTMLCanvasElement & {
              captureStream: (fps?: number) => MediaStream;
            }
          ).captureStream(30);
          streams.push(stream);
          return stream;
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

/** The annotation editor a capture lands in. */
function editorFor(page: Page): Locator {
  return page.getByRole("dialog", { name: "Edit screenshot" });
}

/**
 * Select → drag an area → the editor, open on what was caught.
 *
 * A screenshot is nearly always taken in order to point at something, so the
 * editor is where a capture lands rather than somewhere to go afterwards.
 * Saving there is the whole of keeping it: no upload step behind it, and no
 * choice about copies in front of it.
 *
 * Returns the editor, because that is where the next thing happens.
 */
async function captureIntoEditor(page: Page): Promise<Locator> {
  await snipWindow(page).getByRole("button", { name: "Select" }).click();
  await dragArea(page);
  const editor = editorFor(page);
  await expect(editor).toBeVisible();
  /* Drawing before the image has decoded is a silent no-op, and the canvas is
     hidden until it really is ready — so this is the signal that the capture
     arrived, not merely that a dialog did. */
  await expect(editor.locator("canvas").first()).toBeVisible();
  return editor;
}

/** Keeps the capture: the editor's Save is what puts it where it is going. */
async function saveFromEditor(page: Page): Promise<void> {
  await editorFor(page)
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await expect(editorFor(page)).toBeHidden();
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

  test("opens on Select and Recorder, and captures nothing by itself", async ({
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
     * do. There is no source control at all now: Select goes to the
     * browser's own picker, which is the only thing that can offer another
     * tab.
     */
    await expect(snip.getByRole("button", { name: "Select" })).toBeEnabled();
    await expect(snip.getByRole("button", { name: "Recorder" })).toBeEnabled();
    await expect(snip.getByRole("radio")).toHaveCount(0);

    // Minimise, restore, maximise, restore — the window survives all of it.
    await snip.getByRole("button", { name: "Minimise Snip Tool" }).click();
    await expect(snip.getByRole("button", { name: "Select" })).toBeHidden();
    await snip.getByRole("button", { name: "Restore Snip Tool" }).click();
    await expect(snip.getByRole("button", { name: "Select" })).toBeVisible();

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

  test("Select → area → editor → Save lands on the same issue", async ({
    page,
  }) => {
    const { consoleErrors } = watchForProblems(page);
    const { issueId } = await openAnIssue(page);
    const before = await prisma.attachment.count({ where: { issueId } });

    await openScreenshot(page);
    const editor = await captureIntoEditor(page);

    /*
     * The area dragged out is the picture, not the whole 640×400 frame: 50%
     * by 40% of it. Read off the editor's own base canvas, which is what the
     * person is now looking at and drawing on.
     */
    const size = await editor
      .locator("canvas")
      .first()
      .evaluate((canvas: HTMLCanvasElement) => [canvas.width, canvas.height]);
    expect(size[0]).toBeGreaterThan(280);
    expect(size[0]).toBeLessThan(360);
    expect(size[1]).toBeGreaterThan(130);
    expect(size[1]).toBeLessThan(190);

    /*
     * One step, and it is the editor. The capture arrives here on its own —
     * there is no preview to approve first and no upload to run afterwards,
     * so Save is the whole of keeping it.
     */
    await expect(
      editor.getByRole("button", { name: "Save", exact: true }),
    ).toBeVisible();
    await expect(
      snipWindow(page).getByRole("button", { name: "Upload" }),
    ).toHaveCount(0);

    await saveFromEditor(page);

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

  test("backing out of the editor keeps the capture off the work item", async ({
    page,
  }) => {
    const { issueId } = await openAnIssue(page);
    const before = await prisma.attachment.count({ where: { issueId } });

    await openScreenshot(page);
    const editor = await captureIntoEditor(page);

    /* Exactly "Cancel": the editor's toolbar also carries "Cancel crop". */
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(editor).toBeHidden();

    const snip = snipWindow(page);
    /* Back where a capture starts, nothing attached — and no staged row left
       behind either. A picture backed out of was never wanted, so it is not
       kept anywhere for somebody to tidy up later. */
    await expect(snip.getByRole("button", { name: "Select" })).toBeVisible();
    await expect(snipRows(snip)).toHaveCount(0);
    expect(await prisma.attachment.count({ where: { issueId } })).toBe(before);
  });

  test("each Select is separate, and the issue stays the one it was opened for across navigation", async ({
    page,
  }) => {
    const { consoleErrors } = watchForProblems(page);
    const { key, issueId } = await openAnIssue(page);
    const before = await prisma.attachment.count({ where: { issueId } });

    await openScreenshot(page);
    const snip = snipWindow(page);

    // Snip one.
    await captureIntoEditor(page);
    await saveFromEditor(page);
    await expect.poll(() => prisma.attachment.count({ where: { issueId } })).toBe(before + 1);

    /* Walk off to another page, the ordinary way — through Prio's own sidebar.
       The window is mounted by the shell rather than by the page, so it comes
       along, and it is still for the issue it was opened on. */
    await page.locator('.prio-sidebar a[href="/projects"]').click();
    await expect(page).toHaveURL(/\/projects$/);
    await expect(snip).toContainText(key);

    // Snip two, of that page, saved while the issue is not on screen.
    await captureIntoEditor(page);
    await saveFromEditor(page);
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
     * know where the picture goes; the window has to return for the capture
     * to have somewhere to belong once the editor is done with it.
     */
    await page.locator("h1").first().click();
    await page.keyboard.press("Control+Shift+A");
    await dragArea(page);

    /* Straight into the editor, exactly as Select does — the shortcut is that
       same path reached from the keyboard. */
    await expect(editorFor(page)).toBeVisible();
    await saveFromEditor(page);
    await expect(snip).toBeVisible();

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

  test("a saved capture can be renamed, and edited again, without duplicating", async ({
    page,
  }) => {
    const { consoleErrors } = watchForProblems(page);
    const { issueId } = await openAnIssue(page);
    const before = await prisma.attachment.count({ where: { issueId } });

    await openScreenshot(page);
    await captureIntoEditor(page);
    await saveFromEditor(page);

    const snip = snipWindow(page);
    await expect(snipRows(snip)).toHaveCount(1);
    await expect
      .poll(() => prisma.attachment.count({ where: { issueId } }))
      .toBe(before + 1);

    const original = await prisma.attachment.findFirstOrThrow({
      where: { issueId },
      orderBy: { createdAt: "desc" },
      select: { id: true, filename: true },
    });
    createdAttachmentNames.push(original.filename);

    /* ------------------------------------------------------------ rename */
    const chosen = `renamed-${Date.now()}.png`;
    await snip
      .getByRole("button", { name: `Rename ${original.filename}` })
      .click();
    const field = snip.getByRole("textbox", {
      name: `Name for ${original.filename}`,
    });
    await field.fill(chosen);
    await field.press("Enter");

    createdAttachmentNames.push(chosen);

    /* The same row and the same attachment, under a new name — not a second
       of either. Read from the database, because the list would look the
       same whether the name had been stored or only typed. */
    await expect
      .poll(async () =>
        (
          await prisma.attachment.findUniqueOrThrow({
            where: { id: original.id },
            select: { filename: true },
          })
        ).filename,
      )
      .toBe(chosen);
    expect(await prisma.attachment.count({ where: { issueId } })).toBe(
      before + 1,
    );
    await expect(snipRows(snip)).toHaveCount(1);

    /* ------------------------------------------------------- edit again */
    await snip.getByRole("button", { name: `Edit ${chosen}` }).click();
    const editor = editorFor(page);
    await expect(editor).toBeVisible();
    await expect(editor.locator("canvas").first()).toBeVisible();
    await saveFromEditor(page);

    /* Still one attachment, still the same one, still under the name it was
       given — editing a kept capture updates it rather than adding another. */
    await expect
      .poll(() => prisma.attachment.count({ where: { issueId } }))
      .toBe(before + 1);
    const after = await prisma.attachment.findUniqueOrThrow({
      where: { id: original.id },
      select: { filename: true },
    });
    expect(after.filename).toBe(chosen);
    await expect(snipRows(snip)).toHaveCount(1);

    expect(consoleErrors).toEqual([]);
  });

  test("every Select takes one still frame and leaves nothing capturing", async ({
    page,
  }) => {
    const { consoleErrors } = watchForProblems(page);
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

    /** What became of every track the browser handed over. */
    const trackStates = () =>
      page.evaluate(() =>
        (
          window as unknown as { __captureTracks: () => string[] }
        ).__captureTracks(),
      );

    /*
     * The picker is the browser's, and it is what makes another tab reachable
     * at all: a page cannot enumerate your tabs and should not be able to.
     * Prio asks for it when a snip is taken rather than when the window opens,
     * so opening the tool costs nothing.
     */
    await snip.getByRole("button", { name: "Select" }).click();
    await dragArea(page);
    await expect(editorFor(page)).toBeVisible();

    const afterFirst = await pickerCalls();
    expect(afterFirst).toHaveLength(1);
    /* This tab left out of the list, because it has the window in it. Any of
       a tab, a window or a whole screen can still be picked — which of them
       cannot be driven from a test, and does not change the path below: what
       comes back is a MediaStream either way. */
    expect(afterFirst.at(-1)?.selfBrowserSurface).toBe("exclude");

    /*
     * One frame, and then nothing.
     *
     * The picture is taken and every track handed over is stopped in the same
     * breath, so no capture outlives the snap and the browser's sharing
     * indicator goes with it. Read from the tracks themselves: an interface
     * that merely stopped *saying* it was capturing would look identical.
     */
    const afterCapture = await trackStates();
    expect(afterCapture).toHaveLength(1);
    expect(afterCapture).toEqual(["ended"]);

    /* And a screenshot is not a recording: nothing is running, so none of the
       controls that exist for a thing that runs are here. */
    await expect(
      page.getByRole("button", { name: "Stop recording" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("status").filter({ hasText: /(Recording|Paused) \d/ }),
    ).toHaveCount(0);

    await editorFor(page)
      .getByRole("button", { name: "Cancel", exact: true })
      .click();

    /*
     * The second Select asks the browser again.
     *
     * The surface used to be kept between snips, which meant one pick and a
     * live stream held until somebody released it. Holding nothing is the
     * point now, and asking again is what it costs: pick the surface that is
     * already showing what you want.
     */
    await snip.getByRole("button", { name: "Select" }).click();
    const selector = page.getByRole("dialog", { name: "Select area to snip" });
    await expect(selector).toBeVisible();
    expect(await pickerCalls()).toHaveLength(2);
    expect(await trackStates()).toEqual(["ended", "ended"]);

    // Escape cancels the snip without making one, and still leaves nothing on.
    await page.keyboard.press("Escape");
    await expect(selector).toBeHidden();
    await expect(snip).toBeVisible();
    await expect(snipRows(snip)).toHaveCount(0);
    expect(await trackStates()).toEqual(["ended", "ended"]);

    /* Closing the window has nothing left to clean up, and says so by leaving
       the tracks exactly as they were. */
    await snip.getByRole("button", { name: "Close Snip Tool" }).click();
    await expect(snip).toBeHidden();
    expect(await trackStates()).toEqual(["ended", "ended"]);

    expect(consoleErrors).toEqual([]);
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

    await captureIntoEditor(page);
    await saveFromEditor(page);
    await expect(rows).toHaveCount(1);

    await captureIntoEditor(page);
    await saveFromEditor(page);
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

  test("renaming a snip renames the row it is staged in", async ({ page }) => {
    const { consoleErrors } = watchForProblems(page);
    const dialog = await openCreateWithDraft(page, `Rename staged ${Date.now()}`);

    await dialog.getByRole("button", { name: "Add files" }).click();
    await page.getByRole("menuitem", { name: "Screenshot" }).click();
    const snip = snipWindow(page);
    await captureIntoEditor(page);
    await saveFromEditor(page);

    const rows = dialog.getByRole("link", { name: /^Open .+ in a new tab$/ });
    await expect(rows).toHaveCount(1);

    /* Read, not assumed: the capture names itself, and the row is checked
       against that name rather than against one written into the test. */
    const given = (
      await snip.getByRole("button", { name: /^Rename / }).getAttribute("aria-label")
    )!.replace(/^Rename /, "");
    await expect(rows).toHaveAttribute("aria-label", `Open ${given} in a new tab`);

    const chosen = `staged-rename-${Date.now()}.png`;
    await snip.getByRole("button", { name: `Rename ${given}` }).click();
    const field = snip.getByRole("textbox", { name: `Name for ${given}` });
    await field.fill(chosen);
    await field.press("Enter");

    /*
     * The staged row is what gets uploaded when the form is submitted, and it
     * carries its own name — so a rename that only reached the window would be
     * thrown away on Create. One row still, under the new name.
     */
    await expect(rows).toHaveCount(1);
    await expect(rows).toHaveAttribute(
      "aria-label",
      `Open ${chosen} in a new tab`,
    );
    await expect(
      dialog.getByRole("button", { name: `Rename ${given}`, exact: true }),
    ).toHaveCount(0);

    /* And the draft underneath is untouched, as with every other save. */
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

    await captureIntoEditor(page);
    await saveFromEditor(page);
    await expect(snip.getByRole("alert")).toContainText("Open the form");
    /* The row names itself on its rename control, which is the one place the
       capture's name is written down in the list. */
    const label = (await snip
      .getByRole("button", { name: /^Rename / })
      .first()
      .getAttribute("aria-label"))!;
    const name = label.replace(/^Rename /, "");
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
});
