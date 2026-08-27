"use client";

import { useEffect, useRef, useState, type DragEvent } from "react";
import { Button } from "@/components/ui/primitives";
import { IconImage, IconTrash } from "@/components/ui/Icon";
import { MAX_IMAGE_BYTES } from "@/server/upload-types";
import { ScreenshotEditor } from "@/components/attachments/ScreenshotEditor";
import styles from "./ScreenshotAttachmentField.module.css";

/**
 * The screenshot field every Create form shares (§ Screenshot attachments).
 *
 * Holds the staged images entirely client-side — nothing is uploaded here.
 * The parent form reads `value` at submit time and uploads each one itself
 * once the item it belongs to actually exists (an attachment always points
 * at a real issue or project id; there is nothing to point at before
 * creation succeeds). This is also why there is no server round-trip for
 * edit/remove: they only ever change what is sitting in memory, waiting to
 * be submitted.
 */

export interface ScreenshotAttachmentFieldProps {
  value: Blob[];
  onChange: (value: Blob[]) => void;
  label?: string;
}

export function ScreenshotAttachmentField({
  value,
  onChange,
  label = "Screenshots",
}: ScreenshotAttachmentFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editorIndex, setEditorIndex] = useState<number | null>(null);

  useEffect(() => {
    if (value.length === 0) return;
    const urls = value.map((blob) => URL.createObjectURL(blob));
    let cancelled = false;
    // Deferred a tick so the state write happens from a callback rather than
    // synchronously in the effect body.
    Promise.resolve().then(() => {
      if (!cancelled) setPreviewUrls(urls);
    });
    return () => {
      cancelled = true;
      urls.forEach((url) => URL.revokeObjectURL(url));
      setPreviewUrls([]);
    };
  }, [value]);

  // Paste a screenshot straight in, the way Snipping Tool's own flow works —
  // no need to save it to disk first just to pick it back up again.
  useEffect(() => {
    function onPaste(event: ClipboardEvent) {
      const items = event.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            acceptFiles([file]);
            event.preventDefault();
          }
          return;
        }
      }
    }
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function acceptFiles(files: File[]) {
    setError(null);
    const accepted: File[] = [];
    for (const file of files) {
      if (!file.type.startsWith("image/")) {
        setError("Please choose image files.");
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        setError(
          `Images are limited to ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))} MB.`,
        );
        continue;
      }
      accepted.push(file);
    }
    if (accepted.length > 0) onChange([...value, ...accepted]);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    const files = [...event.dataTransfer.files];
    if (files.length > 0) acceptFiles(files);
  }

  function removeAt(index: number) {
    onChange(value.filter((_, i) => i !== index));
  }

  return (
    <div className="prio-field">
      <span className="prio-label">{label}</span>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        className="prio-visually-hidden"
        aria-label={label}
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          if (files.length > 0) acceptFiles(files);
          event.target.value = "";
        }}
      />

      <div
        className={styles.dropzone}
        data-dragging={dragging || undefined}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
      >
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => inputRef.current?.click()}
        >
          <IconImage size={14} />
          {value.length > 0 ? "Add more screenshots" : "Add screenshots"}
        </Button>
        <span className={styles.dropzoneHint}>
          Drag images here, paste from your clipboard, or choose files. You
          can draw on each one before submitting.
        </span>
      </div>

      {value.length > 0 ? (
        <div className={styles.grid}>
          {value.map((blob, index) => (
            <div className={styles.preview} key={index}>
              {previewUrls[index] ? (
                <a
                  className={styles.thumb}
                  href={previewUrls[index]}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Open screenshot ${index + 1} in a new tab`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={previewUrls[index]} alt={`Screenshot ${index + 1} preview`} />
                </a>
              ) : (
                <div className={styles.thumb} />
              )}
              <div className={styles.actions}>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => setEditorIndex(index)}
                >
                  Edit
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => removeAt(index)}
                >
                  <IconTrash size={13} />
                  Remove
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {error ? <p className={styles.error}>{error}</p> : null}

      {editorIndex !== null && value[editorIndex] ? (
        <ScreenshotEditor
          open
          source={value[editorIndex]}
          onCancel={() => setEditorIndex(null)}
          onSave={(blob) => {
            onChange(value.map((v, i) => (i === editorIndex ? blob : v)));
            setEditorIndex(null);
          }}
        />
      ) : null}
    </div>
  );
}
