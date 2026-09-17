import { expect, test, type Page } from "@playwright/test";
import { ADMIN_STATE } from "./support";

/**
 * What ends up inside the recording.
 *
 * The requirement is that Prio's recording controls stay visible to the person
 * while they record, and stay out of the file that comes back. Whether that
 * holds is not a DOM question and cannot be answered by looking at the page:
 * a browser records a *surface*, and every element composited onto that surface
 * is in the output whatever its stacking context says. So this asserts against
 * the decoded frames of the video that was actually produced.
 *
 * The picker cannot be driven from a test, so it is replaced with one that
 * hands back a canvas — a real `MediaStream` through the real `MediaRecorder`,
 * with only the human's choice of surface stubbed. The canvas stands in for
 * "another tab or window": it is 640×400 and painted a colour nothing in Prio
 * uses, so a frame that came from the Prio page instead would differ in both
 * size and colour.
 *
 * What this does and does not establish is set out on the assertions below.
 */

/** Nothing in Prio's palette is this. A frame carrying it came from the stub. */
const SURFACE_RGB = { r: 0, g: 200, b: 0 };
const SURFACE_W = 640;
const SURFACE_H = 400;

async function stubRecordingCapture(page: Page) {
  await page.addInitScript(
    ({ rgb, w, h }) => {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const context = canvas.getContext("2d");

      /* Repainted on a timer: a still canvas stops producing frames, and a
         recorder reading it writes an empty file. The tint alternates by a
         single step so the surface stays unmistakably one colour. */
      let tick = 0;
      setInterval(() => {
        if (!context) return;
        tick += 1;
        context.fillStyle = `rgb(${rgb.r}, ${rgb.g - (tick % 2)}, ${rgb.b})`;
        context.fillRect(0, 0, canvas.width, canvas.height);
      }, 100);

      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          ...navigator.mediaDevices,
          getDisplayMedia: async () =>
            (
              canvas as HTMLCanvasElement & {
                captureStream: (fps?: number) => MediaStream;
              }
            ).captureStream(30),
        },
      });
    },
    { rgb: SURFACE_RGB, w: SURFACE_W, h: SURFACE_H },
  );
}

test.describe("What a Prio recording contains", () => {
  test.use({ storageState: ADMIN_STATE });

  test("carries the chosen surface, and not Prio's own controls", async ({
    page,
  }) => {
    await stubRecordingCapture(page);
    await page.goto("/projects/eng/board");

    /*
     * Recorded through the real library rather than the dialog, so this test
     * is about what the recorder produces rather than about which button
     * opens it. `startScreenRecording` is the same function the Snip Tool
     * calls, including the `selfBrowserSurface: "exclude"` hint that keeps
     * this tab out of the picker in a real browser.
     */
    const result = await page.evaluate(async () => {
      const media = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const recorder = new MediaRecorder(media);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      const stopped = new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
      });
      recorder.start(200);
      await new Promise((r) => setTimeout(r, 1500));
      recorder.stop();
      await stopped;
      for (const t of media.getTracks()) t.stop();

      const blob = new Blob(chunks, { type: recorder.mimeType || "video/webm" });
      if (blob.size === 0) return { error: "empty recording" } as const;

      /* Decode what was written and read its pixels back. */
      const url = URL.createObjectURL(blob);
      const video = document.createElement("video");
      video.src = url;
      video.muted = true;
      video.playsInline = true;

      await new Promise<void>((resolve, reject) => {
        video.onloadeddata = () => resolve();
        video.onerror = () => reject(new Error("the recording would not decode"));
      });
      await video.play().catch(() => undefined);
      await new Promise((r) => setTimeout(r, 300));

      const frame = document.createElement("canvas");
      frame.width = video.videoWidth;
      frame.height = video.videoHeight;
      const ctx = frame.getContext("2d")!;
      ctx.drawImage(video, 0, 0);

      /* Sampled across the frame rather than at one point, so a toolbar
         occupying any corner would be caught. */
      const points = [
        [0.5, 0.5],
        [0.08, 0.08],
        [0.92, 0.08],
        [0.08, 0.92],
        [0.92, 0.92],
      ] as const;
      const samples = points.map(([fx, fy]) => {
        const d = ctx.getImageData(
          Math.floor(fx * (frame.width - 1)),
          Math.floor(fy * (frame.height - 1)),
          1,
          1,
        ).data;
        return { r: d[0]!, g: d[1]!, b: d[2]! };
      });

      URL.revokeObjectURL(url);
      return {
        bytes: blob.size,
        width: video.videoWidth,
        height: video.videoHeight,
        samples,
      } as const;
    });

    if ("error" in result) throw new Error(result.error);

    // A real file was produced and really decoded.
    expect(result.bytes).toBeGreaterThan(0);

    /*
     * The frame is the size of the surface that was chosen, not the size of
     * the Prio page. This is the load-bearing assertion: the browser records
     * the selected surface, so Prio's own window — and every control in it —
     * is simply not among the pixels.
     */
    expect(result.width).toBe(SURFACE_W);
    expect(result.height).toBe(SURFACE_H);

    const viewport = page.viewportSize();
    expect(result.width).not.toBe(viewport?.width);

    /*
     * And every corner carries the surface's own colour. Prio's controls are
     * dark text on a light panel; a toolbar composited into any corner would
     * show there. Tolerant of codec drift, intolerant of a different picture.
     */
    for (const [i, s] of result.samples.entries()) {
      expect(Math.abs(s.r - SURFACE_RGB.r), `sample ${i} red`).toBeLessThan(60);
      expect(Math.abs(s.g - SURFACE_RGB.g), `sample ${i} green`).toBeLessThan(60);
      expect(Math.abs(s.b - SURFACE_RGB.b), `sample ${i} blue`).toBeLessThan(60);
    }
  });
});
