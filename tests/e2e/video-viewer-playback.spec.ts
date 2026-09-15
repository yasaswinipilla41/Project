import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { watchForProblems } from "./support";

/**
 * Real video playback in the attachment viewer, in branded Chrome.
 *
 * Playwright's bundled Chromium has no H.264, so an MP4 is only meaningful in
 * the browser people actually use; the channel is set for the whole file
 * because a browser channel needs a worker of its own. The video is recorded by
 * that browser from a canvas, uploaded as an ordinary attachment, and opened by
 * URL the way an Excel export link opens it — through the same redirect to the
 * viewer, the same authorised route, and the same Content-Security-Policy that
 * used to leave an MP4 as a black player.
 */
test.use({ channel: "chrome" });

const created: string[] = [];

test.afterAll(async () => {
  if (created.length > 0) {
    await prisma.attachment.deleteMany({ where: { id: { in: created } } });
  }
});

async function upload(
  request: APIRequestContext,
  name: string,
  mimeType: string,
  buffer: Buffer,
): Promise<{ id: string; filename: string }> {
  const issue = await prisma.issue.findFirstOrThrow({
    where: { project: { key: "ENG" } },
    select: { id: true },
    orderBy: { number: "asc" },
  });
  const response = await request.post("/api/attachments", {
    multipart: { issueId: issue.id, file: { name, mimeType, buffer } },
  });
  expect(response.status(), await response.text()).toBe(200);
  const body = (await response.json()) as { id: string; filename: string };
  created.push(body.id);
  return body;
}

async function record(
  page: Page,
  types: string[],
): Promise<{ base64: string; type: string } | null> {
  return page.evaluate(async (candidates) => {
    const type = candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate));
    if (!type) return null;

    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 240;
    const context = canvas.getContext("2d")!;
    let frame = 0;
    const timer = setInterval(() => {
      frame += 1;
      context.fillStyle = `hsl(${(frame * 12) % 360} 70% 50%)`;
      context.fillRect(0, 0, 320, 240);
      context.fillStyle = "#fff";
      context.font = "32px sans-serif";
      context.fillText(String(frame), 20, 50);
    }, 33);

    const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: type });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    const stopped = new Promise((resolve) => {
      recorder.onstop = resolve;
    });
    recorder.start(250);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    recorder.stop();
    await stopped;
    clearInterval(timer);

    const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return { base64: btoa(binary), type };
  }, types);
}

for (const format of [
  {
    label: "MP4",
    extension: "mp4",
    mime: "video/mp4",
    types: ["video/mp4;codecs=avc1.42E01E", "video/mp4;codecs=avc1", "video/mp4"],
  },
  {
    label: "WebM",
    extension: "webm",
    mime: "video/webm",
    types: ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"],
  },
]) {
  test(`an ${format.label} opened from its link plays in the viewer, with no CSP or sandbox errors`, async ({
    page,
  }) => {
    const consoleLines: string[] = [];
    page.on("console", (message) => consoleLines.push(`${message.type()}: ${message.text()}`));
    const { consoleErrors } = watchForProblems(page);

    await page.goto("/");
    const recorded = await record(page, format.types);
    test.skip(!recorded, `this browser cannot record ${format.label}`);

    const file = await upload(
      page.request,
      `playback-${Date.now()}.${format.extension}`,
      format.mime,
      Buffer.from(recorded!.base64, "base64"),
    );

    await page.goto(`/api/attachments/${file.id}/${encodeURIComponent(file.filename)}`);
    await expect(page).toHaveURL(new RegExp(`/attachments/${file.id}$`));

    const video = page.locator("video.prio-lightbox__video");
    await expect(video).toBeVisible();
    expect(await video.getAttribute("src")).toBe(`/api/attachments/${file.id}`);

    // Loaded, and actually playing: time moves.
    await expect
      .poll(() => video.evaluate((el: HTMLVideoElement) => el.readyState), { timeout: 15_000 })
      .toBeGreaterThanOrEqual(2);
    await video.evaluate((el: HTMLVideoElement) => {
      el.muted = true;
      return el.play();
    });
    await expect
      .poll(() => video.evaluate((el: HTMLVideoElement) => el.currentTime), { timeout: 15_000 })
      .toBeGreaterThan(0.3);
    expect(await video.evaluate((el: HTMLVideoElement) => el.videoWidth)).toBe(320);

    /* Seeking, where the file carries an index to seek with. A recording
       straight out of MediaRecorder often does not (its duration is unknown
       until played through); the HTTP ranges a seek needs are pinned
       separately in video-playback.spec. */
    const seekable = await video.evaluate((el: HTMLVideoElement) => ({
      duration: el.duration,
      ranges: el.seekable.length,
    }));
    if (Number.isFinite(seekable.duration) && seekable.ranges > 0) {
      const landed = await video.evaluate(
        (el: HTMLVideoElement) =>
          new Promise<number>((resolve) => {
            el.addEventListener("seeked", () => resolve(el.currentTime), { once: true });
            el.currentTime = Math.min(1, el.duration / 2);
          }),
      );
      expect(landed).toBeGreaterThan(0.2);
    } else {
      test.info().annotations.push({
        type: "seeking",
        description: `recorded ${format.label} has no index (duration ${seekable.duration}); seek not exercised in-player`,
      });
    }

    const blocked = consoleLines.filter((line) =>
      /Content Security Policy|media-src|sandboxed|allow-scripts/i.test(line),
    );
    expect(blocked).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
}
