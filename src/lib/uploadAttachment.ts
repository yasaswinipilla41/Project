/**
 * Uploading what a Create form staged.
 *
 * A thin wrapper around the same `POST /api/attachments` every other upload
 * path already uses — no separate storage, no second validation, no
 * authorization of its own. The server still identifies each file from its
 * own leading bytes and holds it to the same size ceilings, whether it
 * arrived from a file picker, a screen capture or a recording.
 */

export async function uploadStagedAttachment(
  target: { issueId: string } | { projectId: string },
  file: Blob,
  filename = "attachment",
): Promise<{ id: string; filename: string }> {
  const form = new FormData();
  if ("issueId" in target) form.append("issueId", target.issueId);
  else form.append("projectId", target.projectId);
  form.append("file", file, filename);

  const response = await fetch("/api/attachments", {
    method: "POST",
    body: form,
  });

  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error ?? "That file could not be attached.");
  }

  /* The new row, so a caller that keeps working on the same file — the Snip
     Tool saving an edit over a snip it already saved — can address it. */
  return {
    id: String(body?.id ?? ""),
    filename: String(body?.filename ?? filename),
  };
}

/**
 * Writing new bytes over an attachment that already exists.
 *
 * `PUT /api/attachments/<id>`, the route the issue page's Save already uses:
 * the row keeps its id, its name and its issue, and the server re-identifies
 * and re-checks the new bytes exactly as it would a first upload. Only the
 * uploader or an administrator may do it, which the route decides.
 */
export async function replaceAttachment(
  attachmentId: string,
  file: Blob,
  filename = "attachment",
): Promise<void> {
  const form = new FormData();
  form.append("file", file, filename);

  const response = await fetch(`/api/attachments/${attachmentId}`, {
    method: "PUT",
    body: form,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error ?? "That file could not be updated.");
  }
}

/**
 * Giving an attachment a different name.
 *
 * `PATCH /api/attachments/<id>`, which changes the label and nothing else —
 * the row keeps its id, its bytes, its verified type and its issue, so every
 * link to it still resolves. Deliberately not `replaceAttachment`: that route
 * writes new bytes and keeps the existing name, which is the opposite of what
 * is wanted here.
 *
 * The server holds the extension steady with `renamedFilename`, so a rename
 * cannot turn one kind of file into another, and answers with the name it
 * actually stored.
 */
export async function renameAttachment(
  attachmentId: string,
  filename: string,
): Promise<string> {
  const response = await fetch(`/api/attachments/${attachmentId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename }),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error ?? "That file could not be renamed.");
  }

  const body = (await response.json()) as { filename?: string };
  return body.filename ?? filename;
}

/**
 * Everything a Create form staged, uploaded once its target exists.
 *
 * Each file stands or falls on its own: one refused does not take the rest
 * with it, and the names of those that failed come back so the caller can say
 * so rather than reporting a silent partial success. Nothing is retried here
 * — the issue exists by this point, and its own Attachments panel is the
 * place to try again.
 *
 * Structurally typed rather than importing `StagedAttachment`, which lives in
 * a client component; this module is imported from both sides.
 */
export async function uploadStagedAttachments(
  target: { issueId: string } | { projectId: string },
  staged: { blob: Blob; name: string }[],
): Promise<{ uploaded: number; failed: string[] }> {
  let uploaded = 0;
  const failed: string[] = [];

  for (const item of staged) {
    try {
      await uploadStagedAttachment(target, item.blob, item.name);
      uploaded += 1;
    } catch {
      failed.push(item.name);
    }
  }

  return { uploaded, failed };
}
