/**
 * Uploads a client-staged attachment (e.g. an edited screenshot from a Create
 * form) once its target actually exists. Thin wrapper around the same
 * `POST /api/attachments` every other upload path in the app already uses —
 * no separate storage or authorization logic here.
 */
export async function uploadStagedAttachment(
  target: { issueId: string } | { projectId: string },
  file: Blob,
  filename = "screenshot.png",
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
    throw new Error(body?.error ?? "The screenshot could not be attached.");
  }
}

/** `report.png` -> `report-annotated.png`. */
export function annotatedName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0
    ? `${name.slice(0, dot)}-annotated.png`
    : `${name}-annotated.png`;
}

/**
 * Uploads one staged screenshot as the pair it is: the untouched original,
 * and the marked-up copy when the tester drew on it. Both land in the same
 * Attachments panel, named so it is obvious which is which — the annotation
 * is evidence *about* the screenshot, not a replacement for it.
 *
 * Structurally typed rather than importing `StagedScreenshot`, which lives in
 * a client component; this file is imported from both sides.
 */
export async function uploadStagedScreenshot(
  target: { issueId: string } | { projectId: string },
  shot: { original: Blob; annotated: Blob | null },
  index: number,
): Promise<void> {
  const fallback = `screenshot-${index + 1}.png`;
  const name =
    shot.original instanceof File && shot.original.name
      ? shot.original.name
      : fallback;

  await uploadStagedAttachment(target, shot.original, name);
  if (shot.annotated) {
    await uploadStagedAttachment(target, shot.annotated, annotatedName(name));
  }
}
