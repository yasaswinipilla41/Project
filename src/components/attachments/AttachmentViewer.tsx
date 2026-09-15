"use client";

import { useRouter } from "next/navigation";
import { Lightbox, type AttachmentView } from "@/components/issues/Attachments";

/**
 * The attachment viewer page's only content: the existing lightbox.
 *
 * Not a second viewer. It is the same component the issue page opens when a
 * thumbnail is clicked, so centring, image-only zoom and Escape behave the same
 * wherever a picture is opened from. Closing it goes back to the issue or
 * project the file belongs to, because a page that only shows a file has
 * nothing behind it to reveal.
 */
export function AttachmentViewer({
  attachment,
  backHref,
}: {
  attachment: AttachmentView & { mimeType: string };
  backHref: string;
}) {
  const router = useRouter();
  return <Lightbox attachment={attachment} onClose={() => router.push(backHref)} />;
}
