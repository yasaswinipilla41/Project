import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { assertIssueAccess, assertProjectAccess } from "@/lib/authz";
import { getCurrentUser } from "@/lib/session";
import { storage } from "@/server/storage";

/** An attachment belongs to exactly one issue or one project — never both. */
async function assertAttachmentAccess(
  user: NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>,
  attachment: { issueId: string | null; projectId: string | null },
): Promise<void> {
  if (attachment.issueId) {
    await assertIssueAccess(user, attachment.issueId);
    return;
  }
  await assertProjectAccess(user, attachment.projectId!);
}

/**
 * Serving and removing one attachment.
 *
 * Files are served through the application, never from a public directory.
 * A screenshot pasted into a bug can contain anything — customer data, a
 * password on screen — so reaching it requires the same authorization as
 * reading the issue it belongs to. A guessed id gets 404, not the file.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The byte span a `Range` header asks for, or `null` for the whole object.
 *
 * Only the single-span form browsers actually send is honoured — `bytes=0-`,
 * `bytes=500-999`, `bytes=-500`. A multi-part range would need a multipart
 * body to answer it, and nothing that plays media asks for one; anything not
 * understood is treated as no range at all, which is a legal answer.
 *
 * Returns `"unsatisfiable"` when the span is well-formed but starts past the
 * end of the object, which has its own status code and is how a player
 * discovers it has asked for something impossible.
 */
function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | null | "unsatisfiable" {
  if (!header) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;

  let start: number;
  let end: number;

  if (rawStart === "") {
    /* A suffix range: the *last* N bytes. `bytes=-500` is the final 500. */
    const length = Number(rawEnd);
    if (!Number.isFinite(length) || length <= 0) return null;
    start = Math.max(0, size - length);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Number(rawEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    // A range that runs past the end is clamped, not refused.
    end = Math.min(end, size - 1);
  }

  if (start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

/** Types the browser may render in place. Everything else is downloaded. */
const INLINE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "application/pdf",
]);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const attachment = await prisma.attachment.findUnique({
    where: { id },
    select: {
      id: true,
      issueId: true,
      projectId: true,
      filename: true,
      mimeType: true,
      byteSize: true,
      storageKey: true,
    },
  });

  if (!attachment) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  try {
    await assertAttachmentAccess(user, attachment);
  } catch {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  /*
   * Range requests, which is what makes a video playable.
   *
   * A `<video>` element — including the one a browser creates when a video URL
   * is opened directly in a tab, such as an attachment link out of the Excel
   * export — does not fetch the file in one piece. It asks for a span, reads
   * the container's index, then asks for more. This route used to answer
   * `Accept-Ranges: none` and always send the whole body with a 200, so the
   * player could not seek and, for an MP4 or QuickTime file whose `moov` atom
   * sits at the end, could not begin playback at all: the bytes it needed
   * first were the ones it had no way to ask for. The file downloaded fine and
   * simply never played.
   *
   * Answering properly costs one header and one status code, and only the
   * requested bytes are read from disk.
   */
  const range = parseRange(
    request.headers.get("range"),
    attachment.byteSize,
  );

  if (range === "unsatisfiable") {
    return new NextResponse(null, {
      status: 416,
      headers: {
        "Content-Range": `bytes */${attachment.byteSize}`,
        "Accept-Ranges": "bytes",
      },
    });
  }

  let body: ReadableStream<Uint8Array>;
  try {
    body = await storage().read(
      attachment.storageKey,
      range ?? undefined,
    );
  } catch {
    return NextResponse.json(
      { error: "That file is no longer available." },
      { status: 410 },
    );
  }

  const inline = INLINE_TYPES.has(attachment.mimeType);
  const length = range ? range.end - range.start + 1 : attachment.byteSize;

  return new NextResponse(body, {
    status: range ? 206 : 200,
    headers: {
      ...(range
        ? {
            "Content-Range": `bytes ${range.start}-${range.end}/${attachment.byteSize}`,
          }
        : {}),
      "Content-Type": attachment.mimeType,
      "Content-Length": String(length),
      /* The filename is quoted and has already had quotes and control
         characters stripped, so it cannot break out of the header. */
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${attachment.filename}"`,
      /*
       * `nosniff` is what makes the allowlist above meaningful: without it a
       * browser may ignore the declared type and re-guess, which is exactly the
       * behaviour that turns an uploaded file into a script.
       */
      "X-Content-Type-Options": "nosniff",
      // Belt and braces: nothing served from here may execute or frame.
      "Content-Security-Policy": "default-src 'none'; sandbox; frame-ancestors 'self'",
      // Attachments are immutable once written, but they are private, so the
      // cache must be the user's own.
      "Cache-Control": "private, max-age=31536000, immutable",
      // Advertised, and honoured above. A player checks this before it seeks.
      "Accept-Ranges": "bytes",
    },
  });
}

/**
 * Removing an attachment.
 *
 * The uploader may remove their own; an administrator may remove any. Everyone
 * else gets 403 — including other members of the project, who can see the file
 * but did not put it there.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const attachment = await prisma.attachment.findUnique({
    where: { id },
    select: {
      id: true,
      issueId: true,
      projectId: true,
      uploadedById: true,
      storageKey: true,
      issue: { select: { key: true } },
    },
  });

  if (!attachment) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  try {
    await assertAttachmentAccess(user, attachment);
  } catch {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  if (attachment.uploadedById !== user.id && user.role !== "ADMIN") {
    return NextResponse.json(
      { error: "You can only remove files you uploaded." },
      { status: 403 },
    );
  }

  await prisma.attachment.delete({ where: { id: attachment.id } });
  await storage()
    .remove(attachment.storageKey)
    .catch((error) => {
      // The row is gone, which is what the interface reflects. A file left
      // behind is a cleanup problem, not a correctness one.
      console.error("[prio] could not remove stored file:", error);
    });

  return NextResponse.json({ ok: true });
}
