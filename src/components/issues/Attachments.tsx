"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
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
 * Full-size image view, with zoom that belongs to the image.
 *
 * The picture is the thing people came to look at, so it is the thing that
 * zooms. Before this, the preview had no zoom of its own and the only way to
 * look closer was the browser's — which scales the whole document, so the
 * sidebar, the header and the issue behind the overlay all grew with it and
 * the page had to be put back afterwards.
 *
 * Everything here therefore stays inside one `transform` on the `<img>`:
 *
 *  - the controls, the wheel and the `+` / `-` keys change `scale`, which is
 *    the image's own and nothing else's;
 *  - the viewport around it clips, so a magnified image cannot push the
 *    overlay out of shape or give the page something to scroll;
 *  - a zoomed image can be dragged to pan, because a picture you cannot move
 *    is only zoomed in the middle.
 *
 * The browser's own zoom is held off while this is open — `Ctrl`/`⌘` with the
 * wheel, and Safari's pinch gestures — so the gesture people already use for
 * "look closer" reaches the image instead of the document. Both listeners are
 * removed on close, and page zoom works normally again the moment it is.
 *
 * Escape closes it and focus starts on the close button, so it behaves like
 * the rest of Prio's dialogs without pulling in the full dialog machinery for
 * what is really just a picture.
 */

const MIN_SCALE = 1;
const MAX_SCALE = 6;
const STEP = 0.25;

function clampScale(value: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

function Lightbox({
  attachment,
  onClose,
}: {
  attachment: AttachmentView;
  onClose: () => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  /* Where the pointer went down, and where the image was at that moment.
     A ref rather than state: it changes on every pointermove and none of
     those changes is worth a render of its own. */
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(
    null,
  );

  const zoomed = scale > MIN_SCALE;

  /* Panning only means something while the image is bigger than its frame, so
     going back to 1x recentres rather than leaving it parked off to one side. */
  const zoomTo = useCallback((next: number) => {
    const clamped = clampScale(next);
    setScale(clamped);
    if (clamped === MIN_SCALE) setOffset({ x: 0, y: 0 });
  }, []);

  const reset = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        zoomTo(scale + STEP);
        return;
      }
      if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        zoomTo(scale - STEP);
        return;
      }
      if (event.key === "0") {
        event.preventDefault();
        reset();
      }
    };
    document.addEventListener("keydown", onKey);

    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose, reset, scale, zoomTo]);

  /*
   * The wheel, and the browser zoom it would otherwise trigger.
   *
   * Registered by hand because it has to be non-passive: React's own onWheel
   * is passive, and a passive listener may not call `preventDefault`, which is
   * exactly what stops `Ctrl`+wheel from scaling the document. `gesturestart`
   * and `gesturechange` are Safari's pinch, held off for the same reason.
   */
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      /* A trackpad pinch arrives as ctrl+wheel with small deltas; a mouse
         wheel arrives in larger ones. Normalising to the sign keeps both
         moving a quarter-step at a time rather than one crawling and the
         other leaping. */
      zoomTo(scale + (event.deltaY < 0 ? STEP : -STEP));
    };

    const onGesture = (event: Event) => event.preventDefault();

    element.addEventListener("wheel", onWheel, { passive: false });
    document.addEventListener("gesturestart", onGesture);
    document.addEventListener("gesturechange", onGesture);

    return () => {
      element.removeEventListener("wheel", onWheel);
      document.removeEventListener("gesturestart", onGesture);
      document.removeEventListener("gesturechange", onGesture);
    };
  }, [scale, zoomTo]);

  function startPan(event: React.PointerEvent<HTMLImageElement>) {
    if (!zoomed) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      x: event.clientX,
      y: event.clientY,
      ox: offset.x,
      oy: offset.y,
    };
  }

  function pan(event: React.PointerEvent<HTMLImageElement>) {
    const from = drag.current;
    if (!from) return;
    setOffset({
      x: from.ox + (event.clientX - from.x),
      y: from.oy + (event.clientY - from.y),
    });
  }

  function endPan(event: React.PointerEvent<HTMLImageElement>) {
    if (drag.current) {
      event.currentTarget.releasePointerCapture(event.pointerId);
      drag.current = null;
    }
  }

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

      {/* The zoom controls sit on the overlay, not on the image, so they stay
          put and stay the same size however far the picture is scaled. */}
      <div
        className="prio-lightbox__zoom"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          aria-label="Zoom out"
          disabled={scale <= MIN_SCALE}
          onClick={() => zoomTo(scale - STEP)}
        >
          −
        </button>
        <button
          type="button"
          className="prio-lightbox__level"
          aria-label="Reset zoom to fit"
          onClick={reset}
        >
          {Math.round(scale * 100)}%
        </button>
        <button
          type="button"
          aria-label="Zoom in"
          disabled={scale >= MAX_SCALE}
          onClick={() => zoomTo(scale + STEP)}
        >
          +
        </button>
      </div>

      {/*
        * The frame the image is scaled inside. It clips, so a magnified
        * picture stays within the overlay rather than stretching it — which
        * is what would give the page something to scroll and make the zoom
        * look like the browser's.
        */}
      <div
        ref={viewport}
        className="prio-lightbox__viewport"
        data-zoomed={zoomed || undefined}
        onClick={(event) => event.stopPropagation()}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          className="prio-lightbox__image"
          src={`/api/attachments/${attachment.id}`}
          alt={attachment.filename}
          draggable={false}
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          }}
          onDoubleClick={() => (zoomed ? reset() : zoomTo(2))}
          onPointerDown={startPan}
          onPointerMove={pan}
          onPointerUp={endPan}
          onPointerCancel={endPan}
        />
      </div>

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
