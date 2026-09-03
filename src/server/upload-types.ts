/**
 * What Prio accepts as an attachment, and how it decides.
 *
 * The rule that matters: **the browser's `Content-Type` is a claim, not
 * evidence.** Anyone can POST `image/png` with a Windows executable in the
 * body. So every upload is identified from its own leading bytes — its magic
 * number — and the declared type is only ever used to break a tie between two
 * formats that share a signature.
 *
 * A file whose bytes match nothing on this list is refused, which is why the
 * list is an allowlist rather than a list of things to block: an unknown format
 * is unknown, not safe.
 */

export interface FileKind {
  mime: string;
  extension: string;
  /** How it is presented: inline preview, player, or a download link. */
  render: "image" | "video" | "document";
  label: string;
}

/*
 * 30 MB is the ceiling for any attachment, enforced on the server against the
 * parsed file's real size — the browser's check is a courtesy that fails fast,
 * never the boundary.
 *
 * Images keep their own, stricter limit. A screenshot has no business being
 * tens of megabytes, and the tighter cap is deliberate: it is what stops the
 * one file type anybody can produce in bulk from filling the store. A stricter
 * sub-limit is still within a 30 MB maximum.
 */
export const MAX_UPLOAD_BYTES = 30 * 1024 * 1024; // 30 MB
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB

/**
 * Signatures, longest-first where one is a prefix of another.
 *
 * `offset` is where the bytes sit; `mask` marks positions to ignore (used by
 * the ISO base-media container, whose first four bytes are a length).
 */
interface Signature {
  kind: FileKind;
  offset: number;
  bytes: number[];
  /** Extra bytes that must also match, e.g. the RIFF form type at offset 8. */
  also?: { offset: number; bytes: number[] }[];
}

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0));

const KIND = {
  png: { mime: "image/png", extension: ".png", render: "image", label: "PNG image" },
  jpeg: { mime: "image/jpeg", extension: ".jpg", render: "image", label: "JPEG image" },
  gif: { mime: "image/gif", extension: ".gif", render: "image", label: "GIF image" },
  webp: { mime: "image/webp", extension: ".webp", render: "image", label: "WebP image" },
  mp4: { mime: "video/mp4", extension: ".mp4", render: "video", label: "MP4 video" },
  webm: { mime: "video/webm", extension: ".webm", render: "video", label: "WebM video" },
  mov: { mime: "video/quicktime", extension: ".mov", render: "video", label: "QuickTime video" },
  pdf: { mime: "application/pdf", extension: ".pdf", render: "document", label: "PDF" },
  zip: {
    mime: "application/zip",
    extension: ".zip",
    render: "document",
    label: "Zip archive",
  },
  doc: {
    mime: "application/msword",
    extension: ".doc",
    render: "document",
    label: "Word document",
  },
  docx: {
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    extension: ".docx",
    render: "document",
    label: "Word document",
  },
  xls: {
    mime: "application/vnd.ms-excel",
    extension: ".xls",
    render: "document",
    label: "Excel workbook",
  },
  xlsx: {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extension: ".xlsx",
    render: "document",
    label: "Excel workbook",
  },
  txt: { mime: "text/plain", extension: ".txt", render: "document", label: "Text file" },
  csv: { mime: "text/csv", extension: ".csv", render: "document", label: "CSV file" },
} as const satisfies Record<string, FileKind>;

const SIGNATURES: Signature[] = [
  { kind: KIND.png, offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { kind: KIND.jpeg, offset: 0, bytes: [0xff, 0xd8, 0xff] },
  { kind: KIND.gif, offset: 0, bytes: ascii("GIF8") },
  {
    kind: KIND.webp,
    offset: 0,
    bytes: ascii("RIFF"),
    also: [{ offset: 8, bytes: ascii("WEBP") }],
  },
  { kind: KIND.webm, offset: 0, bytes: [0x1a, 0x45, 0xdf, 0xa3] },
  // ISO base media: "ftyp" at offset 4. The brand that follows separates MP4
  // from QuickTime, so both are listed and checked in order.
  {
    kind: KIND.mov,
    offset: 4,
    bytes: ascii("ftyp"),
    also: [{ offset: 8, bytes: ascii("qt  ") }],
  },
  { kind: KIND.mp4, offset: 4, bytes: ascii("ftyp") },
  { kind: KIND.pdf, offset: 0, bytes: ascii("%PDF-") },
  { kind: KIND.zip, offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04] },
  /* OLE compound file: .doc and .xls share it byte for byte, so the extension
     below decides which one this is. */
  {
    kind: KIND.doc,
    offset: 0,
    bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
  },
];

/** Bytes needed before a decision can be made. */
export const SNIFF_BYTES = 32;

/**
 * Identifies a file from its opening bytes.
 *
 * `declared` is consulted only to choose between plain text and CSV, which are
 * genuinely the same bytes; it can never promote a file to a type its content
 * does not support.
 */
export function identifyUpload(
  head: Uint8Array,
  declared: string | null,
  filename: string,
): FileKind | null {
  const name = filename.toLowerCase();
  const endsWith = (...suffixes: string[]) =>
    suffixes.some((suffix) => name.endsWith(suffix));

  for (const signature of SIGNATURES) {
    if (!matches(head, signature.offset, signature.bytes)) continue;
    if (signature.also?.some((extra) => !matches(head, extra.offset, extra.bytes))) {
      continue;
    }

    /*
     * Two families share a signature with something already on the list, so
     * the name breaks the tie — the one job the module allows a claim to do.
     * Note what this does *not* do: a file whose bytes are not a zip or an OLE
     * container is still refused however it is named, so the tie-break can
     * only ever choose between formats the bytes already permit.
     */
    if (signature.kind === KIND.zip) {
      if (endsWith(".docx")) return KIND.docx;
      if (endsWith(".xlsx")) return KIND.xlsx;
    }
    if (signature.kind === KIND.doc && endsWith(".xls")) return KIND.xls;

    return signature.kind;
  }

  /*
   * Plain text has no signature, so it is accepted only when the bytes really
   * do look like text: no NULs, and valid UTF-8. That is what keeps an
   * executable from arriving as "notes.txt".
   */
  if (looksLikeText(head)) {
    const wantsCsv = declared === "text/csv" || endsWith(".csv");
    return wantsCsv ? KIND.csv : KIND.txt;
  }

  return null;
}

function matches(head: Uint8Array, offset: number, bytes: number[]): boolean {
  if (head.length < offset + bytes.length) return false;
  return bytes.every((byte, index) => head[offset + index] === byte);
}

function looksLikeText(head: Uint8Array): boolean {
  if (head.length === 0) return false;
  if (head.includes(0)) return false;

  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head);
  } catch {
    // A truncated multi-byte sequence at the sniff boundary is not proof of
    // binary content, so only a hard failure early in the buffer counts.
    if (head.length >= SNIFF_BYTES) {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(head.subarray(0, head.length - 4));
      } catch {
        return false;
      }
    } else {
      return false;
    }
  }

  return true;
}

/**
 * The size ceiling for a given kind. Images are capped well below the general
 * limit — a 90 MB PNG is a mistake, not a screenshot.
 */
export function maxBytesFor(kind: FileKind): number {
  return kind.render === "image" ? MAX_IMAGE_BYTES : MAX_UPLOAD_BYTES;
}

/**
 * The ceiling a browser can apply *before* uploading, from the type the file
 * picker declared.
 *
 * This is a courtesy, not the boundary: the declared type is a claim, so this
 * can only ever fail a file fast. `maxBytesFor` — keyed on the type the server
 * verified from the bytes themselves — is what actually decides, and it is
 * deliberately the same two constants, so the number a person is told cannot
 * drift from the number they are held to. A video is therefore refused here at
 * exactly the 30 MB the server refuses it at.
 */
export function declaredMaxBytes(declaredType: string | null): number {
  return declaredType?.startsWith("image/") ? MAX_IMAGE_BYTES : MAX_UPLOAD_BYTES;
}

/** Whole megabytes — these limits are round numbers by definition. */
export function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/**
 * The message shown when a file is refused before it is sent, or `null` when
 * it is within its limit. Worded like the server's own rejection so the two
 * paths read the same.
 */
export function oversizeMessage(file: {
  name: string;
  type: string;
  size: number;
}): string | null {
  const limit = declaredMaxBytes(file.type || null);
  if (file.size <= limit) return null;
  return `${file.name} is too large — ${
    file.type.startsWith("image/") ? "images are" : "files are"
  } limited to ${megabytes(limit)}.`;
}

/**
 * A filename safe to put in a `Content-Disposition` header and to show in the
 * interface. Path separators and control characters are removed; the name is
 * never used to locate the file, only to label it.
 */
export function safeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "file";
  const cleaned = base
    .replace(/[\u0000-\u001F\u007F"]/g, "")
    .replace(/^\.+/, "")
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 200) : "file";
}

export { KIND as UPLOAD_KINDS };
