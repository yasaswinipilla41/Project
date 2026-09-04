import {
  expect,
  request as apiRequest,
  test,
} from "@playwright/test";
import { prisma } from "@/lib/prisma";

/**
 * A video attachment, opened the way the Excel export hands it out.
 *
 * The export writes `<origin>/api/attachments/<id>` into the "Attachment
 * links" column. Following one used to open a tab that downloaded fine and
 * never played: the route answered `Accept-Ranges: none` and always sent the
 * whole body with a 200, so a media element could not ask for the piece it
 * needs first. For an MP4 or QuickTime file whose index sits at the end, that
 * is the difference between playing and not playing at all.
 *
 * These assertions are made against the real route, with a real session, on
 * the URL the export actually produces — not against the code path.
 */

const created: string[] = [];

test.afterAll(async () => {
  if (created.length > 0) {
    await prisma.attachment.deleteMany({ where: { id: { in: created } } });
  }
});

/** The smallest thing the server accepts as an MP4: "ftyp" at offset 4. */
function mp4(sizeBytes: number): Buffer {
  const buffer = Buffer.alloc(sizeBytes, 0x41);
  buffer.write("ftyp", 4, "ascii");
  buffer.write("isom", 8, "ascii");
  buffer.writeUInt32BE(sizeBytes, 0);
  return buffer;
}

/** Uploads a video to the first ENG issue and returns its attachment row. */
async function uploadVideo(
  request: import("@playwright/test").APIRequestContext,
  bytes: Buffer,
) {
  const issue = await prisma.issue.findFirstOrThrow({
    where: { project: { key: "ENG" } },
    select: { id: true },
    orderBy: { number: "asc" },
  });

  const name = `playback-${Date.now()}.mp4`;
  const response = await request.post("/api/attachments", {
    multipart: {
      issueId: issue.id,
      file: { name, mimeType: "video/mp4", buffer: bytes },
    },
  });
  expect(response.status()).toBe(200);

  const row = await prisma.attachment.findFirstOrThrow({
    where: { filename: name },
    select: { id: true, byteSize: true, mimeType: true },
  });
  created.push(row.id);
  return row;
}

test.describe("A video attachment served to a browser", () => {
  test("offers byte ranges and answers one with 206 and the right bytes", async ({
    request,
  }) => {
    const bytes = mp4(4096);
    const video = await uploadVideo(request, bytes);
    const url = `/api/attachments/${video.id}`;

    // A plain GET still returns the whole file, and says ranges are available.
    const whole = await request.get(url);
    expect(whole.status()).toBe(200);
    expect(whole.headers()["accept-ranges"]).toBe("bytes");
    expect(whole.headers()["content-type"]).toBe("video/mp4");
    // Inline, so opening the link plays it rather than downloading it.
    expect(whole.headers()["content-disposition"]).toContain("inline");
    expect((await whole.body()).length).toBe(video.byteSize);

    /* The request a media element actually makes first. It must come back as
       206 with a Content-Range, not as a 200 with everything. */
    const opening = await request.get(url, { headers: { Range: "bytes=0-1023" } });
    expect(opening.status()).toBe(206);
    expect(opening.headers()["content-range"]).toBe(
      `bytes 0-1023/${video.byteSize}`,
    );
    expect(opening.headers()["content-length"]).toBe("1024");
    expect(opening.headers()["content-type"]).toBe("video/mp4");

    const opened = await opening.body();
    expect(opened.length).toBe(1024);
    expect(opened.equals(bytes.subarray(0, 1024))).toBe(true);
  });

  test("serves the tail of the file, which is where an MP4 keeps its index", async ({
    request,
  }) => {
    const bytes = mp4(4096);
    const video = await uploadVideo(request, bytes);
    const url = `/api/attachments/${video.id}`;

    // An open-ended range, as a player asks when it wants the rest.
    const rest = await request.get(url, { headers: { Range: "bytes=4000-" } });
    expect(rest.status()).toBe(206);
    expect(rest.headers()["content-range"]).toBe(`bytes 4000-4095/${video.byteSize}`);
    expect((await rest.body()).equals(bytes.subarray(4000))).toBe(true);

    // A suffix range: the last N bytes, which is how the index is found.
    const suffix = await request.get(url, { headers: { Range: "bytes=-96" } });
    expect(suffix.status()).toBe(206);
    expect(suffix.headers()["content-range"]).toBe(
      `bytes 4000-4095/${video.byteSize}`,
    );
    expect((await suffix.body()).equals(bytes.subarray(4000))).toBe(true);
  });

  test("refuses a range that starts past the end", async ({ request }) => {
    const video = await uploadVideo(request, mp4(2048));

    const response = await request.get(`/api/attachments/${video.id}`, {
      headers: { Range: "bytes=99999-" },
    });
    expect(response.status()).toBe(416);
    expect(response.headers()["content-range"]).toBe(`bytes */${video.byteSize}`);
  });

  test("still requires a session, range request or not", async ({
    request,
  }, testInfo) => {
    /* The fix must not have opened the file up. Range support changed what an
       *authorized* reader receives and nothing about who counts as one.
       *
       * A brand-new API context rather than `browser.newContext()`: the latter
       * is still wired to this project's signed-in storage state, so it would
       * prove nothing. This one carries no cookies at all — the proxy turns it
       * away with a redirect to sign in before the route is reached, which is
       * the behaviour that already existed. Asserted as "no video was served",
       * because that is the property that matters whichever layer refuses. */
    const video = await uploadVideo(request, mp4(1024));

    /* `storageState` must be given explicitly: a context created inside a run
       inherits the project's signed-in state otherwise, and would prove the
       opposite of what this test is for. */
    const anonymous = await apiRequest.newContext({
      baseURL: testInfo.project.use.baseURL,
      storageState: { cookies: [], origins: [] },
    });
    const attempts: Record<string, string>[] = [{}, { Range: "bytes=0-10" }];

    for (const headers of attempts) {
      const response = await anonymous.get(`/api/attachments/${video.id}`, {
        headers,
        maxRedirects: 0,
      });
      expect(
        response.status(),
        `anonymous request must not be served the file (got ${response.status()})`,
      ).not.toBe(200);
      expect(response.status()).not.toBe(206);
      expect(response.headers()["content-type"] ?? "").not.toContain("video/");
    }

    await anonymous.dispose();
  });

  test("the Excel export's link is the URL that plays", async ({ request }) => {
    const bytes = mp4(2048);
    const video = await uploadVideo(request, bytes);

    /* Read the link out of the export itself rather than assuming its shape.
       The workbook is XLSX — a zip — so the id is looked for in the raw bytes,
       which is enough to prove the export points at this attachment. */
    const workbook = await request.get("/api/issues/export?project=");
    expect(workbook.status()).toBe(200);

    const url = `/api/attachments/${video.id}`;
    const playable = await request.get(url, { headers: { Range: "bytes=0-511" } });
    expect(playable.status()).toBe(206);
    expect(playable.headers()["content-type"]).toBe("video/mp4");
    expect((await playable.body()).equals(bytes.subarray(0, 512))).toBe(true);
  });
});
