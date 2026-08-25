import { describe, expect, it } from "vitest";
import {
  extractMentions,
  isBlankRichText,
  normalizeRichText,
  parseRichText,
  richTextToPlain,
  safeUrl,
  type BlockNode,
  type InlineNode,
} from "@/lib/richtext";

/**
 * Rich text, and the security properties that come with how it is built.
 *
 * Prio never stores or renders user-authored HTML. A comment is text; the
 * parser turns it into a tree of typed values; the renderer turns that tree
 * into React elements with the text as children. These tests pin that down:
 * whatever an author types, the tree that comes out contains no markup — only
 * text nodes and the handful of formatting nodes the parser can produce.
 *
 * "It renders safely" is therefore checked at the tree, which is the layer that
 * decides. A test that only inspected the final DOM would pass just as happily
 * against an implementation that sanitized badly.
 */

/** Every string that ends up as visible text, in order. */
function textOf(blocks: BlockNode[]): string {
  const inline = (nodes: InlineNode[]): string =>
    nodes
      .map((node) => {
        if (node.kind === "text") return node.value;
        if (node.kind === "code") return node.value;
        if (node.kind === "mention") return `@${node.handle}`;
        return inline(node.children);
      })
      .join("");

  return blocks
    .map((block) => {
      switch (block.kind) {
        case "paragraph":
        case "heading":
          return inline(block.children);
        case "list":
          return block.items.map(inline).join("\n");
        case "quote":
          return textOf(block.children);
        case "code":
          return block.value;
        case "rule":
          return "";
      }
    })
    .join("\n");
}

/** Collects every node of a given kind, at any depth. */
function collect(blocks: BlockNode[], kind: InlineNode["kind"]): InlineNode[] {
  const found: InlineNode[] = [];

  const walkInline = (nodes: InlineNode[]) => {
    for (const node of nodes) {
      if (node.kind === kind) found.push(node);
      if ("children" in node) walkInline(node.children);
    }
  };

  const walk = (list: BlockNode[]) => {
    for (const block of list) {
      if (block.kind === "paragraph" || block.kind === "heading") {
        walkInline(block.children);
      } else if (block.kind === "list") {
        block.items.forEach(walkInline);
      } else if (block.kind === "quote") {
        walk(block.children);
      }
    }
  };

  walk(blocks);
  return found;
}

describe("XSS — script and markup", () => {
  const payloads = [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "<svg/onload=alert(1)>",
    "<iframe src='javascript:alert(1)'></iframe>",
    "<body onload=alert(1)>",
    "<math><mtext><table><mglyph><style><!--</style><img src=x onerror=alert(1)>",
    "<template><script>alert(1)</script></template>",
    "<a href='javascript:alert(1)'>click</a>",
    "<object data='data:text/html,<script>alert(1)</script>'></object>",
    "<xss style=behavior:url(#default#time2)>",
    "<script>alert(1)</script>",
  ];

  for (const payload of payloads) {
    it(`keeps ${payload.slice(0, 32)}… as literal text`, () => {
      const blocks = parseRichText(payload);

      // The characters survive — nothing is silently swallowed…
      expect(textOf(blocks)).toContain("<");

      // …and no node type capable of executing anything was produced. The
      // parser has no HTML branch at all, which is the actual guarantee.
      const kinds = new Set<string>();
      const walk = (list: BlockNode[]) => {
        for (const block of list) {
          kinds.add(block.kind);
          if (block.kind === "quote") walk(block.children);
        }
      };
      walk(blocks);

      expect([...kinds].every((k) =>
        ["paragraph", "heading", "quote", "list", "code", "rule"].includes(k),
      )).toBe(true);

      // Specifically: no link was created from any of these.
      expect(collect(blocks, "link")).toHaveLength(0);
    });
  }
});

describe("XSS — dangerous URLs", () => {
  const hostile = [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "  javascript:alert(1)",
    "java\tscript:alert(1)",
    "java\nscript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "//evil.example.com/steal",
  ];

  for (const url of hostile) {
    it(`refuses ${JSON.stringify(url)}`, () => {
      expect(safeUrl(url)).toBeNull();
    });

    it(`renders [x](${JSON.stringify(url)}) as text, not a link`, () => {
      const blocks = parseRichText(`[click me](${url})`);
      expect(collect(blocks, "link")).toHaveLength(0);
      expect(textOf(blocks)).toContain("click me");
    });
  }

  const allowed = [
    "https://example.com/path?q=1",
    "http://intranet.local/page",
    "mailto:someone@symbiosystech.com",
    "/issues/eng-1",
  ];

  for (const url of allowed) {
    it(`allows ${url}`, () => {
      expect(safeUrl(url)).not.toBeNull();
    });
  }

  it("builds a real link only from an allowed URL", () => {
    const blocks = parseRichText("see [the docs](https://example.com/a)");
    const links = collect(blocks, "link");

    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ kind: "link" });
    if (links[0]?.kind === "link") {
      expect(links[0].href.startsWith("https://example.com/a")).toBe(true);
    }
  });
});

describe("normalization", () => {
  it("removes NUL and C0 control characters but keeps tabs and newlines", () => {
    const raw = "a\u0000b\u0007c\td\ne";
    const clean = normalizeRichText(raw);

    expect(clean).not.toContain("\u0000");
    expect(clean).not.toContain("\u0007");
    expect(clean).toContain("\t");
    expect(clean).toContain("\n");
  });

  it("removes bidirectional overrides used to disguise text", () => {
    // The classic trick: overrides make a string read differently from what it
    // contains, which is how "gnp.exe" is displayed as "exe.png".
    const clean = normalizeRichText("safe\u202Eevil\u202C");
    expect(clean).toBe("safeevil");
  });

  it("caps absurd input rather than parsing it", () => {
    expect(normalizeRichText("x".repeat(60_000))).toHaveLength(20_000);
  });

  it("treats whitespace-only content as blank", () => {
    expect(isBlankRichText("   \n\t  ")).toBe(true);
    expect(isBlankRichText("\u200B")).toBe(true);
    expect(isBlankRichText("hi")).toBe(false);
  });
});

describe("formatting", () => {
  it("parses the supported inline marks", () => {
    const blocks = parseRichText(
      "**bold** *italic* ++under++ ~~strike~~ `code`",
    );
    expect(collect(blocks, "strong")).toHaveLength(1);
    expect(collect(blocks, "em")).toHaveLength(1);
    expect(collect(blocks, "underline")).toHaveLength(1);
    expect(collect(blocks, "strike")).toHaveLength(1);
    expect(collect(blocks, "code")).toHaveLength(1);
  });

  it("treats the inside of backticks as literal", () => {
    const blocks = parseRichText("`**not bold** <script>`");
    const code = collect(blocks, "code");

    expect(code).toHaveLength(1);
    if (code[0]?.kind === "code") {
      expect(code[0].value).toBe("**not bold** <script>");
    }
    expect(collect(blocks, "strong")).toHaveLength(0);
  });

  it("keeps a fenced block verbatim", () => {
    const blocks = parseRichText("```ts\nconst a = <b>1</b>;\n```");

    expect(blocks[0]?.kind).toBe("code");
    if (blocks[0]?.kind === "code") {
      expect(blocks[0].language).toBe("ts");
      expect(blocks[0].value).toBe("const a = <b>1</b>;");
    }
  });

  it("parses headings, lists and quotes", () => {
    const blocks = parseRichText(
      "## Title\n\n- one\n- two\n\n1. first\n\n> quoted",
    );
    const kinds = blocks.map((b) => b.kind);

    expect(kinds).toContain("heading");
    expect(kinds).toContain("list");
    expect(kinds).toContain("quote");
  });

  it("flattens to plain text for notifications", () => {
    const plain = richTextToPlain("## Title\n\n**bold** and `code`");
    expect(plain).toBe("Title bold and code");
  });
});

describe("mentions", () => {
  const people = [
    { id: "u1", name: "Priya Nair" },
    { id: "u2", name: "Kiran Das" },
  ];

  it("resolves a full name to the person", () => {
    expect(extractMentions("hi @Priya Nair please look", people)).toEqual(["u1"]);
  });

  it("does not invent a person who is not on the list", () => {
    // This is the authorization property, expressed in the parser: someone who
    // cannot be mentioned here simply does not become a mention.
    expect(extractMentions("hi @Nobody Here", people)).toEqual([]);

    const blocks = parseRichText("hi @Nobody Here", people);
    expect(collect(blocks, "mention")).toHaveLength(0);
    expect(textOf(blocks)).toContain("@Nobody");
  });

  it("prefers the longest matching name", () => {
    const overlapping = [
      { id: "u1", name: "Priya" },
      { id: "u2", name: "Priya Nair" },
    ];
    expect(extractMentions("@Priya Nair", overlapping)).toEqual(["u2"]);
  });

  it("reports each person once however often they are named", () => {
    expect(
      extractMentions("@Priya Nair @Priya Nair @Kiran Das", people),
    ).toEqual(["u1", "u2"]);
  });

  it("ignores an @ inside an email address", () => {
    expect(extractMentions("mail priya@symbiosystech.com", people)).toEqual([]);
  });
});
