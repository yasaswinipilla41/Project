"use client";

import { useRouter } from "next/navigation";
import { useCallback, useRef, useState, type DragEvent } from "react";
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
 * The size limits are stated next to the control rather than only enforced on
 * the server, so nobody spends a minute uploading something that was never
 * going to be accepted. They are read from the same constants the server
 * checks against, so the number on screen cannot drift from the rule.
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
     it, and the server still identifies the file from its own bytes. */
  const [progress, setProgress] = useState<
    { name: string; percent: number; kind: AttachmentRender }[]
  >([]);
  const [error, setError] = useState<string | null>(null);

  const upload = useCallback(
    async (files: File[]) => {
      setError(null);

      for (const file of files) {
        /* Refused before a byte is sent. The server enforces the same two
           limits against the file it actually parsed — this only spares
           somebody a minute of upload for a file that was never going to be
           accepted. */
        const oversize = oversizeMessage(file);
        if (oversize) {
          setError(oversize);
          continue;
        }

        setProgress((list) => [
          ...list,
          { name: file.name, percent: 0, kind: renderKindFor(file.type) },
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
                  entry.name === file.name ? { ...entry, percent } : entry,
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
          setError(
            uploadError instanceof Error
              ? uploadError.message
              : "That file could not be uploaded.",
          );
        } finally {
          setProgress((list) => list.filter((entry) => entry.name !== file.name));
        }
      }

      router.refresh();
    },
    [issueId, router, toast],
  );

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    const files = [...event.dataTransfer.files];
    if (files.length > 0) void upload(files);
  }

  return (
    <div
      className="prio-dropzone"
      data-dragging={dragging || undefined}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
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
            <li key={entry.name}>
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

      {error ? (
        <p className="prio-composer__error" role="alert">
          <IconWarning size={13} />
          {error}
        </p>
      ) : null}
    </div>
  );
}
