import { describe, expect, it } from "vitest";
import { parseRichText } from "@/lib/richtext";
import { toEditorHtml } from "@/lib/markdown-dom";

/**
 * The markup the visual editor is handed.
 *
 * This is one half of the editor's storage boundary — the half that needs no
 * DOM, so it is tested here. The other half (`toMarkdown` and the paste
 * conversion) walks a real DOM and is exercised in the browser, in
 * `tests/e2e/wysiwyg.spec.ts`, rather than against a simulated one.
 *
 * The property that matters: **the editor is never handed user-authored
 * markup.** `toEditorHtml` writes every tag itself from the parsed AST, and
 * the only user-supplied part — text — is escaped on the way in. Markdown
 * cannot express an element, so there is no route from a comment's stored
 * value to an element in the editor.
 */

const html = (markdown: string) => toEditorHtml(parseRichText(markdown));

describe("the editor is handed only markup this module wrote", () => {
  it("escapes angle brackets in text", () => {
    const out = html("a <script>alert(1)</script> b");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
  });

  it("escapes ampersands", () => {
    expect(html("Tom & Jerry")).toContain("Tom &amp; Jerry");
  });

  it("escapes quotes, which would otherwise close an attribute", () => {
    expect(html('say "hello"')).toContain("&quot;hello&quot;");
  });

  it("escapes text inside every formatting wrapper", () => {
    expect(html("**<b>bold</b>**")).toContain("&lt;b&gt;");
    expect(html("`<i>x</i>`")).toContain("&lt;i&gt;");
    expect(html("### <h1>x</h1>")).toContain("&lt;h1&gt;");
    expect(html("- <img src=x>")).toContain("&lt;img");
  });

  it("escapes a link's text and its href", () => {
    const out = html('[a "quoted" label](https://example.com/?a=1&b=2)');
    expect(out).toContain("&quot;quoted&quot;");
    expect(out).toContain("a=1&amp;b=2");
  });

  it("emits no element a comment asked for", () => {
    /* Every tag in the output is one `toEditorHtml` chose. A comment that is
       nothing but markup produces escaped text — the parser still autolinks
       the bare URL inside it, which is a link this module wrote, not the
       iframe the text asked for. */
    const out = html('<iframe src="https://evil.example"></iframe>');
    expect(out).not.toContain("<iframe");
    expect(out).toContain("&lt;iframe");
    expect(out).toContain("&lt;/iframe&gt;");
  });
});

describe("the editor always has somewhere to put the caret", () => {
  it("gives an empty document one empty paragraph", () => {
    expect(toEditorHtml([])).toBe("<p><br></p>");
  });

  it("gives an empty list item a line box", () => {
    expect(html("- ")).toContain("<br>");
  });
});

describe("the supported subset survives the trip in", () => {
  it("maps each formatting mark to the tag the editor edits", () => {
    expect(html("**b**")).toContain("<strong>b</strong>");
    expect(html("*i*")).toContain("<em>i</em>");
    expect(html("++u++")).toContain("<u>u</u>");
    expect(html("~~s~~")).toContain("<s>s</s>");
    expect(html("`c`")).toContain("<code>c</code>");
    expect(html("### h")).toContain("<h3>h</h3>");
    expect(html("- a")).toContain("<ul><li>a</li></ul>");
    expect(html("1. a")).toContain("<ol><li>a</li></ol>");
    expect(html("> q")).toContain("<blockquote>");
  });

  it("marks mentions and issue references so they survive coming back", () => {
    /* A mention only resolves against people who may actually be mentioned
       here — an unresolved `@name` stays plain text, which is the parser's
       existing rule and the reason a mention cannot invent a person. */
    const withPeople = toEditorHtml(
      parseRichText("@Priya Nair", [{ id: "u1", name: "Priya Nair" }]),
    );
    expect(withPeople).toContain('data-rt="mention"');
    expect(html("@Nobody Here")).not.toContain('data-rt="mention"');
    expect(html("ENG-12")).toContain('data-rt="issue"');
  });
});
