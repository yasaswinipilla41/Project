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

/* ------------------------------------------------------------- renaming */

/**
 * A filename safe to show and to put in a `Content-Disposition` header.
 *
 * Path separators and control characters are removed. The name is never used
 * to locate the file — storage keys are generated — so this only has to be a
 * label somebody can read.
 */
export function safeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "file";
  const cleaned = [...base]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      // Control codes, and the quote a header cannot carry.
      return code > 0x1f && code !== 0x7f && character !== '"';
    })
    .join("")
    .replace(/^\.+/, "")
    .trim();
  return cleaned.length > 0 ? cleaned.slice(0, 200) : "file";
}

/** The extension on a filename, or `""` when it has none. */
export function extensionOf(filename: string): string {
  return /\.[A-Za-z0-9]{1,8}$/.exec(filename)?.[0] ?? "";
}

/**
 * What to call the marked-up copy of a file, saved beside its original.
 *
 * The name it came from with "-annotated" before the extension, so the pair
 * reads as a pair in a list and the copy still opens as what it is.
 */
export function annotatedFilename(filename: string): string {
  const extension = extensionOf(filename);
  const base = filename.slice(0, filename.length - extension.length);
  return `${base}-annotated${extension}`;
}

/**
 * What an attachment should be called after somebody renames it.
 *
 * A rename changes the label and nothing else, so the extension that arrives
 * is the extension that leaves: `report.xlsx` may become
 * `QA-Test-Report.xlsx`, and it may not become `report.exe`. That matters
 * beyond tidiness — the extension is what a browser is handed on download, so
 * letting a rename rewrite it would let somebody relabel a spreadsheet as an
 * executable without a single byte of the file changing.
 *
 * Lives here, beside the other presentation rules, because both sides need
 * it: the server enforces it on the rename route, and a staged attachment in
 * a Create form is renamed before it has ever reached the server. One
 * implementation, so the name offered and the name accepted cannot differ.
 *
 * Returns `null` when what is left is not a name at all, so the caller can
 * refuse rather than silently substitute something.
 */
export function renamedFilename(
  raw: string,
  currentFilename: string,
): string | null {
  const extension = extensionOf(currentFilename);

  /*
   * What they typed is judged before `safeFilename` is allowed near it.
   *
   * That helper guarantees a usable label for a file that has to be stored
   * whatever it is called, so it substitutes "file" for a name that arrived
   * empty. Right there, wrong here: a rename to nothing is a mistake to
   * report, not a placeholder to apply.
   */
  const typed = raw.split(/[\\/]/).pop() ?? "";

  // Their extension, if they typed one, is dropped: theirs is a label, and
  // the file's own is the one that survives.
  const base = extension
    ? typed.slice(0, typed.length - extensionOf(typed).length)
    : typed;

  const hasRealCharacter = [...base].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return false;
    return character !== " " && character !== "." && character !== '"';
  });
  if (!hasRealCharacter) return null;

  const cleaned = safeFilename(base);
  return `${cleaned.slice(0, 200 - extension.length)}${extension}`;
}
