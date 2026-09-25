"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Avatar } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/Toast";
import {
  IconClose,
  IconEdit,
  IconExternal,
  IconLabel,
  IconTrash,
} from "@/components/ui/Icon";
import { ScreenshotEditor } from "@/components/attachments/ScreenshotEditor";

import {
  extensionOf,
  formatBytes,
  renderKindFor,
  shortTypeLabel,
} from "@/lib/attachments";
import { formatRelative } from "@/lib/format";
import { renameAttachment } from "@/lib/uploadAttachment";

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

/**
 * The filename, while it is being edited.
 *
 * Its own component because of one hazard: committing on blur is the
 * behaviour people expect from an inline edit, and a field that has not been
 * focused yet can receive a blur anyway as the control it replaced is
 * unmounted. Acting on that would close the editor in the same frame it
 * opened, so the box appears to flicker and nothing can be typed.
 *
 * Focus is therefore tracked, and blur only commits once the field has
 * actually held it. Enter commits, Escape abandons.
 */
function AttachmentNameEditor({
  attachment,
  onCommit,
  onCancel,
}: {
  attachment: AttachmentView;
  onCommit: (next: string) => void;
  onCancel: () => void;
}) {
  const hadFocus = useRef(false);

  return (
    <form
      className="prio-attachment__rename"
      onSubmit={(event) => {
        event.preventDefault();
        const field = event.currentTarget.elements.namedItem("name");
        if (field instanceof HTMLInputElement) onCommit(field.value);
      }}
    >
      <input
        name="name"
        className="prio-input"
        defaultValue={attachment.filename}
        aria-label={`Rename ${attachment.filename}`}
        autoFocus
        onFocus={() => {
          hadFocus.current = true;
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        onBlur={(event) => {
          if (hadFocus.current) onCommit(event.target.value);
        }}
      />
    </form>
  );
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
   * Enables "Annotate" on image attachments. The edit is written over the
   * attachment itself, so this is the switch and not a destination — opt-in
   * per surface, and only the issue's own Attachments panel passes it, which
   * leaves comment and project grids untouched.
   */
  annotateIssueId?: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [removing, setRemoving] = useState<string | null>(null);
  const [preparing, setPreparing] = useState<string | null>(null);
  /** The attachment whose name is currently being edited, if any. */
  const [renaming, setRenaming] = useState<string | null>(null);
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
   * Saved over the attachment that was opened, not beside it.
   *
   * This used to POST a second file called `<name>-annotated.png`, so marking
   * up one screenshot left two rows in the panel and every later edit added
   * another. One screenshot is one attachment: the row keeps its id, its name
   * and its place in the list, and only the bytes behind it change. `PUT`
   * carries that out — it re-identifies the new bytes from their own content
   * and holds them to the same limits a first upload faces, then removes the
   * object it replaced so nothing is left unreferenced.
   */
  const saveAnnotation = useCallback(
    async (blob: Blob) => {
      if (!annotating) return;
      const source = annotating.attachment;
      setAnnotating(null);

      const form = new FormData();
      form.append("file", blob, source.filename);

      const response = await fetch(`/api/attachments/${source.id}`, {
        method: "PUT",
        body: form,
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        toast(<>{payload.error ?? "That edit could not be saved."}</>);
        return;
      }

      toast(<>Updated {source.filename}</>);
      router.refresh();
    },
    [annotating, router, toast],
  );

  /*
   * The other reading of an edit: keep both.
   *
   * Save writes over the screenshot because that is nearly always what an
   * edit means. Occasionally it is not — the plain capture is the evidence
   * and the arrows are the explanation, and a defect report is worse for
   * having lost either. This posts the marked-up picture as a new attachment
   * on the same issue and leaves the original untouched, which is the
   * behaviour the old annotate had, offered now as a choice rather than
   * imposed on every edit.
   */
  const saveAnnotationAsCopy = useCallback(
    async (blob: Blob) => {
      if (!annotating || !annotateIssueId) return;
      const source = annotating.attachment;
      setAnnotating(null);

      const extension = extensionOf(source.filename);
      const base = source.filename.slice(
        0,
        source.filename.length - extension.length,
      );

      const form = new FormData();
      form.append("issueId", annotateIssueId);
      form.append("file", blob, `${base}-annotated${extension}`);

      const response = await fetch("/api/attachments", {
        method: "POST",
        body: form,
      });

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        toast(<>{payload.error ?? "That copy could not be saved."}</>);
        return;
      }

      toast(<>Saved a copy of {source.filename}</>);
      router.refresh();
    },
    [annotating, annotateIssueId, router, toast],
  );

  /*
   * Renaming is the label and nothing else — the same file, the same row, the
   * same link. The extension is held steady on the server, so a rename cannot
   * change what the file claims to be; see `renamedFilename`.
   *
   * Through the same `renameAttachment` the Snip Tool renames with, so there
   * is one client-side rename rather than one per surface that offers it.
   */
  const rename = useCallback(
    async (attachment: AttachmentView, next: string) => {
      setRenaming(null);
      if (next.trim() === "" || next === attachment.filename) return;

      let saved: string;
      try {
        saved = await renameAttachment(attachment.id, next);
      } catch (failure) {
        toast(
          <>
            {failure instanceof Error
              ? failure.message
              : "That file could not be renamed."}
          </>,
        );
        return;
      }

      toast(<>Renamed to {saved}</>);
      router.refresh();
    },
    [router, toast],
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
              {renaming === attachment.id ? (
                <AttachmentNameEditor
                  attachment={attachment}
                  onCommit={(next) => void rename(attachment, next)}
                  onCancel={() => setRenaming(null)}
                />
              ) : (
                <a
                  className="prio-attachment__name prio-truncate"
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={attachment.filename}
                >
                  {attachment.filename}
                </a>
              )}
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

            {/* Renaming is open to whoever may remove the file — the same
                rule, because both are edits to somebody's evidence. The slot
                keeps it clear of whichever corner controls are also shown. */}
            {canRemove && renaming !== attachment.id ? (
              <button
                type="button"
                className="prio-attachment__rename-action"
                data-slot={1 + (annotateIssueId && kind === "image" ? 1 : 0)}
                aria-label={`Rename ${attachment.filename}`}
                onClick={() => setRenaming(attachment.id)}
              >
                <IconLabel size={13} />
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
        onSaveAs={
          /* Only where there is somewhere to put a second file. A comment's
             attachments and a project's are shown by this same grid, and
             neither is a destination this knows how to post to. */
          annotateIssueId ? (blob) => void saveAnnotationAsCopy(blob) : undefined
        }
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
 *
 * `Ctrl` / `⌘` with `+` or `-` is the keyboard's "look closer", and it reaches
 * the image the same way the wheel does: the key is matched by what it types
 * *and* by which key it is, so the number-pad keys and layouts where `+` needs
 * Shift all count, and the browser's own page zoom is held off only while the
 * viewer is open.
 *
 * Exported, because it is also the viewer an attachment link opens: following
 * a picture or a video out of the Excel export lands on a page that shows this
 * and nothing else. A video is shown in the same frame, with the browser's
 * own player controls and no zoom — there is nothing to magnify in a player.
 */

const MIN_SCALE = 1;
const MAX_SCALE = 6;
const STEP = 0.25;

function clampScale(value: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

/** Which zoom a key press is asking for, if any. */
function zoomKey(event: KeyboardEvent): "in" | "out" | "reset" | null {
  if (
    event.key === "+" ||
    event.key === "=" ||
    event.code === "Equal" ||
    event.code === "NumpadAdd"
  ) {
    return "in";
  }
  if (
    event.key === "-" ||
    event.key === "_" ||
    event.code === "Minus" ||
    event.code === "NumpadSubtract"
  ) {
    return "out";
  }
  if (event.key === "0" || event.code === "Digit0" || event.code === "Numpad0") {
    return "reset";
  }
  return null;
}

export function Lightbox({
  attachment,
  onClose,
}: {
  attachment: AttachmentView;
  onClose: () => void;
}) {
  const isVideo = renderKindFor(attachment.mimeType) === "video";
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
      /* A player has nothing to zoom, and its own keys belong to it. */
      if (isVideo) return;

      const zoom = zoomKey(event);
      if (!zoom) return;
      /* With or without Ctrl/⌘. Held off from the browser either way, which
         is what keeps Ctrl + and Ctrl - on the picture rather than the page. */
      event.preventDefault();
      if (zoom === "in") zoomTo(scale + STEP);
      else if (zoom === "out") zoomTo(scale - STEP);
      else reset();
    };
    document.addEventListener("keydown", onKey);

    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [isVideo, onClose, reset, scale, zoomTo]);

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
    if (!element || isVideo) return;

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
  }, [isVideo, scale, zoomTo]);

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
      {isVideo ? null : (
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
      )}

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
        {isVideo ? (
          <video
            className="prio-lightbox__video"
            src={`/api/attachments/${attachment.id}`}
            controls
            autoPlay
            playsInline
            preload="metadata"
          />
        ) : (
        /* eslint-disable-next-line @next/next/no-img-element */
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
        )}
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
