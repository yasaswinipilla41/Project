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

  let body: ReadableStream<Uint8Array>;
  try {
    body = await storage().read(attachment.storageKey);
  } catch {
    return NextResponse.json(
      { error: "That file is no longer available." },
      { status: 410 },
    );
  }

  const inline = INLINE_TYPES.has(attachment.mimeType);

  return new NextResponse(body, {
    headers: {
      "Content-Type": attachment.mimeType,
      "Content-Length": String(attachment.byteSize),
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
      "Accept-Ranges": "none",
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
