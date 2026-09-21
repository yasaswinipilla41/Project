/**
 * The spreadsheet the importer is waiting for, as an empty one.
 *
 * Somebody importing work for the first time has to guess two things: what the
 * columns are called, and which of them they cannot leave out. Both are
 * already decided — by `server/issueImport`, which matches headers by name —
 * so guessing is unnecessary, and a wrong guess costs a round trip through an
 * error message. This hands them the answer.
 *
 * **The parser is the source of truth.** Every name below is one
 * `issueImport` already recognises, and nothing has been added that it does
 * not: a column this file invented would import as silence, which is worse
 * than not offering it. `templateHeaders` is asserted against the parser's own
 * `HEADERS` in `tests/import-template.test.ts`, so the two cannot drift apart
 * without a test saying so.
 *
 * Headers only, and no example row. A sample would have to carry a real
 * project key, a real member's name and a real label to survive validation —
 * and somebody who filled in the rows around it and imported would file the
 * sample as work. An empty sheet cannot do that.
 */

/** Required by the parser: a row without these is refused. */
export const TEMPLATE_REQUIRED = ["Title", "Project key"] as const;

/** Used when present, ignored when blank. */
export const TEMPLATE_OPTIONAL = [
  "Type",
  "Status",
  "Priority",
  "Assignee",
  "Labels",
  "Due date",
  "Description",
] as const;

/**
 * Every column, required first.
 *
 * Order is the template's own — the parser finds columns by name and does not
 * care — and it puts the two that cannot be left out where they will be seen
 * before the optional ones.
 */
export const TEMPLATE_HEADERS: readonly string[] = [
  ...TEMPLATE_REQUIRED,
  ...TEMPLATE_OPTIONAL,
];

/** What the downloaded file is called. */
export const TEMPLATE_FILENAME = "prio-work-items-template.xlsx";

/**
 * Wide enough to read the header in, and to type an answer under it.
 *
 * Description last and widest, because it is the one that holds a sentence.
 */
const WIDTHS: Record<string, number> = {
  Title: 36,
  "Project key": 14,
  Type: 12,
  Status: 16,
  Priority: 12,
  Assignee: 24,
  Labels: 24,
  "Due date": 14,
  Description: 48,
};

/**
 * The single header row, in the shape `write-excel-file` takes.
 *
 * The return type is written out rather than imported: the package exports
 * its types only from its per-environment entry points (`/browser`,
 * `/node`), and this module is shared by both the dialog and its test.
 */
export function templateRows(): { value: string; fontWeight: "bold" }[][] {
  return [
    TEMPLATE_HEADERS.map((header) => ({
      value: header,
      fontWeight: "bold" as const,
    })),
  ];
}

/** Column widths, in the same order as the headers. */
export function templateColumns(): { width: number }[] {
  return TEMPLATE_HEADERS.map((header) => ({ width: WIDTHS[header] ?? 18 }));
}
