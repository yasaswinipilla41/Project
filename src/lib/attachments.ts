/**
 * Attachment presentation helpers.
 *
 * Client-safe on purpose: the composer and the attachment list are browser
 * components, and they must not drag `src/server/upload-types.ts` — with its
 * signature tables and filesystem-adjacent concerns — into the client bundle.
 * Deciding what a file *is* happens on the server; deciding how to *show* it
 * happens here.
 */

export type AttachmentRender = "image" | "video" | "document";

/** How a verified MIME type is presented. */
export function renderKindFor(mimeType: string): AttachmentRender {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  return "document";
}

/** Human-readable size, e.g. "2.4 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Short label for a file, used where the full MIME type would be noise. */
export function shortTypeLabel(mimeType: string): string {
  const subtype = mimeType.split("/")[1] ?? mimeType;
  return subtype.replace(/^x-/, "").toUpperCase().slice(0, 8);
}
