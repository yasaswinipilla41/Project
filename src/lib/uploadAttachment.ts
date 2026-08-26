/**
 * Uploads a client-staged attachment (e.g. an edited screenshot from a Create
 * form) once its target actually exists. Thin wrapper around the same
 * `POST /api/attachments` every other upload path in the app already uses —
 * no separate storage or authorization logic here.
 */
export async function uploadStagedAttachment(
  target: { issueId: string } | { projectId: string },
  file: Blob,
): Promise<void> {
  const form = new FormData();
  if ("issueId" in target) form.append("issueId", target.issueId);
  else form.append("projectId", target.projectId);
  form.append("file", file, "screenshot.png");

  const response = await fetch("/api/attachments", {
    method: "POST",
    body: form,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error ?? "The screenshot could not be attached.");
  }
}
