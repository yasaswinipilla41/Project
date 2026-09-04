"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import { parseRichText, type MentionCandidate } from "@/lib/richtext";
import {
  pastedHtmlToMarkdown,
  toEditorHtml,
  toMarkdown,
} from "@/lib/markdown-dom";

/**
 * A visual editor whose stored value is Markdown.
 *
 * ## The shape of it
 *
 *   Markdown in  ->  parseRichText  ->  toEditorHtml  ->  contentEditable
 *   contentEditable  ->  toMarkdown  ->  Markdown out
 *
 * Nothing else is stored. The DOM in the middle is a working surface, not a
 * document format: whatever ends up in it — typed, pasted, or produced by the
 * browser's own editing commands — leaves as Markdown or as plain text,
 * because `toMarkdown` only recognises a fixed set of elements.
 *
 * ## Why the browser's editing commands are safe here
 *
 * Formatting uses `document.execCommand`. It is deprecated, and it is famously
 * inconsistent about the markup it produces — one browser's bold is `<b>`,
 * another's is `<strong>`, and with `styleWithCSS` on it is a styled `<span>`.
 * None of that reaches storage. The serializer normalises all of it, so the
 * messiness is confined to a DOM that is thrown away. Writing a selection
 * engine by hand to avoid a deprecated API would be a great deal of subtle
 * code to produce a value this module already normalises.
 *
 * ## Why React does not own the content
 *
 * React re-rendering a `contentEditable`'s children moves the caret to the
 * start on every keystroke. So the markup is written once — on mount, and
 * again only when the value changes from outside, such as a reset after
 * submitting — and the browser owns it from then on. `lastEmitted` is what
 * distinguishes "the parent echoed our own value back" from "the parent
 * genuinely replaced it".
 */

export interface MarkdownEditorHandle {
  /** The text of the current line up to the caret — what the pickers read. */
  textBeforeCaret: () => string;
  /** Read the document back out now. Formatting commands do not fire `input`. */
  syncNow: () => void;
  /** Replace `back` characters before the caret with `text`. */
  replaceBeforeCaret: (back: number, text: string) => void;
  focus: () => void;
  /**
   * The editable element itself.
   *
   * The toolbar needs it to answer one question: is the caret in *this*
   * editor? A page can hold two composers — the one at the foot of the
   * conversation and an open reply — and a selection in one must not light up
   * the other's buttons.
   */
  element: () => HTMLDivElement | null;
}

export interface MarkdownEditorProps {
  value: string;
  onChange: (markdown: string) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
  onBlur?: () => void;
  placeholder?: string;
  ariaLabel?: string;
  id?: string;
  mentionable?: MentionCandidate[];
  /** Focus on mount — a reply box opened by a click should be ready to type in. */
  autoFocus?: boolean;
}

export const MarkdownEditor = forwardRef<
  MarkdownEditorHandle,
  MarkdownEditorProps
>(function MarkdownEditor(
  {
    value,
    onChange,
    onKeyDown,
    onBlur,
    placeholder,
    ariaLabel,
    id,
    mentionable = [],
    autoFocus = false,
  },
  ref,
) {
  const host = useRef<HTMLDivElement>(null);
  const lastEmitted = useRef<string>("");

  /* Write the markup only when the value did not come from this editor. */
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    if (value === lastEmitted.current) return;

    el.innerHTML = toEditorHtml(parseRichText(value, mentionable));
    lastEmitted.current = value;
    // `mentionable` only decides how a mention is marked up; re-rendering the
    // whole document because that list arrived would discard the caret.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  /* `contentEditable` has no `autofocus` attribute, so the request is honoured
     after the markup is written — focusing an empty div would put the caret
     nowhere. */
  useEffect(() => {
    if (!autoFocus) return;
    host.current?.focus();
  }, [autoFocus]);

  const emit = useCallback(() => {
    const el = host.current;
    if (!el) return;
    const markdown = toMarkdown(el);
    lastEmitted.current = markdown;
    onChange(markdown);
  }, [onChange]);

  useImperativeHandle(ref, () => ({
    element: () => host.current,
    textBeforeCaret() {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return "";
      const range = selection.getRangeAt(0);
      const node = range.startContainer;
      if (node.nodeType !== Node.TEXT_NODE) return "";
      return (node.textContent ?? "").slice(0, range.startOffset);
    },

    replaceBeforeCaret(back: number, text: string) {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return;
      const range = selection.getRangeAt(0);
      const node = range.startContainer;
      if (node.nodeType !== Node.TEXT_NODE) return;

      const at = range.startOffset;
      const from = Math.max(0, at - back);
      const replacement = document.createRange();
      replacement.setStart(node, from);
      replacement.setEnd(node, at);
      replacement.deleteContents();

      const inserted = document.createTextNode(text);
      replacement.insertNode(inserted);

      // Caret after what was inserted, so typing carries on from there.
      const after = document.createRange();
      after.setStartAfter(inserted);
      after.collapse(true);
      selection.removeAllRanges();
      selection.addRange(after);

      emit();
    },

    syncNow() {
      emit();
    },

    focus() {
      host.current?.focus();
    },
  }));

  /**
   * Paste, normalised.
   *
   * Rich text is converted to Markdown by the same allowlist the editor's own
   * content goes through, then re-parsed and inserted as markup this module
   * built. So pasting from Word, Google Docs or a web page contributes the
   * formatting Prio understands and drops the rest — no pasted element is ever
   * adopted into the document, let alone stored.
   */
  function handlePaste(event: ClipboardEvent<HTMLDivElement>) {
    event.preventDefault();

    const html = event.clipboardData.getData("text/html");
    const plain = event.clipboardData.getData("text/plain");
    const markdown = html ? pastedHtmlToMarkdown(html) : plain;
    if (!markdown) return;

    const fragment = toEditorHtml(parseRichText(markdown, mentionable));

    /* `insertHTML` with markup this module generated — never the clipboard's
       own. The distinction is the whole point: the browser is inserting our
       rendering of the paste, not the paste. */
    document.execCommand("insertHTML", false, fragment);
    emit();
  }

  return (
    <div
      id={id}
      ref={host}
      className="prio-wysiwyg"
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label={ariaLabel}
      /* `aria-placeholder` is the textbox-role equivalent of the attribute a
         real input would carry; `data-placeholder` is what the CSS draws. */
      aria-placeholder={placeholder}
      data-placeholder={placeholder}
      onInput={emit}
      onBlur={onBlur}
      onPaste={handlePaste}
      onKeyDown={onKeyDown}
    />
  );
});

/* ------------------------------------------------------------- commands */

/**
 * Apply a formatting command to the current selection.
 *
 * `styleWithCSS` is turned off first so the browser reaches for tags rather
 * than styled spans. It matters less than it looks — the serializer would drop
 * the styles either way — but tags round-trip through it, and a styled span
 * would silently lose the formatting it was carrying.
 */
export function applyFormat(command: FormatCommand): void {
  document.execCommand("styleWithCSS", false, "false");

  switch (command) {
    case "bold":
    case "italic":
    case "underline":
    case "strikeThrough":
      document.execCommand(command);
      return;
    case "ul":
      document.execCommand("insertUnorderedList");
      return;
    case "ol":
      document.execCommand("insertOrderedList");
      return;
    case "heading":
      document.execCommand("formatBlock", false, "h3");
      return;
    case "quote":
      document.execCommand("formatBlock", false, "blockquote");
      return;
    case "paragraph":
      document.execCommand("formatBlock", false, "p");
      return;
  }
}

export type FormatCommand =
  | "bold"
  | "italic"
  | "underline"
  | "strikeThrough"
  | "ul"
  | "ol"
  | "heading"
  | "quote"
  | "paragraph";

/** Everything the toolbar can light up, including controls that are not
 *  formatting commands — a link and a mention are places the caret can be. */
export type ToolbarState = FormatCommand | "link" | "mention";

/** Whether the caret currently sits inside this formatting. */
export function isFormatActive(command: FormatCommand): boolean {
  try {
    switch (command) {
      case "bold":
      case "italic":
      case "underline":
      case "strikeThrough":
        return document.queryCommandState(command);
      case "ul":
        return document.queryCommandState("insertUnorderedList");
      case "ol":
        return document.queryCommandState("insertOrderedList");
      default:
        return false;
    }
  } catch {
    // `queryCommandState` throws in some browsers when there is no selection.
    return false;
  }
}

/** Is the selection inside `root`? Both ends, so a selection that starts in
 *  one editor and ends outside it lights up neither. */
function selectionWithin(root: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;
  const range = selection.getRangeAt(0);
  return (
    root.contains(range.startContainer) && root.contains(range.endContainer)
  );
}

/**
 * Does an element matching `test` enclose the caret, at or below `root`?
 *
 * `queryCommandState` answers for bold, italic and the lists, and nothing
 * else: there is no command state for "inside a heading" or "inside a link".
 * Those are read from the document itself, by walking up from where the
 * selection starts — which is the real editor state, not a copy of it kept
 * alongside.
 */
function enclosing(root: HTMLElement, test: (el: Element) => boolean): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return false;

  let node: Node | null = selection.getRangeAt(0).startContainer;
  while (node && node !== root) {
    if (node.nodeType === Node.ELEMENT_NODE && test(node as Element)) {
      return true;
    }
    node = node.parentNode;
  }
  return false;
}

/**
 * What the caret is sitting in, right now, for every toolbar control.
 *
 * Read from the browser's own selection each time it is asked, rather than
 * tracked as the user types: a state kept alongside the document drifts the
 * moment anything changes it that the toolbar did not do — an undo, a paste,
 * a keyboard shortcut, or simply moving the caret into text that was already
 * bold.
 *
 * Returns everything false when the selection is not in this editor, so a
 * second composer on the page cannot light up this one's buttons.
 */
export function readToolbarState(
  root: HTMLElement | null,
): Record<ToolbarState, boolean> {
  const off: Record<ToolbarState, boolean> = {
    bold: false,
    italic: false,
    underline: false,
    strikeThrough: false,
    ul: false,
    ol: false,
    heading: false,
    quote: false,
    paragraph: false,
    link: false,
    mention: false,
  };

  if (!root || !selectionWithin(root)) return off;

  const tag = (...names: string[]) => (el: Element) =>
    names.includes(el.tagName);

  return {
    bold: isFormatActive("bold"),
    italic: isFormatActive("italic"),
    underline: isFormatActive("underline"),
    strikeThrough: isFormatActive("strikeThrough"),
    ul: isFormatActive("ul"),
    ol: isFormatActive("ol"),
    /* `applyFormat` writes an `h3` for a heading, so that is what is looked
       for — but any heading level counts, because pasted content can carry
       one and the button should say so. */
    heading: enclosing(root, tag("H1", "H2", "H3", "H4", "H5", "H6")),
    quote: enclosing(root, tag("BLOCKQUOTE")),
    link: enclosing(root, tag("A")),
    mention: enclosing(
      root,
      (el) => el instanceof HTMLElement && el.dataset.rt === "mention",
    ),
    /* Paragraph is the absence of the block formats above rather than a
       state of its own; it has no toolbar button, and saying "active" for
       ordinary text would light up a control nobody pressed. */
    paragraph: false,
  };
}
