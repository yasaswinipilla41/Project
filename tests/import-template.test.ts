import { describe, expect, it } from "vitest";
import {
  TEMPLATE_FILENAME,
  TEMPLATE_HEADERS,
  TEMPLATE_OPTIONAL,
  TEMPLATE_REQUIRED,
  templateColumns,
  templateRows,
} from "@/lib/importTemplate";

/**
 * The template offers exactly what the importer accepts.
 *
 * A template is a promise about another piece of code: download this, fill it
 * in, and the import will understand it. The way that promise breaks is
 * quiet — a column renamed in the parser, or one invented here that the
 * parser ignores — and it breaks for the person who has already typed two
 * hundred rows into it.
 *
 * So the parser's own header list is the assertion. `src/server/issueImport`
 * is `"use server"` and cannot be imported here, so the names are restated
 * below exactly as that file declares them; if either side moves, these fail.
 */

/** `HEADERS` in `src/server/issueImport.ts`, verbatim. */
const PARSER_HEADERS = {
  title: "Title",
  description: "Description",
  type: "Type",
  projectKey: "Project key",
  status: "Status",
  priority: "Priority",
  assignee: "Assignee",
  labels: "Labels",
  dueDate: "Due date",
} as const;

/** `REQUIRED_HEADERS` in the same file, verbatim. */
const PARSER_REQUIRED = [PARSER_HEADERS.title, PARSER_HEADERS.projectKey];

describe("the import template's columns", () => {
  it("offers every column the parser reads, and no others", () => {
    expect([...TEMPLATE_HEADERS].sort()).toEqual(
      Object.values(PARSER_HEADERS).sort(),
    );
  });

  it("marks as required exactly what the parser refuses a row without", () => {
    expect([...TEMPLATE_REQUIRED].sort()).toEqual([...PARSER_REQUIRED].sort());
  });

  it("puts the required columns first, where they will be seen", () => {
    expect(TEMPLATE_HEADERS.slice(0, TEMPLATE_REQUIRED.length)).toEqual([
      ...TEMPLATE_REQUIRED,
    ]);
  });

  it("keeps required and optional disjoint, and covers everything between them", () => {
    for (const header of TEMPLATE_OPTIONAL) {
      expect(TEMPLATE_REQUIRED as readonly string[]).not.toContain(header);
    }
    expect(TEMPLATE_REQUIRED.length + TEMPLATE_OPTIONAL.length).toBe(
      TEMPLATE_HEADERS.length,
    );
  });

  it("names no column twice", () => {
    expect(new Set(TEMPLATE_HEADERS).size).toBe(TEMPLATE_HEADERS.length);
  });
});

describe("the sheet it writes", () => {
  it("is one header row and nothing else", () => {
    const rows = templateRows();
    /* Header-only on purpose: a sample row would need a real project key, a
       real member and a real label to survive validation, and somebody who
       filled in the rows around it would import the sample as work. */
    expect(rows).toHaveLength(1);
    expect(rows[0]!.map((cell) => cell.value)).toEqual([...TEMPLATE_HEADERS]);
  });

  it("writes the headers in bold, so they read as headings", () => {
    for (const cell of templateRows()[0]!) {
      expect(cell.fontWeight).toBe("bold");
    }
  });

  it("gives every column a width", () => {
    const widths = templateColumns();
    expect(widths).toHaveLength(TEMPLATE_HEADERS.length);
    for (const column of widths) expect(column.width).toBeGreaterThan(0);
  });

  it("is named as a spreadsheet the import will accept", () => {
    /* The parser refuses anything that is not `.xlsx`. */
    expect(TEMPLATE_FILENAME).toMatch(/\.xlsx$/);
  });
});
