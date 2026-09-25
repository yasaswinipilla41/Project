"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/primitives";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "@/components/ui/Menu";
import {
  IconClock,
  IconEdit,
  IconExternal,
  IconImage,
  IconLabel,
  IconPlus,
  IconTrash,
} from "@/components/ui/Icon";
import { ScreenshotEditor } from "@/components/attachments/ScreenshotEditor";
import {
  annotatedFilename,
  formatBytes,
  renamedFilename,
  renderKindFor,
  safeFilename,
  shortTypeLabel,
  type AttachmentRender,
} from "@/lib/attachments";
import { formatDuration } from "@/lib/screenCapture";
import {
  useSnipReceiver,
  type SnipTarget,
} from "@/components/attachments/SnipTool";
import styles from "./AttachmentField.module.css";

/**
 * The attachments field every Create form shares.
 *
 * Files are staged here and nothing is sent yet. That is not a shortcut: an
 * attachment row points at a real issue or project id, and before the item
 * exists there is nothing to point at. The parent form reads `value` at
 * submit time and uploads each one the moment creation succeeds — so from the
 * person's side the upload is automatic and unattended, and from the
 * database's side no file is ever orphaned by an issue that was abandoned
 * half-written.
 *
 * Three ways in, one list out:
 *
 *   Browse      the ordinary file picker, for every type Prio accepts
 *   Screenshot  the Snip Tool, which captures the screen and hands one back
 *   Record      the Snip Tool again, recording instead of snapping
 *
 * The last two are not done here. They belong to the Snip Tool window, which
 * the shell mounts once and which therefore survives this form being closed,
 * navigated away from or reopened — a capture in progress is not something a
 * dialog should be able to destroy. This field only says what it will take,
 * and takes what the window sends it.
 *
 * Each produces a `StagedAttachment`, and from that point on they are treated
 * identically — renamed the same way, removed the same way, uploaded the same
 * way. There is deliberately no second path for "a screenshot" as opposed to
 * "a file".
 */

/**
 * One staged file.
 *
 * `blob` is the whole of the file's content, and editing a screenshot
 * replaces it. It used to be a pair — the chosen bytes and a marked-up copy —
 * which meant annotating one screenshot attached two files and every later
 * edit added another. One screenshot is one attachment, here and on the
 * server, and `id` is what makes that true across an edit: the row keeps its
 * identity while its content changes.
 */
export interface StagedAttachment {
  id: string;
  blob: Blob;
  /** What it will be called. Renameable; the extension is held steady. */
  name: string;
  render: AttachmentRender;
  /** Recordings only, so the list can say how long one runs. */
  durationMs?: number;
}

export interface AttachmentFieldProps {
  value: StagedAttachment[];
  onChange: (value: StagedAttachment[]) => void;
  label?: string;
  /**
   * Size ceilings, stated so somebody is not left waiting on a file that was
   * never going to be accepted. The server checks the same two numbers
   * against the file it actually parsed, and it is that check which decides.
   */
  maxImageBytes: number;
  maxUploadBytes: number;
  /**
   * What the Snip Tool should call this form when it holds a capture for it.
   * Omitted, the Snip Tool is simply not offered.
   */
  snipTarget?: SnipTarget | null;
}

let nextStagedId = 0;
const stagedId = () => `staged-${(nextStagedId += 1)}`;

/** Whole megabytes — these limits are round numbers by definition. */
function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

export function AttachmentField({
  value,
  onChange,
  label = "Attachments",
  maxImageBytes,
  maxUploadBytes,
  snipTarget = null,
}: AttachmentFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  /* Object URLs for previews, keyed by staged id so an edit swaps one URL
     rather than rebuilding every preview in the list. Revoked on the way out;
     a leaked object URL pins the whole blob in memory. */
  useEffect(() => {
    const urls: Record<string, string> = {};
    for (const item of value) {
      if (item.render === "document") continue;
      urls[item.id] = URL.createObjectURL(item.blob);
    }

    let cancelled = false;
    // Deferred a tick so the state write happens from a callback rather than
    // synchronously in the effect body.
    Promise.resolve().then(() => {
      if (!cancelled) setPreviewUrls(urls);
    });

    return () => {
      cancelled = true;
      for (const url of Object.values(urls)) URL.revokeObjectURL(url);
    };
  }, [value]);

  /* Paste a screenshot straight in, the way the system snipping tools work —
     no need to save it to disk just to pick it back up again. */
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
  }, [value]);

  function limitFor(blobType: string): number {
    return blobType.startsWith("image/") ? maxImageBytes : maxUploadBytes;
  }

  /** Why this one cannot be staged, in the words shown for it — or nothing. */
  function refusal(blob: Blob, name: string): string | null {
    const limit = limitFor(blob.type);
    if (blob.size > limit) {
      return `${name} is too large — ${
        blob.type.startsWith("image/") ? "images are" : "files are"
      } limited to ${megabytes(limit)}.`;
    }
    return null;
  }

  /**
   * Files chosen through Browse or dropped on the field.
   *
   * Every type Prio accepts is welcome — the picker is no longer restricted
   * to images, because the server has always accepted documents, archives and
   * video. What a file actually *is* still gets decided on the server from
   * its own leading bytes; nothing here trusts the extension or the type the
   * browser declared, and the only check made now is the size, which spares
   * somebody a long upload that was going to be refused.
   */
  function acceptFiles(files: File[]) {
    setError(null);
    const accepted: StagedAttachment[] = [];
    const refused: string[] = [];

    for (const file of files) {
      const tooBig = refusal(file, file.name);
      if (tooBig) {
        refused.push(tooBig);
        continue;
      }
      if (file.size === 0) {
        refused.push(`${file.name} is empty.`);
        continue;
      }
      accepted.push({
        id: stagedId(),
        blob: file,
        name: safeFilename(file.name),
        render: renderKindFor(file.type),
      });
    }

    // One file refused does not take the rest of the selection with it.
    if (accepted.length > 0) onChange([...value, ...accepted]);
    if (refused.length > 0) setError(refused.join(" "));
  }

  /*
   * The Snip Tool's way back in.
   *
   * A capture arrives here as an ordinary file and becomes an ordinary staged
   * row — same size limits, same rename, same upload. It is delivered by the
   * window when the person saves it there, which is what keeps one snip to
   * one row however many times the form is reopened.
   *
   * Two things a delivery can ask for beyond that. `replaces` is a snip saved
   * again after another edit, or renamed in the window: its row is written
   * over — bytes and name both — as Save does everywhere else, rather than a
   * second row appearing. And several files may come in one delivery — Save as
   * copy on a snip not yet saved sends the original and its "-annotated" copy
   * together — so they are staged in one change and neither can overwrite the
   * other.
   *
   * The staged ids go back to the window so a later Save can name its row.
   */
  const { openSnipTool, available: snipAvailable } = useSnipReceiver(
    snipTarget,
    (deliveries) => {
      setError(null);
      /* Thrown rather than swallowed: the Snip Tool keeps hold of a snip it
         could not hand over, and shows why. A refusal that only appeared
         down here would have lost the capture on the way. */
      for (const { file } of deliveries) {
        const refused = refusal(file, file.name);
        if (refused) throw new Error(refused);
      }

      let next = value;
      const ids: string[] = [];
      for (const delivery of deliveries) {
        const { file, durationMs, replaces } = delivery;
        if (replaces && next.some((item) => item.id === replaces)) {
          next = next.map((item) =>
            item.id === replaces
              ? {
                  ...item,
                  blob: file,
                  /* The delivered name, so a capture renamed in the window is
                     renamed on the row it is staged in — and the row is what
                     the upload goes by. An edit saved again carries the name
                     it already had, so that path is unchanged. */
                  name: safeFilename(file.name),
                  render: renderKindFor(file.type),
                }
              : item,
          );
          ids.push(replaces);
          continue;
        }

        const id = stagedId();
        next = [
          ...next,
          {
            id,
            blob: file,
            name: safeFilename(file.name),
            render: renderKindFor(file.type),
            ...(durationMs === undefined ? {} : { durationMs }),
          },
        ];
        ids.push(id);
      }

      onChange(next);
      return ids;
    },
  );

  function removeAt(id: string) {
    onChange(value.filter((item) => item.id !== id));
  }

  function rename(item: StagedAttachment, raw: string) {
    setRenaming(null);
    const next = renamedFilename(raw, item.name);
    if (!next || next === item.name) return;
    onChange(
      value.map((entry) =>
        entry.id === item.id ? { ...entry, name: next } : entry,
      ),
    );
  }

  /** The item the editor is open on, if it is still in the list. */
  const editingItem = editing
    ? (value.find((item) => item.id === editing) ?? null)
    : null;

  return (
    <div className="prio-field">
      <span className="prio-label">{label}</span>

      <input
        ref={inputRef}
        type="file"
        multiple
        className="prio-visually-hidden"
        /* The field's own label, so `getByLabel("Attachments")` reaches
           the control that actually takes files — the contract every
           Create-flow test and screen reader already relies on. */
        aria-label={label}
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          if (files.length > 0) acceptFiles(files);
          /* Cleared so choosing the same file twice in a row still fires a
             change event. */
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
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          const files = [...event.dataTransfer.files];
          if (files.length > 0) acceptFiles(files);
        }}
      >
        <Menu
          label="Add files"
          trigger={(props) => (
            <button
              type="button"
              className="prio-btn prio-btn--secondary prio-btn--sm"
              {...props}
            >
              <IconPlus size={14} />
              Add files
            </button>
          )}
        >
          <MenuItem
            icon={<IconExternal size={14} />}
            onSelect={() => inputRef.current?.click()}
          >
            Browse…
          </MenuItem>
          <MenuSeparator />
          <MenuLabel>Snip Tool</MenuLabel>
          <MenuItem
            icon={<IconImage size={14} />}
            disabled={!snipAvailable}
            onSelect={() => openSnipTool("screenshot")}
          >
            Screenshot
          </MenuItem>
          <MenuItem
            icon={<IconClock size={14} />}
            disabled={!snipAvailable}
            onSelect={() => openSnipTool("record")}
          >
            Record
          </MenuItem>
        </Menu>
        <span className={styles.dropzoneHint}>
          Drag files here, paste a screenshot, or use Snip Tool to capture or
          record your screen. Up to {megabytes(maxUploadBytes)} per file, and{" "}
          {megabytes(maxImageBytes)} for an image.
        </span>
      </div>

      {value.length > 0 ? (
        <div className={styles.grid}>
          {value.map((item) => (
            <div className={styles.preview} key={item.id}>
              {item.render === "image" && previewUrls[item.id] ? (
                <a
                  className={styles.thumb}
                  href={previewUrls[item.id]}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Open ${item.name} in a new tab`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={previewUrls[item.id]} alt={`${item.name} preview`} />
                </a>
              ) : item.render === "video" && previewUrls[item.id] ? (
                <video
                  className={styles.thumb}
                  src={previewUrls[item.id]}
                  controls
                  preload="metadata"
                  playsInline
                />
              ) : (
                <span className={styles.thumb} data-doc>
                  {shortTypeLabel(item.blob.type || "application/octet-stream")}
                </span>
              )}

              <div className={styles.meta}>
                {renaming === item.id ? (
                  <StagedNameEditor
                    item={item}
                    onCommit={(next) => rename(item, next)}
                    onCancel={() => setRenaming(null)}
                  />
                ) : (
                  <span className={styles.name} title={item.name}>
                    {item.name}
                  </span>
                )}
                <span className={styles.sub}>
                  {formatBytes(item.blob.size)}
                  {item.durationMs === undefined
                    ? ""
                    : ` · ${formatDuration(item.durationMs)}`}
                </span>
              </div>

              <div className={styles.actions}>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setRenaming(item.id)}
                >
                  <IconLabel size={13} />
                  Rename
                </Button>
                {item.render === "image" ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => setEditing(item.id)}
                  >
                    <IconEdit size={13} />
                    Annotate
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => removeAt(item.id)}
                >
                  <IconTrash size={13} />
                  Remove
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      {editingItem ? (
        <ScreenshotEditor
          open
          source={editingItem.blob}
          onCancel={() => setEditing(null)}
          onSave={(blob) => {
            /* Written over the same staged row. The list keeps one entry for
               one screenshot, exactly as the server keeps one attachment. */
            onChange(
              value.map((entry) =>
                entry.id === editingItem.id
                  ? { ...entry, blob, render: renderKindFor(blob.type) }
                  : entry,
              ),
            );
            setEditing(null);
          }}
          onSaveAs={(blob) => {
            /* The other reading of an edit: the plain capture is the evidence
               and the marked-up one is the explanation. A second row, named
               after the first so the pair reads as a pair, and the original
               left exactly as it was. */
            const copy: StagedAttachment = {
              id: stagedId(),
              blob,
              name: annotatedFilename(editingItem.name),
              render: renderKindFor(blob.type),
            };
            onChange([...value, copy]);
            setEditing(null);
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * The staged name, while it is being edited.
 *
 * Its own component for the same reason as the one on the issue panel:
 * committing on blur is what people expect, and a field that has not been
 * focused yet can receive a blur as the control it replaced unmounts. Acting
 * on that would close the editor in the frame it opened.
 */
function StagedNameEditor({
  item,
  onCommit,
  onCancel,
}: {
  item: StagedAttachment;
  onCommit: (next: string) => void;
  onCancel: () => void;
}) {
  const hadFocus = useRef(false);

  /*
   * Deliberately not a `<form>`.
   *
   * This field lives inside the Create dialog's own form, and a form nested
   * in a form is not something HTML has: the browser hoists it, so pressing
   * Enter to confirm a filename submitted the *issue* instead — the dialog
   * closed and the draft went with it. Enter is handled here directly, which
   * is the whole of what the form was providing.
   *
   * `data-local-escape` keeps Escape here too, so abandoning a rename does not
   * close the dialog behind it.
   */
  return (
    <input
      name="name"
      className="prio-input"
      defaultValue={item.name}
      aria-label={`Rename ${item.name}`}
      autoFocus
      data-local-escape="true"
      onFocus={() => {
        hadFocus.current = true;
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onCommit(event.currentTarget.value);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }
      }}
      onBlur={(event) => {
        if (hadFocus.current) onCommit(event.target.value);
      }}
    />
  );
}



