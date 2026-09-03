import { expect, test, type Page } from "@playwright/test";
import { prisma } from "@/lib/prisma";

/**
 * Video attachments: the progress bar, and the 30 MB ceiling.
 *
 * Both are things you can only see while an upload is in flight, so the
 * response is held open deliberately — without that, a small file is finished
 * before the bar has painted and the test would be asserting against an empty
 * list rather than a running upload.
 */

/** The smallest thing the server will accept as an MP4: "ftyp" at offset 4. */
function mp4(sizeBytes = 64): Buffer {
  const buffer = Buffer.alloc(sizeBytes, 0x41);
  buffer.write("ftyp", 4, "ascii");
  buffer.write("isom", 8, "ascii");
  buffer.writeUInt32BE(sizeBytes, 0);
  return buffer;
}

/*
 * Files created here are removed again. The panel under test is on a shared
 * fixture issue, and an upload test that leaves its uploads behind makes that
 * issue heavier on every run — which is somebody else's flaky test later.
 */
const uploaded: string[] = [];

test.afterEach(async () => {
  if (uploaded.length > 0) {
    await prisma.attachment.deleteMany({
      where: { filename: { in: uploaded } },
    });
    uploaded.length = 0;
  }
});

async function anIssueKey(): Promise<string> {
  const issue = await prisma.issue.findFirstOrThrow({
    where: { project: { key: "ENG" } },
    select: { key: true },
    orderBy: { number: "asc" },
  });
  return issue.key.toLowerCase();
}

async function openIssue(page: Page) {
  await page.goto(`/issues/${await anIssueKey()}`);
  await expect(page.locator(".prio-dropzone")).toBeVisible();
}

test.describe("Uploading a video", () => {
  test("shows a green progress bar that tracks the upload", async ({ page }) => {
    await openIssue(page);

    /* Held open just long enough to observe the bar. The request still
       reaches the server and still completes — nothing about the upload is
       stubbed, only its timing. */
    await page.route("**/api/attachments", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      await route.continue();
    });

    const name = `clip-${Date.now()}.mp4`;
    uploaded.push(name);
    await page
      .locator('input[aria-label="Attach files to this issue"]')
      .setInputFiles({ name, mimeType: "video/mp4", buffer: mp4() });

    const bar = page.locator(".prio-dropzone__progress .prio-progress");
    await expect(bar).toBeVisible({ timeout: 10_000 });

    // Marked as a video, which is what the colour rule keys on.
    await expect(bar).toHaveAttribute("data-kind", "video");

    // And it really resolves to green, not the brand gradient every other
    // progress bar in Prio uses.
    const fill = bar.locator(".prio-progress__bar");
    const background = await fill.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    const [r, g, b] = background
      .match(/\d+/g)!
      .slice(0, 3)
      .map(Number) as [number, number, number];
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);

    // A real progressbar, reporting a real percentage.
    await expect(bar).toHaveAttribute("role", "progressbar");
    const percent = Number(await bar.getAttribute("aria-valuenow"));
    expect(percent).toBeGreaterThanOrEqual(0);
    expect(percent).toBeLessThanOrEqual(100);

    /* The held request is released by the handler's own timer — unrouting
       here would abandon a route that is still in flight. */
    // Completion is unchanged: the file lands in the attachment list.
    await expect(
      page.locator(".prio-attachment").filter({ hasText: name }),
    ).toBeVisible({ timeout: 30_000 });
  });

  test("keeps the brand bar for a non-video attachment", async ({ page }) => {
    await openIssue(page);

    await page.route("**/api/attachments", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      await route.continue();
    });

    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const name = `shot-${Date.now()}.png`;
    uploaded.push(name);
    await page
      .locator('input[aria-label="Attach files to this issue"]')
      .setInputFiles({ name, mimeType: "image/png", buffer: png });

    const bar = page.locator(".prio-dropzone__progress .prio-progress");
    await expect(bar).toBeVisible({ timeout: 10_000 });
    await expect(bar).toHaveAttribute("data-kind", "image");
  });

  test("refuses a video over 30 MB, with the panel's own error", async ({
    page,
  }) => {
    await openIssue(page);

    const oversize = mp4(30 * 1024 * 1024 + 1024);
    await page
      .locator('input[aria-label="Attach files to this issue"]')
      .setInputFiles({
        name: "too-big.mp4",
        mimeType: "video/mp4",
        buffer: oversize,
      });

    await expect(page.locator(".prio-dropzone .prio-composer__error")).toContainText(
      /30 MB/,
      { timeout: 20_000 },
    );

    // Refused means refused: nothing was attached.
    await expect(
      page.locator(".prio-attachment").filter({ hasText: "too-big.mp4" }),
    ).toHaveCount(0);
  });
});
