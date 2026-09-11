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
): Promise<void> {
  const form = new FormData();
  if ("issueId" in target) form.append("issueId", target.issueId);
  else form.append("projectId", target.projectId);
  form.append("file", file, filename);

  const response = await fetch("/api/attachments", {
    method: "POST",
    body: form,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error ?? "That file could not be attached.");
  }
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
