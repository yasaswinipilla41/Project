import { expect, test, type Locator, type Page } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { watchForProblems } from "./support";

/**
 * The Snip Tool window (§ Create-flow attachments, Issue attachments).
 *
 * What is worth proving here is not that a screenshot can be taken — the unit
 * tests cover the capture library — but the workflow around it: that
 * Screenshot opens the window on a choice of what to capture rather than
 * forcing a capture; that + New snip is a fresh capture every time; that the
 * area dragged out is the picture the editor opens on; that Save and Save as
 * copy land on the issue the window was opened for, and on no other, even
 * after walking off to another page; and that the window is a window —
 * minimised, maximised and restored without losing anything.
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

/** + New snip → drag an area → the editor, open on it. */
async function newSnip(page: Page): Promise<Locator> {
  await snipWindow(page).getByRole("button", { name: "New snip" }).click();
  await dragArea(page);
  const editor = page.getByRole("dialog", { name: "Edit screenshot" });
  await expect(editor).toBeVisible();
  await expect(editor.locator("canvas").first()).toBeVisible();
  return editor;
}

/**
 * Chooses a source by its card, the way a person does. The radio inside is
 * visually hidden and the card is its label, so the label is what is clicked.
 */
async function chooseSource(snip: Locator, name: string) {
  await snip.locator("label").filter({ hasText: new RegExp(`^${name}`) }).click();
  await expect(snip.getByRole("radio", { name: new RegExp(`^${name}`) })).toBeChecked();
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

  test("Screenshot opens the window on a choice of source, without capturing", async ({
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
    await expect(page.getByRole("dialog", { name: "Edit screenshot" })).toBeHidden();
    expect(
      await page.evaluate(
        () => (window as unknown as { __displayMediaCalls: unknown[] }).__displayMediaCalls.length,
      ),
    ).toBe(0);

    /* The two that are offered whatever the page turns out to hold, and this
       tab is the one chosen. */
    for (const name of ["This tab", "Another tab or window"]) {
      await expect(
        snip.getByRole("radio", { name: new RegExp(`^${name}`) }),
      ).toHaveCount(1);
    }
    await expect(snip.getByRole("radio", { name: /^This tab/ })).toBeChecked();

    /*
     * And those two are the whole of it. Prio's own pages were briefly offered
     * here as a third kind of source, under a "Primary" heading read off the
     * sidebar — a second, worse copy of navigation the application already
     * has. Going to a page is something you do in the application; this window
     * only decides what to point the camera at.
     */
    await expect(snip.getByText("Primary", { exact: true })).toHaveCount(0);
    await expect(snip.getByRole("radio")).toHaveCount(2);
    for (const name of ["Home", "Projects", "Issues", "Reports"]) {
      await expect(
        snip.getByRole("radio", { name: new RegExp(`^${name}`) }),
        `${name} is not a capture source`,
      ).toHaveCount(0);
    }
    await expect(snip.getByRole("button", { name: "New snip" })).toBeEnabled();

    // Minimise, restore, maximise, restore — the choice survives all of it.
    await chooseSource(snip, "Another tab or window");
    await snip.getByRole("button", { name: "Minimise Snip Tool" }).click();
    await expect(snip.getByRole("button", { name: "New snip" })).toBeHidden();
    await snip.getByRole("button", { name: "Restore Snip Tool" }).click();
    await expect(snip.getByRole("radio", { name: /^Another tab or window/ })).toBeChecked();

    const floating = (await snip.boundingBox())!;
    await snip.getByRole("button", { name: "Maximise Snip Tool" }).click();
    const big = (await snip.boundingBox())!;
    expect(big.width).toBeGreaterThan(floating.width * 2);
    expect(big.height).toBeGreaterThan(floating.height);
    await expect(snip.getByRole("radio", { name: /^Another tab or window/ })).toBeChecked();
    await snip.getByRole("button", { name: "Restore Snip Tool size" }).click();
    const restored = (await snip.boundingBox())!;
    expect(Math.round(restored.width)).toBe(Math.round(floating.width));

    // Close still closes.
    await snip.getByRole("button", { name: "Close Snip Tool" }).click();
    await expect(snip).toBeHidden();

    expect(consoleErrors).toEqual([]);
  });

  test("New snip → area → editor → Save lands on the same issue, and Save again updates it", async ({
    page,
  }) => {
    const { consoleErrors } = watchForProblems(page);
    const { issueId } = await openAnIssue(page);
    const before = await prisma.attachment.count({ where: { issueId } });

    await openScreenshot(page);
    const snip = snipWindow(page);

    const editor = await newSnip(page);
    // The picker was asked to lead with this tab.
    const calls = await page.evaluate(
      () => (window as unknown as { __displayMediaCalls: { preferCurrentTab?: boolean }[] }).__displayMediaCalls,
    );
    expect(calls.at(-1)?.preferCurrentTab).toBe(true);

    /* The editor opened on the dragged area, not the whole 640×400 frame:
       60% by 40% of it. Crop is the tool armed, as it always has been. */
    const size = await editor
      .locator("canvas")
      .first()
      .evaluate((canvas: HTMLCanvasElement) => [canvas.width, canvas.height]);
    expect(size[0]).toBeGreaterThan(280);
    expect(size[0]).toBeLessThan(360);
    expect(size[1]).toBeGreaterThan(130);
    expect(size[1]).toBeLessThan(190);
    await expect(editor.getByRole("button", { name: "Crop", exact: true })).toHaveAttribute(
      "data-active",
      "true",
    );

    // A mark with an existing tool, then Save.
    await editor.getByRole("button", { name: "Rectangle" }).click();
    const canvas = editor.locator("canvas").nth(1);
    const area = (await canvas.boundingBox())!;
    await page.mouse.move(area.x + 20, area.y + 20);
    await page.mouse.down();
    await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2, { steps: 5 });
    await page.mouse.up();
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor).toBeHidden();

    await expect(snip.getByRole("status")).toContainText("Saved");
    await expect.poll(() => prisma.attachment.count({ where: { issueId } })).toBe(before + 1);

    const saved = await prisma.attachment.findFirstOrThrow({
      where: { issueId },
      orderBy: { createdAt: "desc" },
      select: { id: true, filename: true, storageKey: true },
    });
    createdAttachmentNames.push(saved.filename);
    expect(saved.filename).toMatch(/^screenshot-.*\.png$/);
    // Visible in the issue's own Attachments without a reload.
    await expect(page.locator(".prio-attachment").filter({ hasText: saved.filename })).toHaveCount(1);

    // Edit it again from the window, and Save: the same attachment, updated.
    await snip.getByRole("button", { name: `Edit ${saved.filename}` }).click();
    const again = page.getByRole("dialog", { name: "Edit screenshot" });
    await expect(again).toBeVisible();
    await again.getByRole("button", { name: "Save", exact: true }).click();
    await expect(again).toBeHidden();
    await expect(snip.getByRole("status")).toContainText("Updated");

    await expect.poll(() => prisma.attachment.count({ where: { issueId } })).toBe(before + 1);
    await expect
      .poll(async () =>
        (await prisma.attachment.findUniqueOrThrow({ where: { id: saved.id }, select: { storageKey: true } }))
          .storageKey,
      )
      .not.toBe(saved.storageKey);

    expect(consoleErrors).toEqual([]);
  });

  test("Save as copy keeps the original and adds an -annotated copy to the same issue", async ({
    page,
  }) => {
    const { consoleErrors } = watchForProblems(page);
    const { issueId } = await openAnIssue(page);
    const before = await prisma.attachment.count({ where: { issueId } });

    await openScreenshot(page);
    const snip = snipWindow(page);
    const editor = await newSnip(page);
    await editor.getByRole("button", { name: "Save as copy" }).click();
    await expect(editor).toBeHidden();

    await expect(snip.getByRole("status")).toContainText("-annotated");
    await expect.poll(() => prisma.attachment.count({ where: { issueId } })).toBe(before + 2);

    const newest = await prisma.attachment.findMany({
      where: { issueId },
      orderBy: { createdAt: "desc" },
      take: 2,
      select: { filename: true },
    });
    const names = newest.map((row) => row.filename).sort();
    createdAttachmentNames.push(...names);
    const original = names.find((name) => !name.includes("-annotated"))!;
    expect(names).toContain(original.replace(/\.png$/, "-annotated.png"));

    // Both are rows in the window, and both say where they went.
    await expect(snipRows(snip)).toHaveCount(2);

    expect(consoleErrors).toEqual([]);
  });

  test("each New snip is separate, and the issue stays the one it was opened for across navigation", async ({
    page,
  }) => {
    const { consoleErrors } = watchForProblems(page);
    const { key, issueId } = await openAnIssue(page);
    const before = await prisma.attachment.count({ where: { issueId } });

    await openScreenshot(page);
    const snip = snipWindow(page);

    // Snip one, from this tab.
    let editor = await newSnip(page);
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor).toBeHidden();
    await expect.poll(() => prisma.attachment.count({ where: { issueId } })).toBe(before + 1);

    /* Walk off to another page, the ordinary way — through Prio's own sidebar.
       The window is mounted by the shell rather than by the page, so it comes
       along, and it is still for the issue it was opened on. */
    await page.locator('.prio-sidebar a[href="/projects"]').click();
    await expect(page).toHaveURL(/\/projects$/);
    await expect(snip).toContainText(key);
    await expect(snip.getByRole("radio", { name: /^This tab/ })).toBeChecked();

    // Snip two, of that page, saved while the issue is not on screen.
    editor = await newSnip(page);
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor).toBeHidden();
    await expect.poll(() => prisma.attachment.count({ where: { issueId } })).toBe(before + 2);

    // Two rows, two different files, both on that issue and no other.
    const rows = snipRows(snip);
    await expect(rows).toHaveCount(2);
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
      await expect(page.locator(".prio-attachment").filter({ hasText: row.filename })).toHaveCount(1);
    }

    expect(consoleErrors).toEqual([]);
  });

  test("Another tab or window asks the browser's picker without leading with this tab", async ({
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

    /* Choosing the source is what opens the picker — the share is arranged up
       front, so the person can go and find what they want a picture of. */
    await chooseSource(snip, "Another tab or window");

    const afterChoosing = await pickerCalls();
    expect(afterChoosing).toHaveLength(1);
    expect(afterChoosing.at(-1)?.preferCurrentTab).not.toBe(true);
    expect(afterChoosing.at(-1)?.selfBrowserSurface).toBe("exclude");

    // The window says what it is holding, and offers the way out of it.
    await expect(snip.getByText(/^Sharing/)).toBeVisible();

    await snip.getByRole("button", { name: "New snip" }).click();
    const selector = page.getByRole("dialog", { name: "Select area to snip" });
    await expect(selector).toBeVisible();

    /*
     * And the snip came from the surface already being shared: the picker was
     * not asked a second time. That is the whole point of retaining it — being
     * re-prompted per snip would both interrupt and undo the navigation the
     * person just did to reach what they wanted.
     */
    expect(await pickerCalls()).toHaveLength(1);

    // Escape cancels the snip without making one, and keeps the share.
    await page.keyboard.press("Escape");
    await expect(selector).toBeHidden();
    await expect(snip).toBeVisible();
    await expect(snipRows(snip)).toHaveCount(0);
    await expect(snip.getByText(/^Sharing/)).toBeVisible();

    /* Stopping is the person's to do, and hands the source back to this tab. */
    await snip.getByRole("button", { name: "Stop sharing" }).click();
    await expect(snip.getByText(/^Sharing/)).toHaveCount(0);
    await expect(snip.getByRole("radio", { name: /^This tab/ })).toBeChecked();
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

  test("snips stage as separate rows, and Save as copy stages the original and its copy", async ({
    page,
  }) => {
    const { consoleErrors } = watchForProblems(page);
    const dialog = await openCreateWithDraft(page, `Many snips ${Date.now()}`);

    await dialog.getByRole("button", { name: "Add files" }).click();
    await page.getByRole("menuitem", { name: "Screenshot" }).click();
    const snip = snipWindow(page);
    await expect(snip).toContainText("New issue");

    const rows = dialog.getByRole("button", { name: /Annotate|Edit markup/ });

    let editor = await newSnip(page);
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor).toBeHidden();
    await expect(rows).toHaveCount(1);

    editor = await newSnip(page);
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor).toBeHidden();
    await expect(rows).toHaveCount(2);

    editor = await newSnip(page);
    await editor.getByRole("button", { name: "Save as copy" }).click();
    await expect(editor).toBeHidden();
    await expect(rows).toHaveCount(4);

    const names = await dialog
      .getByRole("link", { name: /^Open .+ in a new tab$/ })
      .evaluateAll((links) => links.map((link) => link.getAttribute("aria-label")));
    expect(names).toHaveLength(4);
    expect(new Set(names).size).toBe(4);
    expect(names.filter((name) => /-annotated\.png/.test(name ?? ""))).toHaveLength(1);

    /* Saving a staged snip again writes over its row rather than adding one. */
    const first = (await snipRows(snip).first().locator("[title]").first().getAttribute("title"))!;
    await snip.getByRole("button", { name: `Edit ${first}` }).click();
    editor = page.getByRole("dialog", { name: "Edit screenshot" });
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor).toBeHidden();
    await expect(rows).toHaveCount(4);

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

    const editor = await newSnip(page);
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor).toBeHidden();
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

  test("Record runs a timer, stops to a preview, and attaches as a WebM", async ({
    page,
  }) => {
    const { consoleErrors } = watchForProblems(page);

    const dialog = await openCreateWithDraft(page, `Recorded ${Date.now()}`);

    await dialog.getByRole("button", { name: "Add files" }).click();
    await page.getByRole("menuitem", { name: "Record" }).click();

    const snip = snipWindow(page);
    await expect(snip.getByRole("status")).toContainText("Recording");
    await expect(snip.getByRole("button", { name: "Stop recording" })).toBeVisible();
    await expect(snip.getByRole("button", { name: "Discard" })).toBeVisible();

    /* Long enough for the recorder's one-second timeslice to deliver a chunk;
       a stop before that produces an empty blob and a refusal instead. */
    await page.waitForTimeout(1_600);
    await expect(snip.getByRole("status")).not.toContainText("Recording 0:00");

    await snip.getByRole("button", { name: "Stop recording" }).click();

    /* A recording previews as a video and offers no Annotate — the editor is
       for stills. */
    await expect(snip.locator("video")).toBeVisible();
    await expect(snip.getByRole("button", { name: "Annotate" })).toHaveCount(0);
    await expect(snip.getByRole("button", { name: "Attach" })).toBeVisible();

    await snip.getByRole("button", { name: "Attach" }).click();
    await expect(snip.getByRole("button", { name: "Attach" })).toBeHidden();

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
