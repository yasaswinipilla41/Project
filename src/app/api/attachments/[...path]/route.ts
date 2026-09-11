import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  assertIssueAccess,
  assertProjectAccess,
  AuthorizationError,
} from "@/lib/authz";
import { getCurrentUser } from "@/lib/session";
import { renderKindFor } from "@/lib/attachments";
import { storage } from "@/server/storage";
import {
  identifyUpload,
  maxBytesFor,
  megabytes,
  renamedFilename,
  SNIFF_BYTES,
} from "@/server/upload-types";

/** An attachment belongs to exactly one issue or one project — never both. */
async function assertAttachmentAccess(
  user: NonNullable<Awaited<ReturnType<typeof getCurrentUser>>>,
  attachment: { issueId: string | null; projectId: string | null },
): Promise<void> {
  if (attachment.issueId) {
    await assertIssueAccess(user, attachment.issueId);
    return;
  }
  /*
   * Both columns are nullable, so "belongs to neither" is a shape the database
   * permits even though nothing writes it. Refusing explicitly is the safe
   * reading of an unowned file: there is no project whose membership could
   * grant it, so nobody may have it. Asserting non-null here instead would
   * have asked the authorization layer about `null`, which answers "no
   * access" for everyone — the same outcome, reached by accident rather than
   * on purpose, and reported as a mysterious 404 to administrators.
   */
  if (!attachment.projectId) {
    throw new AuthorizationError("This file has no owner.");
  }
  await assertProjectAccess(user, attachment.projectId);
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

/**
 * The id, and the filename that may follow it.
 *
 * `/api/attachments/<id>` is the canonical URL and still works everywhere it
 * always did. `/api/attachments/<id>/<filename>` resolves to exactly the same
 * attachment — the id alone selects the row, and the trailing segment is never
 * read for anything — but it gives the URL a real file extension.
 *
 * That extension is not cosmetic. Excel decides how to treat a hyperlink partly
 * by what the URL looks like: a link ending in an opaque id is probed as though
 * it might be a document library, and when that probe fails the reader is told
 * "Cannot download the information you requested" and the link never reaches
 * the browser. A link ending in `Capture001.png` is treated as the file
 * download it is. It also gives the browser a sensible name to save under.
 */
function attachmentId(path: string[]): string {
  return path[0] ?? "";
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const id = attachmentId((await params).path);
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
  } catch (error) {
    /* The row says the file exists and storage disagrees, which is a fault
       worth seeing in the logs rather than only as a 410 in someone's browser.
       The key is safe to log — it is an opaque generated id, not a filename. */
    console.error(
      `[prio] attachment ${attachment.id}: storage could not read ${attachment.storageKey}:`,
      error,
    );
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
 * The one authorization rule for changing an attachment.
 *
 * Deliberately the same test `DELETE` applies: the uploader may change their
 * own file, an administrator may change any, and a project member who can
 * merely see it may not. Renaming and replacing are both edits to somebody
 * else's evidence, so neither is opened wider than removing it already is.
 *
 * Returns the row when the caller may proceed, or a response to send back
 * when they may not — so both handlers below share one answer rather than
 * two that could drift apart.
 */
type EditTarget =
  | { ok: false; response: NextResponse }
  | {
      ok: true;
      attachment: {
        id: string;
        issueId: string | null;
        projectId: string | null;
        uploadedById: string;
        storageKey: string;
        filename: string;
        mimeType: string;
      };
    };

async function attachmentForEdit(id: string): Promise<EditTarget> {
  const user = await getCurrentUser();
  if (!user) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Not signed in." }, { status: 401 }),
    };
  }

  const attachment = await prisma.attachment.findUnique({
    where: { id },
    select: {
      id: true,
      issueId: true,
      projectId: true,
      uploadedById: true,
      storageKey: true,
      filename: true,
      mimeType: true,
    },
  });

  const missing = {
    ok: false,
    response: NextResponse.json({ error: "Not found." }, { status: 404 }),
  } as const;

  if (!attachment) return missing;

  try {
    await assertAttachmentAccess(user, attachment);
  } catch {
    // Out of reach reads as missing, so the endpoint cannot be used to
    // discover which ids exist.
    return missing;
  }

  if (attachment.uploadedById !== user.id && user.role !== "ADMIN") {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "You can only change files you uploaded." },
        { status: 403 },
      ),
    };
  }

  return { ok: true, attachment };
}

/**
 * Renaming an attachment.
 *
 * Only the label changes. The row keeps its id, its stored bytes, its verified
 * type and its issue, so every link to it still resolves and the activity that
 * mentions it still refers to the same thing. `renamedFilename` holds the
 * extension steady — see the note there for why a rename must not be able to
 * turn a spreadsheet into an executable.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const id = attachmentId((await params).path);
  const found = await attachmentForEdit(id);
  if (!found.ok) return found.response;
  const { attachment } = found;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  const raw =
    typeof body === "object" && body !== null && "filename" in body
      ? String((body as { filename: unknown }).filename ?? "")
      : "";

  const filename = renamedFilename(raw, attachment.filename);
  if (!filename) {
    return NextResponse.json({ error: "Give the file a name." }, { status: 400 });
  }

  const updated = await prisma.attachment.update({
    where: { id: attachment.id },
    data: { filename },
    select: { id: true, filename: true },
  });

  return NextResponse.json(updated);
}

/**
 * Replacing an attachment's contents, in place.
 *
 * This is what saving an edited screenshot does. The row keeps its id, its
 * name and its issue; only the bytes behind it change. That is the whole
 * point: one screenshot is one attachment, and marking it up is a new version
 * of that attachment rather than a second file sitting beside the first.
 *
 * The new bytes go through exactly the checks a first upload goes through —
 * identified from their own leading bytes, held to the same size ceiling —
 * because a replacement is an upload and nothing about it is more trusted for
 * having arrived this way. It is also refused unless the replacement is the
 * same broad kind as the file it replaces, so "edit this screenshot" cannot
 * quietly turn an image row into a video one.
 *
 * The old stored object is removed only after the row points at the new one,
 * so a failure midway leaves the attachment readable rather than broken.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const id = attachmentId((await params).path);
  const found = await attachmentForEdit(id);
  if (!found.ok) return found.response;
  const { attachment } = found;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Malformed upload." }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: "That file is empty." }, { status: 400 });
  }

  const head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
  const kind = identifyUpload(head, file.type || null, attachment.filename);

  if (!kind) {
    return NextResponse.json(
      { error: "That file type is not supported." },
      { status: 415 },
    );
  }

  if (kind.render !== renderKindFor(attachment.mimeType)) {
    return NextResponse.json(
      { error: "A file can only be replaced by one of the same kind." },
      { status: 415 },
    );
  }

  const limit = maxBytesFor(kind);
  if (file.size > limit) {
    return NextResponse.json(
      { error: `${kind.label}s are limited to ${megabytes(limit)}.` },
      { status: 413 },
    );
  }

  const stored = await storage().put(file.stream(), {
    extension: kind.extension,
  });

  if (stored.byteSize > limit) {
    await storage().remove(stored.key);
    return NextResponse.json({ error: "That file is too large." }, { status: 413 });
  }

  const previousKey = attachment.storageKey;

  const updated = await prisma.attachment.update({
    where: { id: attachment.id },
    data: {
      storageKey: stored.key,
      mimeType: kind.mime,
      byteSize: stored.byteSize,
      /* Dimensions belonged to the bytes that have just been replaced. The
         editor writes a different canvas size than it read often enough that
         keeping the old pair would be stating something untrue; nothing reads
         them for images served through this route. */
      width: null,
      height: null,
    },
    select: { id: true, filename: true, mimeType: true, byteSize: true },
  });

  await storage()
    .remove(previousKey)
    .catch((error) => {
      // The row already points at the new object, so the attachment is
      // correct. An unreferenced file left behind is a cleanup problem.
      console.error("[prio] could not remove replaced file:", error);
    });

  return NextResponse.json(updated);
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
  { params }: { params: Promise<{ path: string[] }> },
) {
  const id = attachmentId((await params).path);
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
