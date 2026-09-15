import {
  expect,
  request as apiRequest,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { watchForProblems } from "./support";

/**
 * Opening a picture or a video from a link (§ Attachments).
 *
 * An attachment link out of the Excel export — or a filename clicked inside
 * Prio — is a page navigation to `/api/attachments/<id>/<name>`. Answered with
 * raw bytes, the browser showed the file with its own viewer document, under
 * the file's locked-down Content-Security-Policy: pictures came out pinned to
 * the top-left corner, and MP4s as a black player with "default-src 'none'"
 * and "frame is sandboxed" errors in the console.
 *
 * These pin the fix end to end, in a real browser against the running app:
 * the navigation lands in Prio's own viewer, the picture is centred on the
 * whole window and scaled to fit, Ctrl + / Ctrl - zoom the picture and only
 * the picture, a video plays in a plain `<video>`, and the file route still
 * answers `<img>`, `<video>`, ranges and downloads as before — to signed-in
 * readers only.
 */

const created: string[] = [];

test.afterAll(async () => {
  if (created.length > 0) {
    await prisma.attachment.deleteMany({ where: { id: { in: created } } });
  }
});

async function firstEngIssue() {
  return prisma.issue.findFirstOrThrow({
    where: { project: { key: "ENG" } },
    select: { id: true, key: true },
    orderBy: { number: "asc" },
  });
}

/** A PNG of the given size, drawn by the browser itself. */
async function png(page: Page, width: number, height: number): Promise<Buffer> {
  const dataUrl = await page.evaluate(
    ([w, h]) => {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#3b82f6";
      context.fillRect(0, 0, w, h);
      context.fillStyle = "#ffffff";
      context.fillRect(w * 0.25, h * 0.25, w * 0.5, h * 0.5);
      return canvas.toDataURL("image/png");
    },
    [width, height] as const,
  );
  return Buffer.from(dataUrl.split(",")[1]!, "base64");
}

async function upload(
  request: APIRequestContext,
  issueId: string,
  name: string,
  mimeType: string,
  buffer: Buffer,
): Promise<{ id: string; filename: string }> {
  const response = await request.post("/api/attachments", {
    multipart: { issueId, file: { name, mimeType, buffer } },
  });
  expect(response.status(), await response.text()).toBe(200);
  const body = (await response.json()) as { id: string; filename: string };
  created.push(body.id);
  return body;
}

/** The smallest thing the server accepts as an MP4: "ftyp" at offset 4. */
function fakeMp4(sizeBytes: number): Buffer {
  const buffer = Buffer.alloc(sizeBytes, 0x41);
  buffer.writeUInt32BE(sizeBytes, 0);
  buffer.write("ftyp", 4, "ascii");
  buffer.write("isom", 8, "ascii");
  return buffer;
}

/** Remembers whether the last keydown to reach the window was held off. */
async function watchKeys(page: Page) {
  await page.evaluate(() => {
    window.addEventListener("keydown", (event) => {
      (window as unknown as { __lastKeyPrevented?: boolean }).__lastKeyPrevented =
        event.defaultPrevented;
    });
  });
}

async function lastKeyPrevented(page: Page) {
  return page.evaluate(
    () => (window as unknown as { __lastKeyPrevented?: boolean }).__lastKeyPrevented,
  );
}

async function expectCentred(page: Page, selector: string) {
  const viewport = page.viewportSize()!;
  /* Let the zoom transition and layout settle before measuring. */
  await page.waitForTimeout(250);
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  const box = (await page.locator(selector).boundingBox())!;
  expect(Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(2);
  expect(Math.abs(box.y + box.height / 2 - viewport.height / 2)).toBeLessThanOrEqual(2);
  return box;
}

test.describe("An image attachment opened from a link", () => {
  test("lands in Prio's viewer, centred on the window and fitted to it", async ({
    page,
  }) => {
    const { consoleErrors } = watchForProblems(page);
    await page.goto("/");
    const issue = await firstEngIssue();
    const large = await upload(
      page.request,
      issue.id,
      `viewer-large-${Date.now()}.png`,
      "image/png",
      await png(page, 2400, 1200),
    );

    // The URL the export writes, with the filename on the end.
    await page.goto(`/api/attachments/${large.id}/${encodeURIComponent(large.filename)}`);
    await expect(page).toHaveURL(new RegExp(`/attachments/${large.id}$`));

    const viewer = page.getByRole("dialog", { name: large.filename });
    await expect(viewer).toBeVisible();
    const image = page.locator(".prio-lightbox__image");
    await expect
      .poll(() => image.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth))
      .toBe(2400);

    const viewport = page.viewportSize()!;
    const box = await expectCentred(page, ".prio-lightbox__image");
    // Scaled down to fit, never stretched: the 2:1 picture is still 2:1.
    expect(box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.height).toBeLessThanOrEqual(viewport.height);
    expect(box.width / box.height).toBeGreaterThan(1.97);
    expect(box.width / box.height).toBeLessThan(2.03);

    expect(consoleErrors).toEqual([]);
  });

  test("Ctrl + and Ctrl - zoom the picture only, and leave page zoom alone once closed", async ({
    page,
  }) => {
    await page.goto("/");
    const issue = await firstEngIssue();
    const file = await upload(
      page.request,
      issue.id,
      `viewer-zoom-${Date.now()}.png`,
      "image/png",
      await png(page, 1600, 900),
    );

    await page.goto(`/api/attachments/${file.id}/${encodeURIComponent(file.filename)}`);
    const viewer = page.getByRole("dialog", { name: file.filename });
    await expect(viewer).toBeVisible();
    await watchKeys(page);

    const level = page.locator(".prio-lightbox__level");
    await expect(level).toHaveText("100%");
    const pageWidth = await page.evaluate(() => document.documentElement.clientWidth);

    await page.keyboard.press("Control+Equal");
    await expect(level).toHaveText("125%");
    expect(await lastKeyPrevented(page), "the browser's zoom was held off").toBe(true);
    await expect
      .poll(() => page.locator(".prio-lightbox__image").evaluate((el) => (el as HTMLElement).style.transform))
      .toContain("scale(1.25)");

    await page.keyboard.press("Control+Equal");
    await expect(level).toHaveText("150%");
    // Still centred while zoomed: it grows about its own middle.
    await page.waitForTimeout(250);
    await expectCentred(page, ".prio-lightbox__image");

    await page.keyboard.press("Control+Minus");
    await expect(level).toHaveText("125%");
    await page.keyboard.press("Control+Minus");
    await expect(level).toHaveText("100%");

    // The page itself never changed size.
    expect(await page.evaluate(() => document.documentElement.clientWidth)).toBe(pageWidth);

    // The existing controls still work beside the keys.
    await viewer.getByRole("button", { name: "Zoom in" }).click();
    await expect(level).toHaveText("125%");
    await viewer.getByRole("button", { name: "Reset zoom to fit" }).click();
    await expect(level).toHaveText("100%");

    // Close goes back to the issue the file belongs to…
    await page.keyboard.press("Escape");
    await expect(page).toHaveURL(new RegExp(`/issues/${issue.key.toLowerCase()}`));

    // …where Ctrl + is the browser's again, untouched.
    await watchKeys(page);
    await page.keyboard.press("Control+Equal");
    expect(await lastKeyPrevented(page)).toBe(false);
  });

  test("a small picture keeps its own size, centred, in dark mode too", async ({
    page,
  }) => {
    /* Dark is a stored choice in Prio, not the system preference. */
    await page.addInitScript(() => localStorage.setItem("prio-theme", "dark"));
    await page.goto("/");
    const issue = await firstEngIssue();
    const small = await upload(
      page.request,
      issue.id,
      `viewer-small-${Date.now()}.png`,
      "image/png",
      await png(page, 160, 90),
    );

    await page.goto(`/api/attachments/${small.id}`);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.getByRole("dialog", { name: small.filename })).toBeVisible();
    const box = await expectCentred(page, ".prio-lightbox__image");
    expect(Math.round(box.width)).toBe(160);
    expect(Math.round(box.height)).toBe(90);
  });

  test("the issue page's own thumbnail opens the same viewer, centred, with the same zoom", async ({
    page,
  }) => {
    await page.goto("/");
    const issue = await firstEngIssue();
    const file = await upload(
      page.request,
      issue.id,
      `viewer-inline-${Date.now()}.png`,
      "image/png",
      await png(page, 1200, 800),
    );

    await page.goto(`/issues/${issue.key.toLowerCase()}`);
    await page.getByRole("button", { name: `Open ${file.filename}` }).click();
    await expect(page.getByRole("dialog", { name: file.filename })).toBeVisible();
    await expectCentred(page, ".prio-lightbox__image");

    await page.keyboard.press("Control+Equal");
    await expect(page.locator(".prio-lightbox__level")).toHaveText("125%");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: file.filename })).toBeHidden();
    // Still on the issue: in-page, closing only closes.
    await expect(page).toHaveURL(new RegExp(`/issues/${issue.key.toLowerCase()}`));
  });
});

test.describe("A video attachment's response", () => {
  test("is playable media for a <video>, and a page navigation goes to the viewer", async ({
    request,
  }) => {
    const issue = await firstEngIssue();
    const video = await upload(
      request,
      issue.id,
      `headers-${Date.now()}.mp4`,
      "video/mp4",
      fakeMp4(4096),
    );
    const url = `/api/attachments/${video.id}`;

    // What a <video> element asks for.
    const media = await request.get(url, {
      headers: { "Sec-Fetch-Dest": "video", Range: "bytes=0-99" },
    });
    expect(media.status()).toBe(206);
    expect(media.headers()["content-type"]).toBe("video/mp4");
    expect(media.headers()["content-disposition"]).toContain("inline");
    expect(media.headers()["accept-ranges"]).toBe("bytes");
    expect(media.headers()["content-range"]).toBe("bytes 0-99/4096");
    const csp = media.headers()["content-security-policy"] ?? "";
    expect(csp).toContain("media-src 'self'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("sandbox");
    expect(media.headers()["vary"] ?? "").toContain("Sec-Fetch-Dest");

    // What opening the link in a tab asks for.
    const opened = await request.get(url, {
      headers: { "Sec-Fetch-Dest": "document" },
      maxRedirects: 0,
    });
    expect(opened.status()).toBe(303);
    expect(opened.headers()["location"]).toBe(`/attachments/${video.id}`);

    // A download, or a caller that says nothing, still gets the bytes.
    const plain = await request.get(url);
    expect(plain.status()).toBe(200);
    expect((await plain.body()).length).toBe(4096);
  });

  test("anything that is not a picture or video keeps its lock-down and is never redirected", async ({
    request,
  }) => {
    const issue = await firstEngIssue();
    const pdf = await upload(
      request,
      issue.id,
      `headers-${Date.now()}.pdf`,
      "application/pdf",
      Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"),
    );

    const response = await request.get(`/api/attachments/${pdf.id}`, {
      headers: { "Sec-Fetch-Dest": "document" },
      maxRedirects: 0,
    });
    expect(response.status()).toBe(200);
    expect(response.headers()["content-security-policy"]).toContain("sandbox");
  });

  test("the viewer page is for signed-in readers only", async ({ request }, testInfo) => {
    const issue = await firstEngIssue();
    const video = await upload(
      request,
      issue.id,
      `private-${Date.now()}.mp4`,
      "video/mp4",
      fakeMp4(1024),
    );

    const anonymous = await apiRequest.newContext({
      baseURL: testInfo.project.use.baseURL,
      storageState: { cookies: [], origins: [] },
    });
    for (const path of [`/attachments/${video.id}`, `/api/attachments/${video.id}`]) {
      const response = await anonymous.get(path, {
        headers: { "Sec-Fetch-Dest": "document" },
        maxRedirects: 0,
      });
      expect(response.status(), path).not.toBe(200);
      expect(response.headers()["location"] ?? "", path).toContain("/sign-in");
    }
    await anonymous.dispose();

    // An id that does not exist is not found, rather than redirected anywhere.
    const missing = await request.get("/attachments/does-not-exist", { maxRedirects: 0 });
    expect(missing.status()).toBe(200);
    expect(await missing.text()).toMatch(/not found|could not be found|404/i);
  });
});
