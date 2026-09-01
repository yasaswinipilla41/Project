import type { BlockNode, InlineNode, RichTextDocument } from "@/lib/richtext";

/**
 * The bridge between Prio's Markdown and an editable DOM.
 *
 * ## What this is for
 *
 * Prio stores comments as Markdown and never stores user-authored HTML — see
 * `richtext.ts` for why. A visual editor needs a DOM to edit, so something has
 * to carry the text across that gap in both directions:
 *
 *   Markdown -> parseRichText -> AST -> `toEditorHtml` -> editable DOM
 *   editable DOM -> `toMarkdown` -> Markdown -> stored
 *
 * ## Why this is safe
 *
 * Two independent reasons, either of which would be enough:
 *
 *  1. **Nothing user-authored is ever set as HTML.** `toEditorHtml` builds its
 *     markup from the parsed AST, tag by tag, and every piece of text passes
 *     through `escapeHtml`. The AST comes from Markdown, which cannot express
 *     an element. So the string handed to the editor is one this module wrote.
 *
 *  2. **Nothing that is not on the allowlist survives serialization.**
 *     `toMarkdown` walks the DOM and recognises a fixed set of elements.
 *     Anything else contributes its *text* and nothing more — a pasted
 *     `<div>`, `<img onerror>` or styled `<span>` leaves behind only whatever
 *     it said in words, and never reaches storage as markup. Elements whose
 *     content is not prose at all — `<script>`, `<style>`, `<template>` and
 *     the rest of `NEVER_TEXT` — contribute nothing, so pasting a web page
 *     does not spill its JavaScript into the comment.
 *
 * So the persisted value is Markdown whatever the editor's DOM contains, and
 * the renderer on the way back out is the existing one.
 *
 * ## The one thing it cannot do
 *
 * Prio's Markdown has no escape syntax — `\\*` renders as a backslash and a
 * star, because that is how existing comments already render and changing it
 * would silently rewrite them. So a person who types a literal `**` in the
 * editor gets bold back when it is reopened. Adding escapes is a change to the
 * *parser*, and to how every comment ever written renders, which is not a
 * decision an editor should make on its own.
 */

/* --------------------------------------------------------------- to HTML */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inlineToHtml(node: InlineNode): string {
  switch (node.kind) {
    case "text":
      return escapeHtml(node.value);
    case "code":
      return `<code>${escapeHtml(node.value)}</code>`;
    case "strong":
      return `<strong>${node.children.map(inlineToHtml).join("")}</strong>`;
    case "em":
      return `<em>${node.children.map(inlineToHtml).join("")}</em>`;
    case "underline":
      return `<u>${node.children.map(inlineToHtml).join("")}</u>`;
    case "strike":
      return `<s>${node.children.map(inlineToHtml).join("")}</s>`;
    case "link":
      /* The href is already through `safeUrl` in the parser, and is escaped
         again here because it is going into an attribute. */
      return `<a href="${escapeHtml(node.href)}" data-rt="link">${node.children
        .map(inlineToHtml)
        .join("")}</a>`;
    case "mention":
      return `<span data-rt="mention">@${escapeHtml(node.handle)}</span>`;
    case "issue":
      return `<span data-rt="issue">${escapeHtml(node.key)}</span>`;
    default:
      return "";
  }
}

function blockToHtml(block: BlockNode): string {
  switch (block.kind) {
    case "paragraph": {
      const inner = block.children.map(inlineToHtml).join("");
      // An empty paragraph still needs a line box, or the caret has nowhere
      // to sit and the browser collapses it.
      return `<p>${inner || "<br>"}</p>`;
    }
    case "heading":
      return `<h${block.level}>${block.children.map(inlineToHtml).join("")}</h${block.level}>`;
    case "quote":
      return `<blockquote>${block.children.map(blockToHtml).join("")}</blockquote>`;
    case "list": {
      const tag = block.ordered ? "ol" : "ul";
      const items = block.items
        .map((item) => `<li>${item.map(inlineToHtml).join("") || "<br>"}</li>`)
        .join("");
      return `<${tag}>${items}</${tag}>`;
    }
    case "code":
      return `<pre><code>${escapeHtml(block.value)}</code></pre>`;
    case "rule":
      return "<hr>";
    default:
      return "";
  }
}

/**
 * The editable markup for a parsed document.
 *
 * Every tag here is written by this function; the only user-supplied part is
 * text, and it is escaped. An empty document still yields one paragraph so
 * the editor has somewhere to put the caret.
 */
export function toEditorHtml(doc: RichTextDocument): string {
  const html = doc.map(blockToHtml).join("");
  return html || "<p><br></p>";
}

/* ----------------------------------------------------------- to Markdown */

/** Inline elements this editor understands. Anything else is text only. */
const INLINE_WRAP: Record<string, string> = {
  STRONG: "**",
  B: "**",
  EM: "*",
  I: "*",
  U: "++",
  S: "~~",
  STRIKE: "~~",
  DEL: "~~",
};

/*
 * Elements whose text is not prose.
 *
 * The general rule below is that an unrecognised element contributes its text
 * — which is right for a `<div>` or a styled `<span>`, and wrong for these:
 * a script's source, a stylesheet's rules and a template's contents are not
 * things anybody meant to say. Pasting a web page should not drop its
 * JavaScript into the comment as words. They were always inert — this is
 * about not writing nonsense into a comment, not about safety.
 */
const NEVER_TEXT = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEMPLATE",
  "IFRAME",
  "OBJECT",
  "EMBED",
  "SVG",
  "CANVAS",
  "AUDIO",
  "VIDEO",
  "HEAD",
  "TITLE",
  "META",
  "LINK",
]);

function inlineToMarkdown(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    // Collapse the newlines a browser leaves in markup; block structure is
    // carried by elements, never by whitespace in the DOM.
    return (node.textContent ?? "").replace(/\r?\n/g, " ");
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";

  const el = node as HTMLElement;
  if (NEVER_TEXT.has(el.tagName)) return "";

  const children = () =>
    Array.from(el.childNodes).map(inlineToMarkdown).join("");

  if (el.tagName === "BR") return "\n";
  if (el.tagName === "CODE" && el.parentElement?.tagName !== "PRE") {
    return `\`${el.textContent ?? ""}\``;
  }

  const wrap = INLINE_WRAP[el.tagName];
  if (wrap) {
    const inner = children();
    // Wrapping nothing would emit "****", which reads as literal stars.
    return inner.trim().length === 0 ? inner : `${wrap}${inner}${wrap}`;
  }

  if (el.tagName === "A") {
    const href = el.getAttribute("href") ?? "";
    const text = children() || href;
    /* A mention or an issue key that happens to be a link keeps its plain
       spelling — the renderer makes it a link again on the way out. */
    if (el.dataset.rt === "mention" || el.dataset.rt === "issue") return text;
    return href ? `[${text}](${href})` : text;
  }

  if (el.tagName === "SPAN" && (el.dataset.rt === "mention" || el.dataset.rt === "issue")) {
    return el.textContent ?? "";
  }

  /*
   * Anything else — a pasted <div>, <script>, <iframe>, <img>, a styled
   * <span> from Word — contributes only what it says. This is the allowlist
   * that makes the whole design hold: unknown markup cannot survive the trip
   * to Markdown, because there is no branch here that would emit it.
   */
  return children();
}

function listToMarkdown(el: HTMLElement, ordered: boolean): string {
  const items = Array.from(el.children).filter((c) => c.tagName === "LI");
  return items
    .map((li, index) => {
      const text = Array.from(li.childNodes).map(inlineToMarkdown).join("").trim();
      return `${ordered ? `${index + 1}.` : "-"} ${text}`;
    })
    .join("\n");
}

function blockToMarkdown(node: Node): string | null {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = (node.textContent ?? "").trim();
    return text.length > 0 ? text : null;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return null;

  const el = node as HTMLElement;
  if (NEVER_TEXT.has(el.tagName)) return null;

  switch (el.tagName) {
    case "P":
    case "DIV": {
      const text = Array.from(el.childNodes).map(inlineToMarkdown).join("").trim();
      return text.length > 0 ? text : "";
    }
    case "H1":
      return `# ${Array.from(el.childNodes).map(inlineToMarkdown).join("").trim()}`;
    case "H2":
      return `## ${Array.from(el.childNodes).map(inlineToMarkdown).join("").trim()}`;
    case "H3":
    case "H4":
    case "H5":
    case "H6":
      // Prio's renderer stops at three levels; deeper headings become the
      // deepest one it has rather than being lost.
      return `### ${Array.from(el.childNodes).map(inlineToMarkdown).join("").trim()}`;
    case "UL":
      return listToMarkdown(el, false);
    case "OL":
      return listToMarkdown(el, true);
    case "BLOCKQUOTE":
      return Array.from(el.childNodes)
        .map(blockToMarkdown)
        .filter((line): line is string => line !== null)
        .map((line) => (line.length > 0 ? `> ${line}` : ">"))
        .join("\n");
    case "PRE": {
      const code = el.textContent ?? "";
      return `\`\`\`\n${code.replace(/\n$/, "")}\n\`\`\``;
    }
    case "HR":
      return "---";
    case "BR":
      return "";
    default: {
      const text = Array.from(el.childNodes).map(inlineToMarkdown).join("").trim();
      return text.length > 0 ? text : null;
    }
  }
}

/** Elements that end a paragraph. Everything else is part of one. */
const BLOCK_TAGS = new Set([
  "P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6",
  "UL", "OL", "BLOCKQUOTE", "PRE", "HR",
]);

/**
 * The Markdown for an editable root.
 *
 * Blocks are separated by a blank line, which is what Prio's parser reads as a
 * paragraph break. Runs of blank lines are collapsed so repeatedly pressing
 * Enter does not accumulate them.
 *
 * The subtlety is that a `contentEditable` does not keep everything in blocks.
 * Type into an empty editor and the browser leaves the text — and any `<b>` or
 * `<em>` wrapped around part of it — loose at the root, as siblings rather
 * than inside a paragraph. Treating each of those as its own block does two
 * wrong things at once: it splits one sentence into a paragraph per fragment,
 * and it unwraps the formatting, because a `<b>` handled as a block is asked
 * for its children rather than for itself. So consecutive inline nodes are
 * gathered into one implicit paragraph and serialised as inline content, which
 * is what they are.
 */
export function toMarkdown(root: HTMLElement): string {
  const blocks: string[] = [];
  let run: Node[] = [];

  const flush = () => {
    if (run.length === 0) return;
    const text = run.map(inlineToMarkdown).join("").trim();
    if (text.length > 0) blocks.push(text);
    run = [];
  };

  for (const child of Array.from(root.childNodes)) {
    const isBlock =
      child.nodeType === Node.ELEMENT_NODE &&
      BLOCK_TAGS.has((child as HTMLElement).tagName);

    if (!isBlock) {
      run.push(child);
      continue;
    }

    flush();
    const block = blockToMarkdown(child);
    if (block !== null) blocks.push(block);
  }
  flush();

  return blocks
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Markdown for arbitrary pasted HTML.
 *
 * The fragment is parsed in an inert document — `DOMParser` with `text/html`
 * does not run script, load images or fetch anything — and then walked by the
 * same allowlist as the editor's own content. What comes back is Markdown, so
 * pasting from Word, Google Docs or a web page contributes formatting Prio
 * understands and nothing else.
 */
export function pastedHtmlToMarkdown(html: string): string {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  return toMarkdown(parsed.body);
}
