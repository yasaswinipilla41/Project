"use client";

import { useRouter } from "next/navigation";
import { useCallback, useRef, useState, type DragEvent } from "react";
import { useToast } from "@/components/ui/Toast";
import { IconPlus, IconWarning } from "@/components/ui/Icon";
import {
  AttachmentGrid,
  type AttachmentView,
} from "@/components/issues/Attachments";

/**
 * Files attached to the issue itself, rather than to one of its comments.
 *
 * Drag anywhere onto the panel, or use the button — the file input is the real
 * control and the drop zone is a convenience on top of it, so the feature works
 * with a keyboard and on a phone where there is nothing to drag.
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
  const [progress, setProgress] = useState<{ name: string; percent: number }[]>(
    [],
  );
  const [error, setError] = useState<string | null>(null);

  const upload = useCallback(
    async (files: File[]) => {
      setError(null);

      for (const file of files) {
        setProgress((list) => [...list, { name: file.name, percent: 0 }]);

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
        />
      )}

      {progress.length > 0 ? (
        <ul className="prio-dropzone__progress">
          {progress.map((entry) => (
            <li key={entry.name}>
              <span className="prio-truncate">{entry.name}</span>
              <span className="prio-progress" aria-hidden>
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
