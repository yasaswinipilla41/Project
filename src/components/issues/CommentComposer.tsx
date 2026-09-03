"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import { Avatar, Button } from "@/components/ui/primitives";
import { RichText } from "@/components/richtext/RichText";
import {
  applyFormat,
  MarkdownEditor,
  type FormatCommand,
  type MarkdownEditorHandle,
} from "@/components/richtext/MarkdownEditor";
import {
  IconClose,
  IconLink,
  IconPlus,
  IconWarning,
} from "@/components/ui/Icon";
import {
  formatBytes,
  renderKindFor,
  type AttachmentRender,
} from "@/lib/attachments";
import { oversizeMessage } from "@/server/upload-types";
import { searchIssuesForReference } from "@/server/issues";

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

/** One issue offered by the `#` picker. */
export interface IssueMatch {
  id: string;
  key: string;
  title: string;
}

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

/**
 * Toolbar actions, expressed as editor commands.
 *
 * They used to be Markdown markers — `**` wrapped around the selection in a
 * textarea. The editor applies formatting to the document instead, and the
 * Markdown is produced when it is serialised, so what a button needs to know
 * is which command it runs, not which characters it inserts.
 */
const FORMATS = [
  { key: "bold", label: "Bold", hint: "Ctrl+B", command: "bold" },
  { key: "italic", label: "Italic", hint: "Ctrl+I", command: "italic" },
  { key: "underline", label: "Underline", hint: "Ctrl+U", command: "underline" },
  { key: "strike", label: "Strikethrough", hint: "Ctrl+D", command: "strikeThrough" },
] as const satisfies readonly {
  key: string;
  label: string;
  hint: string;
  command: FormatCommand;
}[];

const BLOCKS = [
  { key: "h", label: "Heading", command: "heading" },
  { key: "ul", label: "Bulleted list", command: "ul" },
  { key: "ol", label: "Numbered list", command: "ol" },
  { key: "quote", label: "Quote", command: "quote" },
] as const satisfies readonly {
  key: string;
  label: string;
  command: FormatCommand;
}[];

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
  const editor = useRef<MarkdownEditorHandle>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const [body, setBody] = useState(initialBody);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  /* `kind` colours the bar and nothing else — see the note in
     `IssueAttachments`; the server still identifies the file from its bytes. */
  const [uploading, setUploading] = useState<
    { name: string; percent: number; kind: AttachmentRender }[]
  >(
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

  /*
   * Issue picker state, the `#` counterpart to the mention picker above.
   * Unlike people, issues are not preloaded — there can be thousands — so the
   * matches come from the server, which is also what applies the caller's
   * project scope to them.
   */
  const [reference, setReference] = useState<{ at: number; query: string } | null>(
    null,
  );
  /* Results carry the query they answer, so a response that arrives after the
     text has moved on is simply not displayed — no clearing from an effect,
     and never a list that belongs to something already typed past. */
  const [issueResults, setIssueResults] = useState<{
    query: string;
    rows: IssueMatch[];
  }>({ query: "", rows: [] });
  const [issueHighlight, setIssueHighlight] = useState({ query: "", index: 0 });

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

  /*
   * Fetch matches for the `#` picker. Debounced, aborted when superseded, and
   * cleared when the picker closes — so a stale response cannot repopulate a
   * list the person has already dismissed.
   */
  const referenceQuery = reference?.query.trim() ?? "";
  const issueMatches =
    reference && issueResults.query === referenceQuery ? issueResults.rows : [];
  const highlightedIssue =
    issueHighlight.query === referenceQuery ? issueHighlight.index : 0;
  const setHighlightedIssue = (next: number | ((i: number) => number)) =>
    setIssueHighlight({
      query: referenceQuery,
      index: typeof next === "function" ? next(highlightedIssue) : next,
    });

  useEffect(() => {
    if (referenceQuery.length === 0) return;

    let live = true;
    const timer = setTimeout(() => {
      searchIssuesForReference(referenceQuery)
        .then((rows) => {
          if (live) setIssueResults({ query: referenceQuery, rows });
        })
        .catch(() => {
          if (live) setIssueResults({ query: referenceQuery, rows: [] });
        });
    }, 200);

    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [referenceQuery]);

  /* A contentEditable grows with its content on its own, so the old
     height-measuring effect is gone with the textarea it measured. */

  const canSubmit = body.trim().length > 0 || attachments.length > 0;

  /* --------------------------------------------------------- formatting */

  /**
   * Formatting now acts on the document, not on the text.
   *
   * The old helpers wrapped a slice of the Markdown string in `**` and moved
   * the caret around the markers. In a visual editor there are no markers to
   * step over — the browser applies the formatting to the selection, and the
   * Markdown is produced from the result when it is serialised.
   */
  function format_(command: FormatCommand) {
    editor.current?.focus();
    applyFormat(command);
    // execCommand does not fire `input`, so the value is read back by hand.
    requestAnimationFrame(() => editor.current?.syncNow());
  }

  /** Wrap the selection in a link, asking only for the address. */
  function insertLink() {
    editor.current?.focus();
    const href = window.prompt("Link address", "https://");
    if (!href) return;
    document.execCommand("createLink", false, href);
    requestAnimationFrame(() => editor.current?.syncNow());
  }

  /*
   * What is being typed right before the caret, and therefore which picker
   * should be open.
   *
   * Read from the editor's caret rather than from a textarea's
   * `selectionStart`: in a visual editor the Markdown is a serialisation of
   * the document, so an offset into it means nothing. `at` is now a length —
   * how many characters to replace — instead of an index into the value.
   */
  function detectTriggers() {
    setError(null);

    const upTo = editor.current?.textBeforeCaret() ?? "";

    // An `@` counts only at a word boundary, so an email address does not open
    // the picker.
    const match = /(?:^|\s)@([\p{L}\p{N} ._-]{0,40})$/u.exec(upTo);
    setMention(
      match ? { at: (match[1]?.length ?? 0) + 1, query: match[1] ?? "" } : null,
    );

    /* `#` at a word boundary, so a colour like #fff mid-sentence does not open
       the picker any more than an email address opens the mention one. */
    const hash = /(?:^|\s)#([\p{L}\p{N} _-]{0,40})$/u.exec(upTo);
    setReference(
      hash ? { at: (hash[1]?.length ?? 0) + 1, query: hash[1] ?? "" } : null,
    );
  }

  /** Insert the chosen issue's key; the renderer turns it into a link. */
  function chooseIssue(issue: IssueMatch) {
    if (!reference) return;
    /* Replace the `#` and whatever has been typed after it, in the document
       itself — the caret is in a DOM, not at an offset into the Markdown. */
    editor.current?.replaceBeforeCaret(reference.at, `${issue.key} `);
    setReference(null);
    editor.current?.focus();
  }

  function choose(person: MentionablePerson) {
    if (!mention) return;
    editor.current?.replaceBeforeCaret(mention.at, `@${person.name} `);
    setMention(null);
    editor.current?.focus();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (reference && issueMatches.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setHighlightedIssue((i) => (i + 1) % issueMatches.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setHighlightedIssue(
          (i) => (i - 1 + issueMatches.length) % issueMatches.length,
        );
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const picked = issueMatches[highlightedIssue];
        if (picked) chooseIssue(picked);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setReference(null);
        return;
      }
    }

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
        format_(shortcut.command);
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
        // Refused before a byte is sent; the server enforces the same limits.
        const oversize = oversizeMessage(file);
        if (oversize) {
          setError(oversize);
          continue;
        }

        setUploading((list) => [
          ...list,
          { name: file.name, percent: 0, kind: renderKindFor(file.type) },
        ]);

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
                /* Keeps the caret in the editor: a button taking focus would
                   collapse the selection before `execCommand` could act on
                   it, which is exactly how formatting silently did nothing. */
                onMouseDown={(event) => event.preventDefault()}
                title={`${format.label} (${format.hint})`}
                aria-label={format.label}
                onClick={() => format_(format.command)}
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
                /* Keeps the caret in the editor: a button taking focus would
                   collapse the selection before `execCommand` could act on
                   it, which is exactly how formatting silently did nothing. */
                onMouseDown={(event) => event.preventDefault()}
                title={block.label}
                aria-label={block.label}
                onClick={() => format_(block.command)}
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
              onMouseDown={(event) => event.preventDefault()}
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
              onMouseDown={(event) => event.preventDefault()}
              title="Mention someone"
              aria-label="Mention someone"
              onClick={() => {
                /* Type the `@` into the document and let the same detection
                   that watches the keyboard open the picker, rather than
                   opening it here and having two ways in. */
                editor.current?.focus();
                const before = editor.current?.textBeforeCaret() ?? "";
                const needsSpace = before.length > 0 && !/\s$/.test(before);
                editor.current?.replaceBeforeCaret(0, `${needsSpace ? " " : ""}@`);
                requestAnimationFrame(detectTriggers);
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
            {/* The editable region names itself with `aria-label`; a `<label
                for>` associates only with form controls, so one here would
                point at nothing. */}
            <MarkdownEditor
              id={textareaId}
              ref={editor}
              value={body}
              placeholder={placeholder}
              ariaLabel={placeholder}
              autoFocus={autoFocus}
              mentionable={mentionable}
              onChange={(markdown) => {
                setBody(markdown);
                detectTriggers();
              }}
              onKeyDown={handleKeyDown}
              onBlur={() => {
                // Let a click on a suggestion land before the list disappears.
                window.setTimeout(() => {
                  setMention(null);
                  setReference(null);
                }, 150);
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

            {reference && issueMatches.length > 0 ? (
              <ul className="prio-mentions" role="listbox" aria-label="Issues">
                {issueMatches.map((issue, index) => (
                  <li key={issue.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={index === highlightedIssue}
                      className="prio-mentions__item"
                      data-active={index === highlightedIssue || undefined}
                      onMouseEnter={() => setHighlightedIssue(index)}
                      onClick={() => chooseIssue(issue)}
                    >
                      <span className="prio-key">{issue.key}</span>
                      <span className="prio-truncate">{issue.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}

            {reference && referenceQuery.length > 0 &&
            issueResults.query === referenceQuery &&
            issueMatches.length === 0 ? (
              <p className="prio-mentions__empty">
                No issue you can see matches “{reference.query}”.
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
                <span className="prio-progress" data-kind={entry.kind} aria-hidden>
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
