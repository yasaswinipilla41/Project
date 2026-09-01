/**
 * Prio's rich text: a small Markdown subset, parsed into a typed document.
 *
 * ## Why this shape
 *
 * The security requirement is that user-authored content can never execute.
 * The usual answer is to accept HTML and filter it, which means betting that
 * the filter knows every trick — mutation XSS, namespace confusion, mXSS
 * through `<svg>`, `<math>` or `<template>`, and whatever is found next year.
 *
 * Prio does not take that bet. **No user-authored HTML is ever stored, parsed
 * or rendered.** A comment is stored as the plain text the author typed. This
 * module turns that text into a tree of ordinary values, and the renderer turns
 * that tree into React elements. Text becomes a React text child, which React
 * escapes; there is no `dangerouslySetInnerHTML` anywhere in the path.
 *
 * So `<script>alert(1)</script>` is not sanitized away — it is displayed, as
 * the characters the author typed, which is what they asked for and is inert.
 *
 * The one place a value reaches a DOM attribute is a link's `href`, and
 * `safeUrl` below is the gate for it.
 *
 * ## The subset
 *
 *   # .. ###        headings
 *   - / * / 1.      lists
 *   >               quote
 *   ```             fenced code block
 *   **bold**  *italic*  ++underline++  `code`  ~~strike~~
 *   [text](url)     link
 *   @name           mention
 *   ENG-12          issue reference
 *
 * Underline has no Markdown spelling; `++text++` is used, matching the
 * convention several Markdown dialects settled on.
 */

/* -------------------------------------------------------------- inline */

export type InlineNode =
  | { kind: "text"; value: string }
  | { kind: "strong"; children: InlineNode[] }
  | { kind: "em"; children: InlineNode[] }
  | { kind: "underline"; children: InlineNode[] }
  | { kind: "strike"; children: InlineNode[] }
  | { kind: "code"; value: string }
  | { kind: "link"; href: string; children: InlineNode[] }
  | { kind: "mention"; handle: string; userId: string | null }
  | { kind: "issue"; key: string };

export type BlockNode =
  | { kind: "paragraph"; children: InlineNode[] }
  | { kind: "heading"; level: 1 | 2 | 3; children: InlineNode[] }
  | { kind: "quote"; children: BlockNode[] }
  | { kind: "list"; ordered: boolean; items: InlineNode[][] }
  | { kind: "code"; language: string | null; value: string }
  | { kind: "rule" };

export type RichTextDocument = BlockNode[];

/** Someone who may be mentioned, resolved before parsing. */
export interface MentionCandidate {
  id: string;
  name: string;
}

/* ------------------------------------------------------------ url safety */

/**
 * The only values allowed to reach an `href`.
 *
 * An allowlist, not a denylist: anything whose scheme is not explicitly
 * permitted is rejected. That closes `javascript:`, `data:`, `vbscript:`,
 * `file:` and every future scheme at once, including obfuscations like
 * `JaVaScRiPt:` or `java\tscript:` that a denylist has to enumerate.
 *
 * Returns `null` when the URL cannot be trusted; callers render plain text.
 */
export function safeUrl(raw: string): string | null {
  const value = raw.trim();
  if (value.length === 0 || value.length > 2048) return null;

  // Control characters are the classic way to smuggle a scheme past a check.
  if (/[\u0000-\u0020]/.test(value)) return null;

  // Relative links inside Prio are fine, but not protocol-relative ("//host"),
  // which inherits the page's scheme and points off-site.
  if (value.startsWith("/") && !value.startsWith("//")) return value;

  const scheme = value.slice(0, value.indexOf(":")).toLowerCase();
  if (!/^(https?|mailto)$/.test(scheme)) return null;

  try {
    const url = new URL(value);
    // Re-check after parsing: `new URL` normalizes, and the normalized scheme
    // is the one the browser will actually act on.
    if (!["http:", "https:", "mailto:"].includes(url.protocol)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------- parsing */

const MAX_LENGTH = 20_000;

/**
 * Strips characters that have no business in a comment before anything else
 * looks at the text: NUL and the C0 controls (tab and newline excepted), plus
 * the bidirectional overrides used to make text read differently from what it
 * contains.
 */
export function normalizeRichText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
    .slice(0, MAX_LENGTH);
}

/** True when the text carries nothing a reader would see. */
export function isBlankRichText(raw: string): boolean {
  return normalizeRichText(raw).trim().length === 0;
}

/** Every distinct person named with `@` in the text. */
export function extractMentions(
  raw: string,
  candidates: MentionCandidate[],
): string[] {
  const found = new Set<string>();
  for (const block of parseRichText(raw, candidates)) {
    collectMentions(block, found);
  }
  return [...found];
}

function collectMentions(node: BlockNode, into: Set<string>): void {
  switch (node.kind) {
    case "paragraph":
    case "heading":
      node.children.forEach((child) => collectInlineMentions(child, into));
      break;
    case "list":
      node.items.forEach((item) =>
        item.forEach((child) => collectInlineMentions(child, into)),
      );
      break;
    case "quote":
      node.children.forEach((child) => collectMentions(child, into));
      break;
    default:
      break;
  }
}

function collectInlineMentions(node: InlineNode, into: Set<string>): void {
  if (node.kind === "mention") {
    if (node.userId) into.add(node.userId);
    return;
  }
  if ("children" in node) {
    node.children.forEach((child) => collectInlineMentions(child, into));
  }
}

/**
 * Parses the text into blocks.
 *
 * Deliberately line-oriented and non-recursive beyond one level of quoting:
 * a comment box is not a document editor, and a simple parser is one that can
 * be read and reasoned about.
 */
export function parseRichText(
  raw: string,
  candidates: MentionCandidate[] = [],
): RichTextDocument {
  const text = normalizeRichText(raw);
  const lines = text.split("\n");
  const blocks: BlockNode[] = [];

  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";

    // Fenced code: everything until the closing fence is verbatim, including
    // anything that would otherwise look like markup.
    const fence = /^```(\w{0,20})\s*$/.exec(line);
    if (fence) {
      const language = fence[1] ? fence[1] : null;
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? "")) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      index += 1; // consume the closing fence, if it was there
      blocks.push({ kind: "code", language, value: body.join("\n") });
      continue;
    }

    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    if (/^ {0,3}(---|\*\*\*|___)\s*$/.test(line)) {
      blocks.push({ kind: "rule" });
      index += 1;
      continue;
    }

    const heading = /^ {0,3}(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length as 1 | 2 | 3;
      blocks.push({
        kind: "heading",
        level,
        children: parseInline(heading[2] ?? "", candidates),
      });
      index += 1;
      continue;
    }

    if (/^ {0,3}>\s?/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^ {0,3}>\s?/.test(lines[index] ?? "")) {
        quoted.push((lines[index] ?? "").replace(/^ {0,3}>\s?/, ""));
        index += 1;
      }
      blocks.push({
        kind: "quote",
        children: parseRichText(quoted.join("\n"), candidates),
      });
      continue;
    }

    const bullet = /^ {0,3}[-*+]\s+(.*)$/.exec(line);
    const numbered = /^ {0,3}\d{1,9}[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const ordered = Boolean(numbered);
      const items: InlineNode[][] = [];

      while (index < lines.length) {
        const current = lines[index] ?? "";
        const match = ordered
          ? /^ {0,3}\d{1,9}[.)]\s+(.*)$/.exec(current)
          : /^ {0,3}[-*+]\s+(.*)$/.exec(current);
        if (!match) break;
        items.push(parseInline(match[1] ?? "", candidates));
        index += 1;
      }

      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    // Paragraph: consecutive non-blank lines that start nothing else.
    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? "";
      if (
        current.trim().length === 0 ||
        /^ {0,3}(#{1,3}\s|>|[-*+]\s|\d{1,9}[.)]\s|```)/.test(current) ||
        /^ {0,3}(---|\*\*\*|___)\s*$/.test(current)
      ) {
        break;
      }
      paragraph.push(current);
      index += 1;
    }

    blocks.push({
      kind: "paragraph",
      children: parseInline(paragraph.join("\n"), candidates),
    });
  }

  return blocks;
}

/* ---------------------------------------------------------------- inline */

/**
 * Inline markers, longest first so `**` is tried before `*`.
 *
 * Inline code is handled ahead of everything else: text inside backticks is
 * literal, which is how an author quotes markup without it being interpreted.
 */
const INLINE_RULES: {
  pattern: RegExp;
  build: (inner: string, candidates: MentionCandidate[]) => InlineNode;
}[] = [
  {
    pattern: /\*\*([^\n]+?)\*\*/,
    build: (inner, c) => ({ kind: "strong", children: parseInline(inner, c) }),
  },
  {
    pattern: /\+\+([^\n]+?)\+\+/,
    build: (inner, c) => ({ kind: "underline", children: parseInline(inner, c) }),
  },
  {
    pattern: /~~([^\n]+?)~~/,
    build: (inner, c) => ({ kind: "strike", children: parseInline(inner, c) }),
  },
  {
    pattern: /(?<!\*)\*([^*\n]+?)\*(?!\*)/,
    build: (inner, c) => ({ kind: "em", children: parseInline(inner, c) }),
  },
  {
    pattern: /_([^_\n]+?)_/,
    build: (inner, c) => ({ kind: "em", children: parseInline(inner, c) }),
  },
];

const CODE_PATTERN = /`([^`\n]+?)`/;
const LINK_PATTERN = /\[([^\]\n]{1,200})\]\(([^)\s]{1,2048})\)/;
const BARE_URL_PATTERN = /\bhttps?:\/\/[^\s<>()]{3,2048}/;
const MENTION_PATTERN = /@([A-Za-z][A-Za-z0-9._-]{0,63}(?: [A-Z][a-z]{1,31})?)/;

/*
 * An issue key: a project key, a dash, a number — "ENG-12". Matched anywhere
 * in a sentence, with or without the `#` the composer types to find one, since
 * people write keys either way and both mean the same issue. The boundaries
 * stop it firing inside a longer word or a hyphenated compound.
 *
 * Whether the issue exists, and whether the reader may see it, is not decided
 * here: this only produces a link to Prio's own issue route, which authorizes
 * on arrival like any other visit to it.
 */
const ISSUE_PATTERN = /(?<![\w-])#?([A-Z][A-Z0-9]{1,9}-\d{1,7})(?![\w-])/;

function parseInline(
  raw: string,
  candidates: MentionCandidate[],
): InlineNode[] {
  if (raw.length === 0) return [];

  /* Code first: whatever is inside backticks is never looked at again. */
  const code = CODE_PATTERN.exec(raw);
  if (code) {
    return [
      ...parseInline(raw.slice(0, code.index), candidates),
      { kind: "code", value: code[1] ?? "" },
      ...parseInline(raw.slice(code.index + code[0].length), candidates),
    ];
  }

  const link = LINK_PATTERN.exec(raw);
  if (link) {
    const href = safeUrl(link[2] ?? "");
    const label = link[1] ?? "";
    const node: InlineNode = href
      ? { kind: "link", href, children: parseInline(label, candidates) }
      : // An unusable URL is shown as the text the author wrote, so nothing is
        // silently dropped and nothing unsafe is linked.
        { kind: "text", value: link[0] };

    return [
      ...parseInline(raw.slice(0, link.index), candidates),
      node,
      ...parseInline(raw.slice(link.index + link[0].length), candidates),
    ];
  }

  for (const rule of INLINE_RULES) {
    const match = rule.pattern.exec(raw);
    if (!match) continue;
    return [
      ...parseInline(raw.slice(0, match.index), candidates),
      rule.build(match[1] ?? "", candidates),
      ...parseInline(raw.slice(match.index + match[0].length), candidates),
    ];
  }

  const bare = BARE_URL_PATTERN.exec(raw);
  if (bare) {
    const href = safeUrl(bare[0]);
    const node: InlineNode = href
      ? { kind: "link", href, children: [{ kind: "text", value: bare[0] }] }
      : { kind: "text", value: bare[0] };
    return [
      ...parseInline(raw.slice(0, bare.index), candidates),
      node,
      ...parseInline(raw.slice(bare.index + bare[0].length), candidates),
    ];
  }

  const issue = ISSUE_PATTERN.exec(raw);
  if (issue) {
    return [
      ...parseInline(raw.slice(0, issue.index), candidates),
      { kind: "issue", key: issue[1] ?? "" },
      ...parseInline(raw.slice(issue.index + issue[0].length), candidates),
    ];
  }

  const mention = MENTION_PATTERN.exec(raw);
  if (mention) {
    const handle = mention[1] ?? "";
    const matched = matchCandidate(handle, candidates);

    return [
      ...parseInline(raw.slice(0, mention.index), candidates),
      matched
        ? { kind: "mention", handle: matched.name, userId: matched.id }
        : // Nobody by that name is reachable here, so it stays plain text
          // rather than becoming a link to a person who does not exist.
          { kind: "text", value: mention[0] },
      ...parseInline(
        raw.slice(
          mention.index +
            (matched ? matched.consumed : mention[0].length),
        ),
        candidates,
      ),
    ];
  }

  return [{ kind: "text", value: raw }];
}

/**
 * Resolves `@Priya Nair` or `@priya.nair` against the people who may be
 * mentioned here. Longest name wins, so "@Priya Nair" is not read as "@Priya".
 */
function matchCandidate(
  handle: string,
  candidates: MentionCandidate[],
): { id: string; name: string; consumed: number } | null {
  const lowered = handle.toLowerCase();

  const byName = candidates
    .filter((c) => lowered.startsWith(c.name.toLowerCase()))
    .sort((a, b) => b.name.length - a.name.length)[0];

  if (byName) {
    return { id: byName.id, name: byName.name, consumed: 1 + byName.name.length };
  }

  const exact = candidates.find((c) => c.name.toLowerCase() === lowered);
  if (exact) return { id: exact.id, name: exact.name, consumed: 1 + handle.length };

  return null;
}

/* ------------------------------------------------------------ plain text */

/**
 * The document as readable plain text — used for notification messages and
 * email subject lines, where markup would be noise.
 */
export function richTextToPlain(raw: string, max = 280): string {
  const flatten = (nodes: InlineNode[]): string =>
    nodes
      .map((node) => {
        if (node.kind === "text") return node.value;
        if (node.kind === "code") return node.value;
        if (node.kind === "mention") return `@${node.handle}`;
        if (node.kind === "issue") return node.key;
        return flatten(node.children);
      })
      .join("");

  const walk = (blocks: BlockNode[]): string[] =>
    blocks.flatMap((block) => {
      switch (block.kind) {
        case "paragraph":
        case "heading":
          return [flatten(block.children)];
        case "list":
          return block.items.map((item) => flatten(item));
        case "quote":
          return walk(block.children);
        case "code":
          return [block.value];
        case "rule":
          return [];
      }
    });

  const text = walk(parseRichText(raw)).join(" ").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
