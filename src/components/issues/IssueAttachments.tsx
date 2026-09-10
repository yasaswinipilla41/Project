"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { useToast } from "@/components/ui/Toast";
import { IconPlus, IconWarning } from "@/components/ui/Icon";
import {
  AttachmentGrid,
  type AttachmentView,
} from "@/components/issues/Attachments";
import { renderKindFor, type AttachmentRender } from "@/lib/attachments";
import {
  MAX_IMAGE_BYTES,
  MAX_UPLOAD_BYTES,
  megabytes,
  oversizeMessage,
} from "@/server/upload-types";

/**
 * Files attached to the issue itself, rather than to one of its comments.
 *
 * Drag anywhere onto the panel, or use the button — the file input is the real
 * control and the drop zone is a convenience on top of it, so the feature works
 * with a keyboard and on a phone where there is nothing to drag.
 *
 * Several files at once, from either route. Each is uploaded as its own
 * request and each stands or falls on its own: one file refused does not take
 * the rest of the drop with it, and the ones that were refused are named, so a
 * batch never reports a silent partial success. Nothing is ever listed as
 * attached unless the server said so.
 *
 * The size limits are stated next to the control rather than only enforced on
 * the server, so nobody spends a minute uploading something that was never
 * going to be accepted. They are read from the same constants the server
 * checks against, so the number on screen cannot drift from the rule. The
 * refusals below are all courtesies of that kind: `/api/attachments` checks
 * the session, the size and the file's own leading bytes again, and it is that
 * check which decides.
 */

export function IssueAttachments({
  issueId,
  attachments,
  currentUserId,
  isAdmin,
}: {
  issueId: string;
  attachments: AttachmentView[];
  currentUserId: string;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const input = useRef<HTMLInputElement>(null);

  const [dragging, setDragging] = useState(false);
  /* `kind` is only ever used to colour the bar, so the browser's declared type
     is good enough for it — nothing is stored or trusted on the strength of
     it, and the server still identifies the file from its own bytes.

     `id` rather than the name, because a drop of several files can easily
     carry two called `screenshot.png` from different folders. Keyed by name,
     one file's progress drove both bars and whichever finished first cleared
     the other's — so the second upload lost its row while it was still
     running. */
  const [progress, setProgress] = useState<
    { id: number; name: string; percent: number; kind: AttachmentRender }[]
  >([]);
  /* Every file that was refused in the last batch, not merely the last one:
     dropping ten files and being told about one of them is how a partial
     failure passes for a success. */
  const [errors, setErrors] = useState<string[]>([]);
  const nextId = useRef(0);

  const upload = useCallback(
    async (files: File[]) => {
      setErrors([]);
      const refused: string[] = [];

      for (const file of files) {
        /* Refused before a byte is sent. The server enforces the same two
           limits against the file it actually parsed — this only spares
           somebody a minute of upload for a file that was never going to be
           accepted.

           `continue`, so the rest of the drop still goes: one file over the
           limit is not a reason to abandon the nine beside it. */
        const oversize = oversizeMessage(file);
        if (oversize) {
          refused.push(oversize);
          setErrors([...refused]);
          continue;
        }

        const id = nextId.current++;

        setProgress((list) => [
          ...list,
          { id, name: file.name, percent: 0, kind: renderKindFor(file.type) },
        ]);

        try {
          await new Promise<void>((resolve, reject) => {
            const form = new FormData();
            form.append("issueId", issueId);
            form.append("file", file);

            const request = new XMLHttpRequest();
            request.open("POST", "/api/attachments");

            request.upload.addEventListener("progress", (event) => {
              if (!event.lengthComputable) return;
              const percent = Math.round((event.loaded / event.total) * 100);
              setProgress((list) =>
                list.map((entry) =>
                  entry.id === id ? { ...entry, percent } : entry,
                ),
              );
            });

            request.addEventListener("load", () => {
              if (request.status >= 200 && request.status < 300) {
                resolve();
                return;
              }
              let message = "That file was rejected.";
              try {
                message = JSON.parse(request.responseText).error ?? message;
              } catch {
                /* keep the default */
              }
              reject(new Error(message));
            });

            request.addEventListener("error", () =>
              reject(new Error("The upload could not reach the server.")),
            );

            request.send(form);
          });

          toast(<>Attached {file.name}</>);
        } catch (uploadError) {
          refused.push(
            uploadError instanceof Error
              ? uploadError.message
              : `${file.name} could not be uploaded.`,
          );
          setErrors([...refused]);
        } finally {
          setProgress((list) => list.filter((entry) => entry.id !== id));
        }
      }

      router.refresh();
    },
    [issueId, router, toast],
  );

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    setDragging(false);
    /* Every file in the drop, not the first: `dataTransfer.files` is a list
       and a multi-file drag fills all of it. */
    const files = [...event.dataTransfer.files];
    if (files.length > 0) void upload(files);
  }

  /*
   * A file dropped anywhere else on the page.
   *
   * Left alone, the browser treats that as "open this file", navigates away
   * from the issue and leaves whatever was half-typed behind — and a drop that
   * misses the panel by a few pixels is an easy thing to do. Cancelling the
   * default outside the zone makes a miss do nothing at all, which is the
   * behaviour people expect. The panel's own handler runs first and stops the
   * event, so a drop that lands still uploads.
   */
  useEffect(() => {
    const swallow = (event: globalThis.DragEvent) => event.preventDefault();
    window.addEventListener("dragover", swallow);
    window.addEventListener("drop", swallow);
    return () => {
      window.removeEventListener("dragover", swallow);
      window.removeEventListener("drop", swallow);
    };
  }, []);

  return (
    <div
      className="prio-dropzone"
      data-dragging={dragging || undefined}
      onDragOver={(event) => {
        event.preventDefault();
        event.stopPropagation();
        /* Says "yes, drop here" rather than leaving the browser to guess —
           without it some browsers show the no-entry cursor over the panel. */
        event.dataTransfer.dropEffect = "copy";
        setDragging(true);
      }}
      onDragLeave={(event) => {
        /* Moving onto a child fires dragleave on the parent, which made the
           highlight flicker across the panel's own contents. Only a pointer
           that has actually left the panel counts. */
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
          return;
        }
        setDragging(false);
      }}
      onDrop={handleDrop}
    >
      <div className="prio-dropzone__head">
        <h2 className="prio-issue__section-title">Attachments</h2>
        <input
          ref={input}
          type="file"
          multiple
          className="prio-visually-hidden"
          aria-label="Attach files to this issue"
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            if (files.length > 0) void upload(files);
            event.target.value = "";
          }}
        />
        <button
          type="button"
          className="prio-btn prio-btn--ghost prio-btn--sm"
          onClick={() => input.current?.click()}
        >
          <IconPlus size={13} />
          Add files
        </button>
      </div>

      <p className="prio-dropzone__limit">
        Up to {megabytes(MAX_UPLOAD_BYTES)} per file, and{" "}
        {megabytes(MAX_IMAGE_BYTES)} for an image.
      </p>

      {attachments.length === 0 && progress.length === 0 ? (
        <p className="prio-dropzone__empty">
          Drop screenshots, screen recordings or documents here — or use{" "}
          <strong>Add files</strong>. Images and video preview in place;
          everything else is offered as a download.
        </p>
      ) : (
        <AttachmentGrid
          attachments={attachments}
          currentUserId={currentUserId}
          isAdmin={isAdmin}
          annotateIssueId={issueId}
        />
      )}

      {progress.length > 0 ? (
        <ul className="prio-dropzone__progress">
          {progress.map((entry) => (
            <li key={entry.id}>
              <span className="prio-truncate">{entry.name}</span>
              {/* A real progressbar rather than a decorative bar: the percent
                  is the one the browser reports for bytes actually sent, so a
                  screen reader can follow the upload as well as an eye can. */}
              <span
                className="prio-progress"
                data-kind={entry.kind}
                role="progressbar"
                aria-valuenow={entry.percent}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`Uploading ${entry.name}`}
              >
                <span
                  className="prio-progress__bar"
                  style={{ width: `${entry.percent}%` }}
                />
              </span>
              <span>{entry.percent}%</span>
            </li>
          ))}
        </ul>
      ) : null}

      {/* One line per refused file. A batch where two were rejected has to say
          so twice, or the second is a file the person believes was attached. */}
      {errors.length > 0 ? (
        <div role="alert">
          {errors.map((message) => (
            <p key={message} className="prio-composer__error">
              <IconWarning size={13} />
              {message}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
