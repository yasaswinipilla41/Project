import writeXlsxFile, { type Cell, type Row } from "write-excel-file/node";
import { getEnv } from "@/lib/env";
import { getCurrentUser } from "@/lib/session";
import {
  ISSUE_TYPE_LABEL,
  PRIORITY_LABEL,
  SEVERITY_LABEL,
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
  {
    header: "Severity",
    width: 12,
    value: (r) => (r.severity ? SEVERITY_LABEL[r.severity] : ""),
  },
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
   * The application's public base URL, not the request's.
   *
   * Inside a container the request reports the address the server bound
   * to -- `http://0.0.0.0:3000` -- and a spreadsheet full of links to
   * 0.0.0.0 opens nowhere. `BASE_URL` is what the notification emails and
   * the share links already use for exactly this reason.
   */
  const origin = getEnv().BASE_URL.replace(/[/]+$/, "");

  try {
    const rows = await exportIssues(user, parseIssueParams(params));

    const header: Row = COLUMNS.map((column) => ({
      value: column.header,
      fontWeight: "bold",
    }));

    const body: Row[] = rows.map((row) =>
      COLUMNS.map((column): Cell => {
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
      columns: COLUMNS.map((column) => ({ width: column.width })),
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
