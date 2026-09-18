/**
 * The two text formats the issue export can produce.
 *
 * Kept away from the route and away from the database so they can be tested
 * for what actually goes wrong with them — a title containing a comma, a
 * description containing a quote, an attachment list containing newlines, a
 * label somebody named `<script>`. Those are string problems, and a string
 * problem should be provable without a workbook, a session or a server.
 *
 * Both writers take the same shape the Excel export already assembles: one
 * header row and one array of cells per issue. Nothing here decides *what* to
 * export; that stays with the columns the spreadsheet already agreed on, so
 * the three formats cannot drift apart.
 */

/** A cell that may also be a link, which HTML can honour and CSV cannot. */
export interface ExportCell {
  text: string;
  href?: string;
}

/**
 * One CSV field, escaped to RFC 4180.
 *
 * A field is quoted when it holds a comma, a quote or a line break, and the
 * quotes inside it are doubled. Naive joining is what makes an export that
 * looks right until somebody writes "Login fails, intermittently" in a title
 * and every column after it shifts by one for that row alone.
 *
 * A leading `=`, `+`, `-` or `@` is prefixed with a single quote as well.
 * Excel treats such a field as a formula when the file is opened, so a title
 * somebody typed can otherwise run as code on a colleague's machine — the
 * import side refuses to evaluate formulas for the same reason, and the export
 * side should not be the one writing them.
 */
export function csvField(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(guarded)
    ? `"${guarded.replace(/"/g, '""')}"`
    : guarded;
}

/**
 * A whole CSV document.
 *
 * CRLF line endings, as the format specifies rather than as this platform
 * happens to use, and a byte order mark in front: without one Excel reads a
 * UTF-8 file as the system code page, so a name with an accent in it arrives
 * mangled on exactly the machines this export is for.
 */
export function csvDocument(rows: readonly (readonly string[])[]): string {
  const body = rows
    .map((row) => row.map(csvField).join(","))
    .join("\r\n");
  return `﻿${body}\r\n`;
}

/** The five characters that can end an HTML text node or attribute early. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * A standalone HTML table of the same rows.
 *
 * For reading and printing rather than for re-importing: one file that opens
 * in any browser with no spreadsheet application at all, which is what gets
 * attached to a mail asking somebody outside the team to look at a list.
 *
 * Every value is escaped, including the ones that become link text and link
 * targets. The rows are issue titles, labels and filenames that people typed,
 * so this document is assembled from untrusted strings by definition — and a
 * link is only written when the cell genuinely carries one, so a `javascript:`
 * URL cannot arrive through a text column.
 */
export function htmlDocument(
  title: string,
  headers: readonly string[],
  rows: readonly (readonly ExportCell[])[],
  caption: string,
): string {
  const head = headers
    .map((header) => `<th scope="col">${escapeHtml(header)}</th>`)
    .join("");

  const body = rows
    .map((row) => {
      const cells = row
        .map((cell) => `<td>${cellHtml(cell)}</td>`)
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 24px; font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p.caption { margin: 0 0 16px; color: #667085; font-size: 12px; }
  div.scroll { overflow-x: auto; }
  table { border-collapse: collapse; font-size: 12px; }
  th, td { border: 1px solid #d0d5dd; padding: 6px 10px; text-align: left; vertical-align: top; white-space: pre-wrap; }
  th { background: #f9fafb; font-weight: 600; position: sticky; top: 0; }
  tbody tr:nth-child(even) td { background: #fcfcfd; }
  a { color: #2563eb; }
  @media (prefers-color-scheme: dark) {
    body { background: #101828; color: #e4e7ec; }
    th, td { border-color: #344054; }
    th { background: #1d2939; }
    tbody tr:nth-child(even) td { background: #16202e; }
    p.caption { color: #98a2b3; }
    a { color: #84adff; }
  }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<p class="caption">${escapeHtml(caption)}</p>
<div class="scroll">
<table>
<thead><tr>${head}</tr></thead>
<tbody>
${body}
</tbody>
</table>
</div>
</body>
</html>
`;
}

/** A cell's inner HTML: a link only where the column produced a real one. */
function cellHtml(cell: ExportCell): string {
  if (!cell.href) return escapeHtml(cell.text);
  return `<a href="${escapeHtml(cell.href)}" rel="noreferrer">${escapeHtml(
    cell.text || cell.href,
  )}</a>`;
}
