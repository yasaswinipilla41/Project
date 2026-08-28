"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Avatar } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/Toast";
import { IconClose, IconEdit, IconExternal, IconTrash } from "@/components/ui/Icon";
import { ScreenshotEditor } from "@/components/attachments/ScreenshotEditor";
import { annotatedName } from "@/lib/uploadAttachment";
import { formatBytes, renderKindFor, shortTypeLabel } from "@/lib/attachments";
import { formatRelative } from "@/lib/format";

/**
 * Attachments on an issue or a comment.
 *
 * Files are fetched from `/api/attachments/<id>`, which authorizes every
 * request. That is why an image here is a plain `<img>` pointed at that route
 * rather than an optimized `next/image`: the optimizer would need to fetch the
 * bytes itself, without the viewer's session, and either fail or — worse —
 * cache a private screenshot in a shared location.
 */

export interface AttachmentView {
  id: string;
  filename: string;
  mimeType: string;
  byteSize: number;
  createdAt: Date;
  uploadedBy: { id: string; name: string; image: string | null };
}

export function AttachmentGrid({
  attachments,
  currentUserId,
  isAdmin,
  compact = false,
  annotateIssueId,
}: {
  attachments: AttachmentView[];
  currentUserId: string;
  isAdmin: boolean;
  compact?: boolean;
  /**
   * Enables "Annotate" on image attachments, saving the marked-up copy to
   * this issue. Opt-in per surface: only the issue's own Attachments panel
   * passes it, so comment and project grids are untouched.
   */
  annotateIssueId?: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [removing, setRemoving] = useState<string | null>(null);
  const [preparing, setPreparing] = useState<string | null>(null);
  const [annotating, setAnnotating] = useState<{
    attachment: AttachmentView;
    blob: Blob;
  } | null>(null);
  const [lightbox, setLightbox] = useState<AttachmentView | null>(null);

  const remove = useCallback(
    async (attachment: AttachmentView) => {
      setRemoving(attachment.id);
      const response = await fetch(`/api/attachments/${attachment.id}`, {
        method: "DELETE",
      });
      setRemoving(null);

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        toast(<>{payload.error ?? "That file could not be removed."}</>);
        return;
      }

      toast(<>Removed {attachment.filename}</>);
      router.refresh();
    },
    [router, toast],
  );

  /*
   * Reopening an attachment is a fetch and nothing more: the bytes come back
   * through the same authorized route that renders the thumbnail, and go
   * into the same editor the Create form uses. Nothing here knows how images
   * are stored.
   */
  const openAnnotator = useCallback(
    async (attachment: AttachmentView) => {
      setPreparing(attachment.id);
      try {
        const response = await fetch(`/api/attachments/${attachment.id}`);
        if (!response.ok) throw new Error("That image could not be opened.");
        setAnnotating({ attachment, blob: await response.blob() });
      } catch (error) {
        toast(
          <>
            {error instanceof Error
              ? error.message
              : "That image could not be opened."}
          </>,
        );
      } finally {
        setPreparing(null);
      }
    },
    [toast],
  );

  /*
   * Saved as a new attachment rather than over the old one. The original
   * stays exactly where it was — the same rule the Create form follows, and
   * the reason this needs no new storage or delete path.
   */
  const saveAnnotation = useCallback(
    async (blob: Blob) => {
      if (!annotating || !annotateIssueId) return;
      const source = annotating.attachment;
      setAnnotating(null);

      const form = new FormData();
      form.append("issueId", annotateIssueId);
      form.append("file", blob, annotatedName(source.filename));

      const response = await fetch("/api/attachments", {
        method: "POST",
        body: form,
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        toast(<>{payload.error ?? "The annotated copy could not be saved."}</>);
        return;
      }

      toast(<>Saved annotated copy of {source.filename}</>);
      router.refresh();
    },
    [annotating, annotateIssueId, router, toast],
  );

  if (attachments.length === 0) return null;

  return (
    <>
    <ul className="prio-attachments" data-compact={compact || undefined}>
      {attachments.map((attachment) => {
        const url = `/api/attachments/${attachment.id}`;
        const kind = renderKindFor(attachment.mimeType);
        const canRemove = isAdmin || attachment.uploadedBy.id === currentUserId;

        return (
          <li
            key={attachment.id}
            className="prio-attachment"
            data-kind={kind}
            data-busy={removing === attachment.id || undefined}
          >
            {kind === "image" ? (
              <button
                type="button"
                className="prio-attachment__preview"
                onClick={() => setLightbox(attachment)}
                aria-label={`Open ${attachment.filename}`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={url} alt={attachment.filename} loading="lazy" />
              </button>
            ) : kind === "video" ? (
              <video
                className="prio-attachment__video"
                src={url}
                controls
                preload="metadata"
                playsInline
              />
            ) : (
              <a
                className="prio-attachment__doc"
                href={url}
                target="_blank"
                rel="noopener noreferrer"
              >
                <span className="prio-attachment__ext" aria-hidden>
                  {shortTypeLabel(attachment.mimeType)}
                </span>
                <IconExternal size={13} />
              </a>
            )}

            <div className="prio-attachment__meta">
              <a
                className="prio-attachment__name prio-truncate"
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                title={attachment.filename}
              >
                {attachment.filename}
              </a>
              <span className="prio-attachment__sub">
                {formatBytes(attachment.byteSize)} ·{" "}
                {attachment.uploadedBy.name} ·{" "}
                {formatRelative(attachment.createdAt)}
              </span>
            </div>

            {annotateIssueId && kind === "image" ? (
              <button
                type="button"
                className="prio-attachment__annotate"
                data-shifted={canRemove || undefined}
                aria-label={`Annotate ${attachment.filename}`}
                disabled={preparing === attachment.id}
                onClick={() => void openAnnotator(attachment)}
              >
                <IconEdit size={13} />
              </button>
            ) : null}

            {canRemove ? (
              <button
                type="button"
                className="prio-attachment__remove"
                aria-label={`Remove ${attachment.filename}`}
                disabled={removing === attachment.id}
                onClick={() => void remove(attachment)}
              >
                <IconTrash size={13} />
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>

    {lightbox ? (
      <Lightbox attachment={lightbox} onClose={() => setLightbox(null)} />
    ) : null}

    {annotating ? (
      <ScreenshotEditor
        open
        source={annotating.blob}
        onCancel={() => setAnnotating(null)}
        onSave={(blob) => void saveAnnotation(blob)}
      />
    ) : null}
    </>
  );
}

/**
 * Full-size image view.
 *
 * Escape closes it and focus is trapped to the close button while it is open,
 * so it behaves like the rest of Prio's dialogs without pulling in the full
 * dialog machinery for what is really just a picture.
 */
function Lightbox({
  attachment,
  onClose,
}: {
  attachment: AttachmentView;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);

    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <div
      className="prio-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={attachment.filename}
      onClick={onClose}
    >
      <button
        type="button"
        className="prio-lightbox__close"
        aria-label="Close"
        autoFocus
        onClick={onClose}
      >
        <IconClose size={16} />
      </button>

      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        className="prio-lightbox__image"
        src={`/api/attachments/${attachment.id}`}
        alt={attachment.filename}
        onClick={(event) => event.stopPropagation()}
      />

      <div className="prio-lightbox__caption">
        <Avatar
          name={attachment.uploadedBy.name}
          image={attachment.uploadedBy.image}
          size="xs"
        />
        <span>{attachment.filename}</span>
        <span className="prio-lightbox__size">
          {formatBytes(attachment.byteSize)}
        </span>
      </div>
    </div>
  );
}
