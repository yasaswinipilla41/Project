import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { AttachmentViewer } from "@/components/attachments/AttachmentViewer";
import { renderKindFor } from "@/lib/attachments";
import { assertAttachmentAccess } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "Attachment" };
export const dynamic = "force-dynamic";

/**
 * One picture or video, full screen.
 *
 * Where an attachment link lands when it is opened as a page — out of the Excel
 * export, or a filename clicked inside Prio. `/api/attachments/<id>` sends a
 * navigation for an image or a video here rather than answering it with raw
 * bytes, so the file is shown by Prio's own viewer: the image centred in the
 * window with zoom that belongs to the image, and a video in a plain player.
 *
 * Nothing here is public. The session is required before anything is read, and
 * the attachment is authorized exactly as the file route authorizes it — a
 * file the reader may not open is a 404 here as it is there, so the page
 * cannot be used to learn which ids exist. The bytes themselves still come
 * from the authorized route, requested by the viewer's `<img>` or `<video>`.
 *
 * It sits outside the application shell on purpose. The viewer covers the
 * whole window, so the sidebar and header would only load to be hidden.
 */
export default async function AttachmentViewerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireUser();

  const attachment = await prisma.attachment.findUnique({
    where: { id },
    select: {
      id: true,
      filename: true,
      mimeType: true,
      byteSize: true,
      createdAt: true,
      issueId: true,
      projectId: true,
      uploadedBy: { select: { id: true, name: true, image: true } },
      issue: { select: { key: true } },
      project: { select: { key: true } },
    },
  });
  if (!attachment) notFound();

  try {
    await assertAttachmentAccess(user, attachment);
  } catch {
    notFound();
  }

  /* Anything that is not a picture or a video is not shown here; the file
     route serves it as it always has. */
  const kind = renderKindFor(attachment.mimeType);
  if (kind === "document") redirect(`/api/attachments/${attachment.id}`);

  /* Closing goes back to where the file lives. */
  const backHref = attachment.issue
    ? `/issues/${attachment.issue.key.toLowerCase()}`
    : attachment.project
      ? `/projects/${attachment.project.key.toLowerCase()}/summary`
      : "/";

  return (
    <AttachmentViewer
      attachment={{
        id: attachment.id,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        byteSize: attachment.byteSize,
        createdAt: attachment.createdAt,
        uploadedBy: attachment.uploadedBy,
      }}
      backHref={backHref}
    />
  );
}
