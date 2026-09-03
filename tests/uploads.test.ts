import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import {
  identifyUpload,
  MAX_UPLOAD_BYTES,
  maxBytesFor,
  oversizeMessage,
  safeFilename,
  SNIFF_BYTES,
} from "@/server/upload-types";
import { LocalStorageProvider } from "@/server/storage";

/**
 * Upload identification and storage.
 *
 * The property under test is that a file is judged by its own bytes. The
 * browser's declared `Content-Type` and the filename are both attacker
 * controlled, so neither may promote a file to a type its content does not
 * support — that is exactly how an executable becomes an "image".
 */

const scratch: string[] = [];

afterAll(async () => {
  await Promise.all(scratch.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A buffer beginning with the given signature, padded to sniff length. */
function withSignature(bytes: number[], offset = 0, tail = "rest"): Uint8Array {
  const buffer = new Uint8Array(SNIFF_BYTES + 8);
  buffer.fill(0x41); // 'A'
  bytes.forEach((byte, index) => {
    buffer[offset + index] = byte;
  });
  new TextEncoder().encode(tail).forEach((byte, index) => {
    buffer[SNIFF_BYTES + index] = byte;
  });
  return buffer;
}

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

describe("identifying an upload from its bytes", () => {
  const cases: { name: string; head: Uint8Array; expected: string }[] = [
    {
      name: "PNG",
      head: withSignature([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      expected: "image/png",
    },
    { name: "JPEG", head: withSignature([0xff, 0xd8, 0xff]), expected: "image/jpeg" },
    { name: "GIF", head: withSignature(ascii("GIF8")), expected: "image/gif" },
    {
      name: "WebM",
      head: withSignature([0x1a, 0x45, 0xdf, 0xa3]),
      expected: "video/webm",
    },
    { name: "PDF", head: withSignature(ascii("%PDF-")), expected: "application/pdf" },
  ];

  for (const testCase of cases) {
    it(`recognises ${testCase.name}`, () => {
      const kind = identifyUpload(testCase.head, null, "file.bin");
      expect(kind?.mime).toBe(testCase.expected);
    });
  }

  it("recognises WebP only when the RIFF form type says WEBP", () => {
    const webp = new Uint8Array(SNIFF_BYTES);
    ascii("RIFF").forEach((b, i) => (webp[i] = b));
    ascii("WEBP").forEach((b, i) => (webp[8 + i] = b));
    expect(identifyUpload(webp, null, "a.webp")?.mime).toBe("image/webp");

    // A RIFF container that is not WebP (a .wav, say) is not accepted as one.
    const wav = new Uint8Array(SNIFF_BYTES);
    ascii("RIFF").forEach((b, i) => (wav[i] = b));
    ascii("WAVE").forEach((b, i) => (wav[8 + i] = b));
    expect(identifyUpload(wav, "image/webp", "a.webp")).toBeNull();
  });

  it("separates QuickTime from MP4 by brand", () => {
    const mov = new Uint8Array(SNIFF_BYTES);
    ascii("ftyp").forEach((b, i) => (mov[4 + i] = b));
    ascii("qt  ").forEach((b, i) => (mov[8 + i] = b));
    expect(identifyUpload(mov, null, "clip.mov")?.mime).toBe("video/quicktime");

    const mp4 = new Uint8Array(SNIFF_BYTES);
    ascii("ftyp").forEach((b, i) => (mp4[4 + i] = b));
    ascii("isom").forEach((b, i) => (mp4[8 + i] = b));
    expect(identifyUpload(mp4, null, "clip.mp4")?.mime).toBe("video/mp4");
  });
});

describe("refusing disguised files", () => {
  it("rejects a Windows executable however it is labelled", () => {
    // "MZ" — a PE binary, offered as a PNG in both the type and the name.
    const exe = withSignature([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
    // Binary content, so the text fallback cannot rescue it either.
    exe[20] = 0x00;

    expect(identifyUpload(exe, "image/png", "totally-a-screenshot.png")).toBeNull();
  });

  it("rejects an ELF binary named .jpg", () => {
    const elf = withSignature([0x7f, 0x45, 0x4c, 0x46]);
    elf[20] = 0x00;
    expect(identifyUpload(elf, "image/jpeg", "photo.jpg")).toBeNull();
  });

  it("rejects an SVG, whose markup a browser would execute", () => {
    /* SVG is XML, and an inline <script> in one runs when the file is opened
       directly. It is not on the allowlist, so it is refused on content — the
       `image/svg+xml` label makes no difference. */
    const svg = new TextEncoder().encode(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    const kind = identifyUpload(svg, "image/svg+xml", "logo.svg");

    expect(kind?.mime).not.toBe("image/svg+xml");
    // It is valid text, so it may be stored — but only ever as plain text,
    // which the browser will not execute.
    expect(kind?.mime === "text/plain" || kind === null).toBe(true);
  });

  it("rejects an HTML page pretending to be an image", () => {
    const html = new TextEncoder().encode(
      "<html><body><script>alert(1)</script></body></html>",
    );
    const kind = identifyUpload(html, "image/png", "page.png");
    expect(kind?.render).not.toBe("image");
  });

  it("accepts genuine text and treats a .csv as CSV", () => {
    const text = new TextEncoder().encode("id,name\n1,Prio\n");
    expect(identifyUpload(text, "text/csv", "rows.csv")?.mime).toBe("text/csv");
    expect(identifyUpload(text, null, "notes.txt")?.mime).toBe("text/plain");
  });

  /*
   * Video is capped at the general 30 MB limit, not below it and not above
   * it. The boundary is inclusive — 30 MB exactly is a file somebody has, and
   * a limit that refuses the number it states is a bug, not a policy.
   */
  it("accepts a video up to 30 MB and refuses one past it", () => {
    const MB = 1024 * 1024;
    const videos = [
      identifyUpload(withSignature(ascii("ftyp"), 4), null, "clip.mp4"),
      identifyUpload(withSignature([0x1a, 0x45, 0xdf, 0xa3]), null, "clip.webm"),
    ];

    for (const video of videos) {
      expect(video?.render).toBe("video");
      if (!video) continue;

      const limit = maxBytesFor(video);
      expect(limit).toBe(30 * MB);
      expect(limit).toBe(MAX_UPLOAD_BYTES);

      // What the route does with `file.size` against that limit.
      expect(29 * MB > limit).toBe(false);
      expect(30 * MB > limit).toBe(false);
      expect(30 * MB + 1 > limit).toBe(true);
    }
  });

  it("fails an oversized video fast, at the same 30 MB the server enforces", () => {
    const MB = 1024 * 1024;

    expect(
      oversizeMessage({ name: "clip.mp4", type: "video/mp4", size: 30 * MB }),
    ).toBeNull();
    expect(
      oversizeMessage({ name: "clip.mp4", type: "video/mp4", size: 30 * MB + 1 }),
    ).toContain("30 MB");

    // Other kinds keep the limits they already had.
    expect(
      oversizeMessage({ name: "notes.pdf", type: "application/pdf", size: 30 * MB }),
    ).toBeNull();
    expect(
      oversizeMessage({ name: "shot.png", type: "image/png", size: 21 * MB }),
    ).toContain("20 MB");
    expect(
      oversizeMessage({ name: "shot.png", type: "image/png", size: 19 * MB }),
    ).toBeNull();
  });

  it("caps images well below the general limit", () => {
    const png = identifyUpload(
      withSignature([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      null,
      "a.png",
    );
    const pdf = identifyUpload(withSignature(ascii("%PDF-")), null, "a.pdf");

    expect(png).not.toBeNull();
    expect(pdf).not.toBeNull();
    if (png && pdf) {
      expect(maxBytesFor(png)).toBeLessThan(maxBytesFor(pdf));
    }
  });
});

describe("filenames", () => {
  it("keeps only the last path segment", () => {
    expect(safeFilename("../../../etc/passwd")).toBe("passwd");
    expect(safeFilename("C:\\Windows\\System32\\evil.dll")).toBe("evil.dll");
  });

  it("removes quotes and control characters that would break a header", () => {
    expect(safeFilename('a"b.png')).toBe("ab.png");
    expect(safeFilename("a\u0000b\u001Fc.png")).toBe("abc.png");
    expect(safeFilename("a\r\nContent-Type: text/html")).not.toContain("\n");
  });

  it("never returns an empty name", () => {
    expect(safeFilename("")).toBe("file");
    expect(safeFilename("...")).toBe("file");
    expect(safeFilename("/")).toBe("file");
  });
});

describe("local storage", () => {
  async function provider() {
    const dir = await mkdtemp(path.join(tmpdir(), "prio-storage-"));
    scratch.push(dir);
    return { dir, storage: new LocalStorageProvider(dir) };
  }

  function stream(text: string): ReadableStream<Uint8Array> {
    return Readable.toWeb(
      Readable.from([Buffer.from(text)]),
    ) as ReadableStream<Uint8Array>;
  }

  it("writes the bytes and reports their size and digest", async () => {
    const { dir, storage } = await provider();
    const stored = await storage.put(stream("hello prio"), { extension: ".txt" });

    expect(stored.byteSize).toBe(10);
    expect(stored.digest).toHaveLength(64);

    const onDisk = await readFile(path.join(dir, stored.key), "utf8");
    expect(onDisk).toBe("hello prio");
  });

  it("names files itself, so an uploader's filename never becomes a path", async () => {
    const { storage } = await provider();
    const stored = await storage.put(stream("x"), { extension: ".png" });

    // yyyy/mm/<uuid>.png — nothing the uploader supplied appears in it.
    expect(stored.key).toMatch(/^\d{4}\/\d{2}\/[0-9a-f-]{36}\.png$/);
  });

  it("ignores an extension that is not a plain extension", async () => {
    const { storage } = await provider();
    const stored = await storage.put(stream("x"), {
      extension: "/../../evil.sh",
    });

    expect(stored.key).not.toContain("..");
    expect(stored.key).toMatch(/^\d{4}\/\d{2}\/[0-9a-f-]{36}$/);
  });

  it("refuses to read outside its root", async () => {
    const { storage } = await provider();
    await expect(storage.read("../../../etc/passwd")).rejects.toThrow(
      /escapes the storage root/,
    );
  });

  it("reads back what it stored and removes it on request", async () => {
    const { storage } = await provider();
    const stored = await storage.put(stream("round trip"), { extension: ".txt" });

    const body = await storage.read(stored.key);
    const text = await new Response(body).text();
    expect(text).toBe("round trip");

    expect(await storage.size(stored.key)).toBe(10);

    await storage.remove(stored.key);
    expect(await storage.size(stored.key)).toBeNull();
  });
});
