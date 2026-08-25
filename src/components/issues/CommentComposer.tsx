"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { Avatar, Button } from "@/components/ui/primitives";
import { RichText } from "@/components/richtext/RichText";
import {
  IconClose,
  IconLink,
  IconPlus,
  IconWarning,
} from "@/components/ui/Icon";
import { formatBytes } from "@/lib/attachments";

/**
 * The comment composer.
 *
 * Written as a plain `<textarea>` with a formatting toolbar rather than a
 * `contenteditable` editor. That is a deliberate trade:
 *
 *  - a textarea is accessible for free — screen readers, mobile keyboards,
 *    autocorrect, undo/redo and text selection all behave the way people
 *    already expect, and none of it has to be reimplemented;
 *  - what gets stored is exactly what the author typed, so the server never
 *    receives markup it has to trust or scrub. Formatting is applied when the
 *    text is *displayed*, by a renderer that emits React elements rather than
 *    HTML. A comment containing `<script>` is therefore inert by construction,
 *    not by filtering.
 *
 * The Preview tab shows the same renderer the posted comment will use, so what
 * the author sees before posting is what everyone sees after.
 */

export interface MentionablePerson {
  id: string;
  name: string;
  image: string | null;
}

export interface PendingAttachment {
  id: string;
  filename: string;
  byteSize: number;
  mimeType: string;
  render: "image" | "video" | "document";
  url: string;
}

export interface CommentComposerProps {
  issueId: string;
  author: { name: string; image: string | null };
  mentionable: MentionablePerson[];
  /** Pre-filled when editing an existing comment. */
  initialBody?: string;
  submitLabel?: string;
  placeholder?: string;
  autoFocus?: boolean;
  onCancel?: () => void;
  onSubmit: (body: string, attachmentIds: string[]) => Promise<string | null>;
}

/** Toolbar actions, expressed as what they wrap the selection in. */
const FORMATS = [
  { key: "bold", label: "Bold", hint: "Ctrl+B", wrap: "**", sample: "bold" },
  { key: "italic", label: "Italic", hint: "Ctrl+I", wrap: "*", sample: "italic" },
  {
    key: "underline",
    label: "Underline",
    hint: "Ctrl+U",
    wrap: "++",
    sample: "underline",
  },
  { key: "code", label: "Inline code", hint: "Ctrl+E", wrap: "`", sample: "code" },
] as const;

const BLOCKS = [
  { key: "h", label: "Heading", prefix: "### ", sample: "Heading" },
  { key: "ul", label: "Bulleted list", prefix: "- ", sample: "List item" },
  { key: "ol", label: "Numbered list", prefix: "1. ", sample: "List item" },
  { key: "quote", label: "Quote", prefix: "> ", sample: "Quoted text" },
] as const;

export function CommentComposer({
  issueId,
  author,
  mentionable,
  initialBody = "",
  submitLabel = "Comment",
  placeholder = "Write a comment…",
  autoFocus = false,
  onCancel,
  onSubmit,
}: CommentComposerProps) {
  const textareaId = useId();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const [body, setBody] = useState(initialBody);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [uploading, setUploading] = useState<{ name: string; percent: number }[]>(
    [],
  );

  /* Mention picker state. `at` is where the `@` sits in the text, so the chosen
     name can replace exactly the fragment being typed. */
  const [mention, setMention] = useState<{ at: number; query: string } | null>(
    null,
  );
  /*
   * The highlighted suggestion is stored alongside the query it belongs to, so
   * a new query implicitly resets it. Resetting from an effect instead would
   * render one frame with the previous row highlighted before correcting it.
   */
  const [highlight, setHighlight] = useState({ query: "", index: 0 });

  const query = mention?.query ?? "";
  const highlighted = highlight.query === query ? highlight.index : 0;
  const setHighlighted = (next: number | ((i: number) => number)) =>
    setHighlight({
      query,
      index: typeof next === "function" ? next(highlighted) : next,
    });

  const suggestions = mention
    ? mentionable
        .filter((person) =>
          person.name.toLowerCase().includes(mention.query.toLowerCase()),
        )
        .slice(0, 6)
    : [];

  /** Grows with its content instead of scrolling inside a fixed box. */
  const autosize = useCallback(() => {
    const el = textarea.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 420)}px`;
  }, []);

  useEffect(autosize, [body, preview, autosize]);

  const canSubmit = body.trim().length > 0 || attachments.length > 0;

  /* --------------------------------------------------------- formatting */

  function surround(wrap: string, sample: string) {
    const el = textarea.current;
    if (!el) return;

    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selected = body.slice(start, end) || sample;
    const next = `${body.slice(0, start)}${wrap}${selected}${wrap}${body.slice(end)}`;

    setBody(next);
    // Put the caret around the text, not after the closing marker, so typing
    // continues where the author expects.
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + wrap.length, start + wrap.length + selected.length);
    });
  }

  function prefixLine(prefix: string, sample: string) {
    const el = textarea.current;
    if (!el) return;

    const start = el.selectionStart;
    const lineStart = body.lastIndexOf("\n", start - 1) + 1;
    const atLineStart = lineStart === start;
    const insertion = `${atLineStart ? "" : "\n"}${prefix}`;
    const selected = body.slice(start, el.selectionEnd) || sample;

    const next = `${body.slice(0, start)}${insertion}${selected}${body.slice(el.selectionEnd)}`;
    setBody(next);

    requestAnimationFrame(() => {
      el.focus();
      const caret = start + insertion.length;
      el.setSelectionRange(caret, caret + selected.length);
    });
  }

  function insertLink() {
    surround("", "");
    const el = textarea.current;
    if (!el) return;
    const start = el.selectionStart;
    const selected = body.slice(start, el.selectionEnd) || "link text";
    const next = `${body.slice(0, start)}[${selected}](https://)${body.slice(el.selectionEnd)}`;
    setBody(next);
    requestAnimationFrame(() => {
      el.focus();
      const urlAt = start + selected.length + 3;
      el.setSelectionRange(urlAt, urlAt + 8);
    });
  }

  /* ------------------------------------------------------------ mentions */

  function handleChange(event: ChangeEvent<HTMLTextAreaElement>) {
    const value = event.target.value;
    setBody(value);
    setError(null);

    const caret = event.target.selectionStart;
    const upTo = value.slice(0, caret);
    // An `@` counts only at a word boundary, so an email address does not open
    // the picker.
    const match = /(?:^|\s)@([\p{L}\p{N} ._-]{0,40})$/u.exec(upTo);

    setMention(match ? { at: caret - (match[1]?.length ?? 0) - 1, query: match[1] ?? "" } : null);
  }

  function choose(person: MentionablePerson) {
    if (!mention) return;
    const before = body.slice(0, mention.at);
    const after = body.slice(mention.at + 1 + mention.query.length);
    const next = `${before}@${person.name} ${after}`;

    setBody(next);
    setMention(null);

    requestAnimationFrame(() => {
      const el = textarea.current;
      if (!el) return;
      const caret = before.length + person.name.length + 2;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (mention && suggestions.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlighted((i) => (i + 1) % suggestions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlighted((i) => (i - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const picked = suggestions[highlighted];
        if (picked) choose(picked);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMention(null);
        return;
      }
    }

    // Ctrl/Cmd+Enter posts, which is the shortcut people try first.
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void submit();
      return;
    }

    if (event.metaKey || event.ctrlKey) {
      const shortcut = FORMATS.find(
        (f) => f.hint.toLowerCase().endsWith(event.key.toLowerCase()),
      );
      if (shortcut) {
        event.preventDefault();
        surround(shortcut.wrap, shortcut.sample);
      }
    }

    if (event.key === "Escape" && onCancel) {
      onCancel();
    }
  }

  /* --------------------------------------------------------- attachments */

  const upload = useCallback(
    async (files: File[]) => {
      for (const file of files) {
        setUploading((list) => [...list, { name: file.name, percent: 0 }]);

        try {
          const result = await uploadOne(file, issueId, (percent) => {
            setUploading((list) =>
              list.map((entry) =>
                entry.name === file.name ? { ...entry, percent } : entry,
              ),
            );
          });
          setAttachments((list) => [...list, result]);
        } catch (uploadError) {
          setError(
            uploadError instanceof Error
              ? uploadError.message
              : "That file could not be uploaded.",
          );
        } finally {
          setUploading((list) => list.filter((entry) => entry.name !== file.name));
        }
      }
    },
    [issueId],
  );

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    const files = [...event.dataTransfer.files];
    if (files.length > 0) void upload(files);
  }

  async function removePending(attachment: PendingAttachment) {
    setAttachments((list) => list.filter((a) => a.id !== attachment.id));
    await fetch(`/api/attachments/${attachment.id}`, { method: "DELETE" }).catch(
      () => {},
    );
  }

  /* -------------------------------------------------------------- submit */

  async function submit() {
    if (!canSubmit || busy) return;

    setBusy(true);
    setError(null);

    const message = await onSubmit(
      body,
      attachments.map((a) => a.id),
    );

    setBusy(false);

    if (message) {
      setError(message);
      return;
    }

    setBody("");
    setAttachments([]);
    setPreview(false);
  }

  return (
    <div
      className="prio-composer"
      data-dragging={dragging || undefined}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      <Avatar
        name={author.name}
        image={author.image}
        size="md"
        className="prio-composer__avatar"
      />

      <div className="prio-composer__main">
        <div className="prio-composer__tabs" role="tablist" aria-label="Comment editor">
          <button
            type="button"
            role="tab"
            aria-selected={!preview}
            className="prio-composer__tab"
            onClick={() => setPreview(false)}
          >
            Write
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={preview}
            className="prio-composer__tab"
            onClick={() => setPreview(true)}
            disabled={body.trim().length === 0}
          >
            Preview
          </button>
        </div>

        {!preview ? (
          <div className="prio-composer__toolbar" role="toolbar" aria-label="Formatting">
            {FORMATS.map((format) => (
              <button
                key={format.key}
                type="button"
                className="prio-composer__tool"
                title={`${format.label} (${format.hint})`}
                aria-label={format.label}
                onClick={() => surround(format.wrap, format.sample)}
              >
                <span data-format={format.key}>
                  {format.key === "bold"
                    ? "B"
                    : format.key === "italic"
                      ? "I"
                      : format.key === "underline"
                        ? "U"
                        : "‹›"}
                </span>
              </button>
            ))}

            <span className="prio-composer__toolsep" aria-hidden />

            {BLOCKS.map((block) => (
              <button
                key={block.key}
                type="button"
                className="prio-composer__tool"
                title={block.label}
                aria-label={block.label}
                onClick={() => prefixLine(block.prefix, block.sample)}
              >
                <span data-format={block.key}>
                  {block.key === "h"
                    ? "H"
                    : block.key === "ul"
                      ? "•"
                      : block.key === "ol"
                        ? "1."
                        : "❝"}
                </span>
              </button>
            ))}

            <button
              type="button"
              className="prio-composer__tool"
              title="Link"
              aria-label="Link"
              onClick={insertLink}
            >
              <IconLink size={14} />
            </button>

            <span className="prio-composer__toolsep" aria-hidden />

            <button
              type="button"
              className="prio-composer__tool"
              title="Mention someone"
              aria-label="Mention someone"
              onClick={() => {
                const el = textarea.current;
                if (!el) return;
                const caret = el.selectionStart;
                const needsSpace = caret > 0 && !/\s$/.test(body.slice(0, caret));
                const next = `${body.slice(0, caret)}${needsSpace ? " " : ""}@${body.slice(caret)}`;
                setBody(next);
                const at = caret + (needsSpace ? 1 : 0);
                setMention({ at, query: "" });
                requestAnimationFrame(() => {
                  el.focus();
                  el.setSelectionRange(at + 1, at + 1);
                });
              }}
            >
              @
            </button>
          </div>
        ) : null}

        {preview ? (
          <div className="prio-composer__preview">
            <RichText value={body} mentionable={mentionable} />
          </div>
        ) : (
          <div className="prio-composer__field">
            <label className="prio-visually-hidden" htmlFor={textareaId}>
              Add a comment
            </label>
            <textarea
              id={textareaId}
              ref={textarea}
              className="prio-composer__textarea"
              value={body}
              placeholder={placeholder}
              rows={3}
              autoFocus={autoFocus}
              disabled={busy}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              onBlur={() => {
                // Let a click on a suggestion land before the list disappears.
                window.setTimeout(() => setMention(null), 150);
              }}
            />

            {mention && suggestions.length > 0 ? (
              <ul className="prio-mentions" role="listbox" aria-label="People">
                {suggestions.map((person, index) => (
                  <li key={person.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={index === highlighted}
                      className="prio-mentions__item"
                      data-active={index === highlighted || undefined}
                      onMouseEnter={() => setHighlighted(index)}
                      onClick={() => choose(person)}
                    >
                      {/* The name is right there in the row, so the avatar is
                          decorative — without this a screen reader announces
                          "Aarthi Rao Aarthi Rao". */}
                      <span aria-hidden>
                        <Avatar name={person.name} image={person.image} size="xs" />
                      </span>
                      {person.name}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}

            {mention && suggestions.length === 0 ? (
              <p className="prio-mentions__empty">
                Nobody on this project matches “{mention.query}”.
              </p>
            ) : null}
          </div>
        )}

        {attachments.length > 0 || uploading.length > 0 ? (
          <ul className="prio-composer__files">
            {attachments.map((attachment) => (
              <li key={attachment.id} className="prio-composer__file">
                {attachment.render === "image" ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={attachment.url} alt="" />
                ) : null}
                <span className="prio-truncate">{attachment.filename}</span>
                <span className="prio-composer__filesize">
                  {formatBytes(attachment.byteSize)}
                </span>
                <button
                  type="button"
                  className="prio-composer__fileremove"
                  aria-label={`Remove ${attachment.filename}`}
                  onClick={() => void removePending(attachment)}
                >
                  <IconClose size={12} />
                </button>
              </li>
            ))}

            {uploading.map((entry) => (
              <li key={entry.name} className="prio-composer__file" data-uploading>
                <span className="prio-truncate">{entry.name}</span>
                <span className="prio-progress" aria-hidden>
                  <span
                    className="prio-progress__bar"
                    style={{ width: `${entry.percent}%` }}
                  />
                </span>
                <span className="prio-composer__filesize">{entry.percent}%</span>
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

        <div className="prio-composer__actions">
          <input
            ref={fileInput}
            type="file"
            multiple
            className="prio-visually-hidden"
            aria-label="Attach files"
            onChange={(event) => {
              const files = [...(event.target.files ?? [])];
              if (files.length > 0) void upload(files);
              event.target.value = "";
            }}
          />

          <button
            type="button"
            className="prio-composer__tool prio-composer__attach"
            onClick={() => fileInput.current?.click()}
          >
            <IconPlus size={13} />
            Attach
          </button>

          <span className="prio-composer__hint">
            **bold** · *italic* · `code` · @name · drag files in
          </span>

          {onCancel ? (
            <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
          ) : null}

          <Button
            variant="brand"
            size="sm"
            onClick={() => void submit()}
            loading={busy}
            disabled={!canSubmit}
          >
            {busy ? "Posting…" : submitLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * One upload, with progress.
 *
 * `XMLHttpRequest` rather than `fetch`, because `fetch` still cannot report
 * upload progress — and a 40 MB screen recording with no progress bar looks
 * exactly like a hung page.
 */
function uploadOne(
  file: File,
  issueId: string,
  onProgress: (percent: number) => void,
): Promise<PendingAttachment> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("issueId", issueId);
    form.append("file", file);

    const request = new XMLHttpRequest();
    request.open("POST", "/api/attachments");

    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    });

    request.addEventListener("load", () => {
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(request.responseText);
      } catch {
        reject(new Error("The server returned an unreadable response."));
        return;
      }

      if (request.status >= 200 && request.status < 300) {
        resolve(payload as unknown as PendingAttachment);
      } else {
        reject(new Error(String(payload.error ?? "That file was rejected.")));
      }
    });

    request.addEventListener("error", () =>
      reject(new Error("The upload could not reach the server.")),
    );

    request.send(form);
  });
}
