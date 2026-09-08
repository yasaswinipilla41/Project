import writeXlsxFile, { type Cell, type Row } from "write-excel-file/node";
import { publicBaseUrl } from "@/lib/env";
import { getCurrentUser } from "@/lib/session";
import {
  ISSUE_TYPE_LABEL,
  PRIORITY_LABEL,
  STATUS_LABEL,
} from "@/lib/domain";
import { exportIssues, EXPORT_LIMIT } from "@/server/queries/issues";
import { parseIssueParams, type SearchParams } from "@/server/queries/params";
import type { IssueExportRow } from "@/server/queries/issues";

/**
 * Issue sheet → Excel.
 *
 * A route handler rather than a server action, because the browser needs a
 * real response with `Content-Disposition` to save a file; a server action
 * can only return data for JavaScript to deal with.
 *
 * Two things make this safe to expose:
 *
 *   1. **The caller is resolved server-side.** Nothing about identity comes
 *      from the request body or query string.
 *   2. **The rows come from `exportIssues`, which builds its `where` with the
 *      same `buildIssueWhere` the on-screen list uses** — project scope
 *      included. The query string can only ever *narrow* the result, never
 *      widen it, so asking for a project you cannot see returns nothing
 *      rather than someone else's issues.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Column {
  header: string;
  width: number;
  /** `origin` is the application's public base URL, so links resolve. */
  value: (row: IssueExportRow, origin: string) => string | number | Date | null;
  format?: string;
  /**
   * Builds the cell outright, for the few that are more than a plain value —
   * today, the attachment links, which have to be hyperlinks rather than text.
   * When present it replaces `value` entirely.
   */
  cell?: (row: IssueExportRow, origin: string) => Cell;
}

/**
 * The URL for one attachment, with its filename on the end.
 *
 * The id alone identifies the file and `/api/attachments/<id>` still resolves
 * to it; the trailing name exists so the link ends in a real extension. Excel
 * probes a link that ends in an opaque id as though it might be a document
 * library, and reports "Cannot download the information you requested" when
 * that probe fails — a link ending in `Capture001.png` is handed to the
 * browser as the file download it is, and the browser has a name to save it
 * under.
 *
 * Encoded per segment, so a space or a `#` in somebody's filename cannot break
 * the URL or add a fragment to it.
 */
function attachmentUrl(
  origin: string,
  file: { id: string; filename: string },
): string {
  return `${origin}/api/attachments/${file.id}/${encodeURIComponent(file.filename)}`;
}

/** An Excel string literal: the only character that can break out is a quote. */
function quoted(text: string): string {
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * How many attachments get a clickable column of their own.
 *
 * One cell holds one link, so "each file individually clickable" means one
 * column per file. The sheet only goes as wide as the export actually needs —
 * two columns for a set of issues carrying two files each — and this is the
 * ceiling for the rare issue with a long tail of screenshots. Nothing is lost
 * past it: `Attachment files` and `Attachment links` still list every file and
 * every URL in full.
 */
const MAX_LINK_COLUMNS = 10;

/**
 * `Attachment 1 … n`, each the filename, each clickable.
 *
 * `write-excel-file` has no hyperlink API — it writes values, and the one
 * escape hatch it offers is `type: "Formula"`. So the link is a `HYPERLINK()`
 * formula, which Excel, LibreOffice and Google Sheets all render as an
 * ordinary blue clickable filename. Nobody has to write a formula or convert
 * anything; the export writes it, the reader clicks it.
 *
 * Switching libraries to get a relationship-backed hyperlink would mean
 * rewriting every column, its widths and its date formats, which is a great
 * deal of risk for a link that already opens.
 */
function attachmentLinkColumns(count: number): Column[] {
  return Array.from({ length: count }, (_, index) => ({
    header: `Attachment ${index + 1}`,
    width: 34,
    value: () => null,
    cell: (row: IssueExportRow, origin: string): Cell => {
      const file = row.attachments[index];
      if (!file) return { type: String, value: "" };

      const url = attachmentUrl(origin, file);
      return {
        type: "Formula",
        /* No leading "=": the OOXML `<f>` element holds the formula without
           it, and writing one in produces a workbook Excel offers to repair.
           Verified by generating a sheet and reading its XML. */
        value: `HYPERLINK(${quoted(url)},${quoted(file.filename)})`,
        // Excel's own link styling, so it reads as a link before it is clicked.
        textColor: "#0563C1",
        textDecoration: { underline: true },
      };
    },
  }));
}

/*
 * An issue's attachments, spread across three columns rather than crammed into
 * one.
 *
 * A single cell holding "two files" would lose the names, and one holding a
 * blob of names and URLs together is not something a reader can sort, filter
 * or click. So the count is a number Excel can total, the names are text, and
 * the links are the same authorized `/api/attachments/<id>` URLs the
 * application itself serves -- absolute, because a relative path in a
 * spreadsheet points nowhere.
 *
 * Multiple attachments are newline-separated within their cell, which keeps
 * every filename and every link present and lines them up row for row between
 * the two columns. An issue with no attachments gets 0 and two empty cells.
 */
const ATTACHMENT_COLUMNS: Column[] = [
  {
    header: "Attachments",
    width: 12,
    value: (r) => r.attachments.length,
  },
  {
    header: "Attachment files",
    width: 40,
    value: (r) => r.attachments.map((a) => a.filename).join("\n"),
  },
  {
    header: "Attachment links",
    width: 52,
    value: (r, origin) =>
      r.attachments.map((a) => `${origin}/api/attachments/${a.id}`).join("\n"),
  },
];

/** Only fields the Issue model actually carries — nothing derived or invented. */
const COLUMNS: Column[] = [
  { header: "Key", width: 14, value: (r) => r.key },
  { header: "Title", width: 60, value: (r) => r.title },
  { header: "Type", width: 12, value: (r) => ISSUE_TYPE_LABEL[r.type] },
  { header: "Project", width: 22, value: (r) => r.project.name },
  { header: "Project key", width: 14, value: (r) => r.project.key },
  { header: "Status", width: 16, value: (r) => STATUS_LABEL[r.status] },
  { header: "Priority", width: 12, value: (r) => PRIORITY_LABEL[r.priority] },
  { header: "Assignee", width: 22, value: (r) => r.assignee?.name ?? "" },
  { header: "Reporter", width: 22, value: (r) => r.reporter.name },
  {
    header: "Labels",
    width: 28,
    value: (r) => r.labels.map((l) => l.label.name).join(", "),
  },
  { header: "Parent", width: 14, value: (r) => r.parent?.key ?? "" },
  { header: "Sub-issues", width: 12, value: (r) => r._count.children },
  { header: "Comments", width: 12, value: (r) => r._count.comments },
  ...ATTACHMENT_COLUMNS,
  {
    header: "Due date",
    width: 14,
    value: (r) => r.dueDate,
    format: "yyyy-mm-dd",
  },
  {
    header: "Created",
    width: 18,
    value: (r) => r.createdAt,
    format: "yyyy-mm-dd hh:mm",
  },
  {
    header: "Updated",
    width: 18,
    value: (r) => r.updatedAt,
    format: "yyyy-mm-dd hh:mm",
  },
  { header: "Issue ID", width: 28, value: (r) => r.id },
];

/** `yyyy-mm-dd`, for the filename — never the user's locale. */
function stamp(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ error: "Not signed in." }, { status: 401 });
  }

  const url = new URL(request.url);
  const params: SearchParams = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    params[key] = values.length > 1 ? values : values[0];
  }

  /*
   * The application's public base URL, never the request's -- inside a
   * container the request reports the address the server bound to
   * (`0.0.0.0:3000`), and `Host` is caller-controlled. See `publicBaseUrl`
   * for why it does not fall back to localhost.
   */
  const origin = publicBaseUrl();

  try {
    const rows = await exportIssues(user, parseIssueParams(params));

    /*
     * One clickable column per attachment, as wide as this export actually
     * needs and no wider: a set of issues with nothing attached grows no extra
     * columns at all.
     */
    const linkColumns = Math.min(
      MAX_LINK_COLUMNS,
      rows.reduce((most, row) => Math.max(most, row.attachments.length), 0),
    );
    const columns = [...COLUMNS, ...attachmentLinkColumns(linkColumns)];

    const header: Row = columns.map((column) => ({
      value: column.header,
      fontWeight: "bold",
    }));

    const body: Row[] = rows.map((row) =>
      columns.map((column): Cell => {
        if (column.cell) return column.cell(row, origin);

        const value = column.value(row, origin);
        // A typed cell, so Excel sorts and filters dates and counts as dates
        // and numbers rather than as text that merely looks like them.
        if (value instanceof Date) {
          return { type: Date, value, format: column.format };
        }
        if (typeof value === "number") {
          return { type: Number, value };
        }
        const text = value ?? "";
        // Several attachments share one cell, so it has to be allowed to
        // wrap or Excel shows only the first line.
        return { type: String, value: text, wrap: text.includes("\n") };
      }),
    );

    const file = writeXlsxFile([header, ...body], {
      columns: columns.map((column) => ({ width: column.width })),
      sheet: "Issues",
    });
    const buffer = await file.toBuffer();

    const filename = `prio-issues-${stamp(new Date())}.xlsx`;

    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        // The sheet reflects a moment in a live list; never let a proxy or the
        // browser hand back yesterday's export.
        "Cache-Control": "no-store",
        "X-Prio-Export-Rows": String(rows.length),
        "X-Prio-Export-Limit": String(EXPORT_LIMIT),
      },
    });
  } catch (error) {
    console.error("[prio] issue export failed:", error);
    return Response.json(
      { error: "Could not generate the export." },
      { status: 500 },
    );
  }
}
