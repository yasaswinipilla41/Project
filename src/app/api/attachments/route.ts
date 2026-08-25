import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { assertIssueAccess } from "@/lib/authz";
import { getCurrentUser } from "@/lib/session";
import { storage } from "@/server/storage";
import {
  identifyUpload,
  maxBytesFor,
  safeFilename,
  SNIFF_BYTES,
  MAX_UPLOAD_BYTES,
} from "@/server/upload-types";

/**
 * Attachment upload.
 *
 * A route handler rather than a server action, because uploads need a real
 * request body to stream and a progress event on the client, and server actions
 * give neither.
 *
 * The order of checks is the point:
 *
 *   1. who is calling — before anything is read;
 *   2. may they write to this issue — before any byte is stored;
 *   3. what the bytes actually are — before the file is kept;
 *   4. is it within the size limit for that kind — while writing.
 *
 * The type check happens on the file's own leading bytes. The multipart part's
 * `Content-Type` is attacker-controlled and is used only as a tie-break between
 * two text formats.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_UPLOAD_BYTES * 1.1) {
    return NextResponse.json(
      { error: "That file is too large." },
      { status: 413 },
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: "Malformed upload." }, { status: 400 });
  }

  const issueId = String(form.get("issueId") ?? "");
  const file = form.get("file");

  if (!issueId || !(file instanceof File)) {
    return NextResponse.json(
      { error: "An issue and a file are required." },
      { status: 400 },
    );
  }

  try {
    await assertIssueAccess(user, issueId);
  } catch {
    // Same answer whether the issue is missing or merely out of reach, so the
    // endpoint cannot be used to discover which issue ids exist.
    return NextResponse.json(
      { error: "That issue is not available." },
      { status: 404 },
    );
  }

  if (file.size === 0) {
    return NextResponse.json({ error: "That file is empty." }, { status: 400 });
  }

  /* Read only the head to identify the file. `File.slice` does not pull the
     whole body into memory, so a 100 MB video costs 32 bytes to classify. */
  const head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
  const filename = safeFilename(file.name);
  const kind = identifyUpload(head, file.type || null, filename);

  if (!kind) {
    return NextResponse.json(
      {
        error:
          "That file type is not supported. Images, videos, PDFs, text and zip archives are accepted.",
      },
      { status: 415 },
    );
  }

  const limit = maxBytesFor(kind);
  if (file.size > limit) {
    return NextResponse.json(
      {
        error: `${kind.label}s are limited to ${Math.round(limit / (1024 * 1024))} MB.`,
      },
      { status: 413 },
    );
  }

  const stored = await storage().put(file.stream(), {
    extension: kind.extension,
  });

  /* The declared size is a claim too. If the stream turned out larger than the
     limit, the file is removed rather than kept. */
  if (stored.byteSize > limit) {
    await storage().remove(stored.key);
    return NextResponse.json({ error: "That file is too large." }, { status: 413 });
  }

  const attachment = await prisma.attachment.create({
    data: {
      issueId,
      uploadedById: user.id,
      filename,
      storageKey: stored.key,
      // The verified type, never the declared one.
      mimeType: kind.mime,
      byteSize: stored.byteSize,
    },
    select: { id: true, filename: true, mimeType: true, byteSize: true },
  });

  return NextResponse.json({
    ...attachment,
    render: kind.render,
    url: `/api/attachments/${attachment.id}`,
  });
}
