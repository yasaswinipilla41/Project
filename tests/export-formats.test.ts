import { describe, expect, it } from "vitest";
import {
  csvDocument,
  csvField,
  escapeHtml,
  htmlDocument,
} from "@/lib/exportText";

/**
 * The two text formats the export can produce.
 *
 * Every test here is about a character somebody typed into Prio and what it
 * does to a file: a comma in a title, a quote in a description, a newline in a
 * list of attachments, an angle bracket in a label. Those are the cases where
 * a naive writer produces a file that opens, looks plausible, and is wrong —
 * which is worse than one that fails.
 */

describe("a CSV field", () => {
  it("leaves an ordinary value alone", () => {
    expect(csvField("Login fails")).toBe("Login fails");
  });

  it("quotes a value holding a comma, so the row keeps its columns", () => {
    /* The failure this prevents: without quoting, "Login fails, sometimes"
       becomes two fields and every column after it in that row shifts by one —
       for that row alone, which is what makes it hard to notice. */
    expect(csvField("Login fails, sometimes")).toBe('"Login fails, sometimes"');
  });

  it("doubles quotes inside a quoted value", () => {
    expect(csvField('He said "no"')).toBe('"He said ""no"""');
  });

  it("quotes a value holding a line break", () => {
    /* Attachment names and links are newline-separated within their cell. */
    expect(csvField("one.png\ntwo.png")).toBe('"one.png\ntwo.png"');
  });

  it("disarms a value a spreadsheet would run as a formula", () => {
    /*
     * The one that matters beyond tidiness. A title beginning `=` is a formula
     * to Excel when the file is opened, so an export could carry somebody's
     * typing into a colleague's machine as code. The import side refuses to
     * evaluate formulas for the same reason; the export side should not be
     * writing them.
     */
    expect(csvField("=1+1")).toBe("'=1+1");
    expect(csvField("+44 7700 900000")).toBe("'+44 7700 900000");
    expect(csvField("-1")).toBe("'-1");
    expect(csvField("@handle")).toBe("'@handle");
  });

  it("does not disarm a value that merely contains one of those", () => {
    expect(csvField("a = b")).toBe("a = b");
  });
});

describe("a CSV document", () => {
  const doc = csvDocument([
    ["Key", "Title"],
    ["ENG-1", "Plain"],
    ["ENG-2", 'Comma, and "quote"'],
  ]);

  it("starts with a byte order mark, so Excel reads it as UTF-8", () => {
    /* Without one, Excel reads the file as the system code page and a name
       with an accent in it arrives mangled — on exactly the machines this
       export is for. */
    expect(doc.startsWith("﻿")).toBe(true);
  });

  it("separates rows with CRLF, as the format says rather than as this platform does", () => {
    expect(doc).toContain("\r\n");
    expect(doc.split("\r\n")[0]).toBe("﻿Key,Title");
  });

  it("keeps every row the same width, whatever is in the cells", () => {
    const rows = doc
      .replace("﻿", "")
      .trimEnd()
      .split("\r\n")
      /* Splitting on commas outside quotes is how a reader parses it; this is
         the crude version of that, and it is enough to catch a row that has
         gained a column it should not have. */
      .map((row) => row.match(/(".*?"|[^,]*)(,|$)/g)?.length ?? 0);

    expect(new Set(rows).size, `widths: ${rows.join(", ")}`).toBe(1);
  });
});

describe("HTML escaping", () => {
  it("escapes the characters that can end a text node or an attribute", () => {
    expect(escapeHtml(`<script>alert("x")</script>`)).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;",
    );
    expect(escapeHtml("a & b")).toBe("a &amp; b");
    expect(escapeHtml("it's")).toBe("it&#39;s");
  });

  it("escapes the ampersand first, so an escape is not escaped twice", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });
});

describe("an HTML export", () => {
  const doc = htmlDocument(
    "Prio — work items",
    ["Key", "Title"],
    [
      [{ text: "ENG-1" }, { text: `<img src=x onerror="steal()">` }],
      [
        { text: "ENG-2" },
        { text: "shot.png", href: "https://prio.example/api/attachments/abc" },
      ],
    ],
    "2 work items",
  );

  it("is a whole document a browser will open", () => {
    expect(doc.startsWith("<!doctype html>")).toBe(true);
    expect(doc).toContain("<table>");
    expect(doc).toContain("</html>");
  });

  it("renders a title somebody typed as text and never as markup", () => {
    /* The row content is issue titles, labels and filenames that people wrote,
       so this document is assembled from untrusted strings by definition. */
    expect(doc).not.toContain("<img src=x");
    expect(doc).toContain("&lt;img src=x onerror=&quot;steal()&quot;&gt;");
  });

  it("links only the cells that carry a link", () => {
    expect(doc).toContain(
      '<a href="https://prio.example/api/attachments/abc" rel="noreferrer">shot.png</a>',
    );
    /* And the plain cell beside it is not an anchor. */
    expect(doc).toContain("<td>ENG-1</td>");
  });

  it("escapes the caption and the title too", () => {
    const nasty = htmlDocument("</title><script>", ["A"], [[{ text: "x" }]], "&");
    expect(nasty).not.toContain("</title><script>");
    expect(nasty).toContain("&amp;");
  });
});
