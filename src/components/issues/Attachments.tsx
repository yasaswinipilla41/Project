"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { useToast } from "@/components/ui/Toast";
import { IconExternal, IconTrash } from "@/components/ui/Icon";
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
}: {
  attachments: AttachmentView[];
  currentUserId: string;
  isAdmin: boolean;
  compact?: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [removing, setRemoving] = useState<string | null>(null);

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

  if (attachments.length === 0) return null;

  return (
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
              <a
                className="prio-attachment__preview"
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`Open ${attachment.filename} in a new tab`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={url} alt={attachment.filename} loading="lazy" />
              </a>
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
  );
}
