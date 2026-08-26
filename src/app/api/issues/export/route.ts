import ExcelJS from "exceljs";
import { NextResponse } from "next/server";
import {
  ISSUE_TYPE_LABEL,
  PRIORITY_LABEL,
  SEVERITY_LABEL,
  STATUS_LABEL,
} from "@/lib/domain";
import { getCurrentUser } from "@/lib/session";
import { listIssuesForExport } from "@/server/queries/issues";
import { parseIssueParams, type SearchParams } from "@/server/queries/params";
import { storage } from "@/server/storage";

/**
 * Excel export of the issue list (§ Export Issues to Excel).
 *
 * A route handler, not a server action: the response body is a binary
 * workbook the browser must download, which a server action cannot return.
 * The same `parseIssueParams` / `buildIssueWhere` the /issues page itself uses
 * turn the query string into rows, so an export always matches whatever the
 * caller was looking at — active filters included, and always scoped to what
 * they are authorized to see.
 *
 * The workbook is never protected or locked: no `worksheet.protect()` call
 * exists anywhere in this file, which is what keeps it a normal, fully
 * editable .xlsx once downloaded.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BRAND_PRIMARY = "FF0593C3";
const HEADER_TEXT = "FFFFFFFF";

const COLUMNS: {
  header: string;
  key: string;
  width: number;
}[] = [
  { header: "Key", key: "key", width: 12 },
  { header: "Project", key: "project", width: 22 },
  { header: "Type", key: "type", width: 10 },
  { header: "Title", key: "title", width: 48 },
  { header: "Status", key: "status", width: 14 },
  { header: "Priority", key: "priority", width: 12 },
  { header: "Severity", key: "severity", width: 12 },
  { header: "Assignee", key: "assignee", width: 22 },
  { header: "Reporter", key: "reporter", width: 22 },
  { header: "Labels", key: "labels", width: 26 },
  { header: "Due Date", key: "dueDate", width: 14 },
  { header: "Created At", key: "createdAt", width: 18 },
  { header: "Updated At", key: "updatedAt", width: 18 },
  { header: "Attachments", key: "attachments", width: 20 },
];

/** Formats `ExcelJS.Image` accepts for an embedded picture. */
const IMAGE_EXTENSION: Record<string, "png" | "jpeg" | "gif"> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/gif": "gif",
};

/**
 * Ceiling on how many issues get an embedded thumbnail. Each one is read off
 * disk and inflated into the workbook in memory, so an unbounded export could
 * turn a few thousand rows into a very slow — or very large — download.
 * Rows beyond the cap still get a text fallback naming their attachment.
 */
const MAX_EMBEDDED_IMAGES = 300;
const THUMB_PX = 72;
/** Excel row height is in points (~0.75px each) — tall enough for THUMB_PX. */
const ROW_HEIGHT_WITH_THUMB = 56;

async function readAttachmentBuffer(storageKey: string): Promise<Buffer> {
  const stream = await storage().read(storageKey);
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function searchParamsFromUrl(url: string): SearchParams {
  const sp = new URL(url).searchParams;
  const params: SearchParams = {};
  for (const key of new Set(sp.keys())) {
    const all = sp.getAll(key);
    params[key] = all.length > 1 ? all : all[0];
  }
  return params;
}

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  let rows: Awaited<ReturnType<typeof listIssuesForExport>>;
  try {
    const filters = parseIssueParams(searchParamsFromUrl(request.url));
    rows = await listIssuesForExport(user, filters);
  } catch (error) {
    console.error("[prio] issue export failed:", error);
    return NextResponse.json(
      { error: "Could not generate the export. Please try again." },
      { status: 500 },
    );
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Prio";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet("Issues", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  sheet.columns = COLUMNS;

  // 0-based column index for image anchors — the "Attachments" column is
  // always last in COLUMNS.
  const attachmentColIndex = COLUMNS.length - 1;
  let embeddedCount = 0;

  for (const row of rows) {
    let image: (typeof row.attachments)[number] | undefined;
    let extension: "png" | "jpeg" | "gif" | undefined;
    for (const attachment of row.attachments) {
      const ext = IMAGE_EXTENSION[attachment.mimeType];
      if (ext) {
        image = attachment;
        extension = ext;
        break;
      }
    }
    const extraCount = image ? row.attachments.length - 1 : row.attachments.length;

    const addedRow = sheet.addRow({
      key: row.key,
      project: `${row.project.key} — ${row.project.name}`,
      type: ISSUE_TYPE_LABEL[row.type],
      title: row.title,
      status: STATUS_LABEL[row.status],
      priority: PRIORITY_LABEL[row.priority],
      severity: row.severity ? SEVERITY_LABEL[row.severity] : "",
      assignee: row.assignee?.name ?? "Unassigned",
      reporter: row.reporter.name,
      labels: row.labels.map((l) => l.label.name).join(", "),
      dueDate: row.dueDate,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      attachments: extraCount > 0 ? `+${extraCount} more` : "",
    });

    if (!image || !extension) continue;

    if (embeddedCount >= MAX_EMBEDDED_IMAGES) {
      // Past the cap: name the file instead of embedding it, rather than
      // silently dropping it from the export.
      addedRow.getCell("attachments").value = image.filename;
      continue;
    }

    try {
      const buffer = await readAttachmentBuffer(image.storageKey);
      // exceljs vendors its own `@types/node`, so its `Buffer` type is a
      // structurally-identical but nominally distinct type from this
      // project's — a real Buffer at runtime, just not one TS will accept
      // without a cast.
      const imageId = workbook.addImage({ buffer, extension } as unknown as ExcelJS.Image);
      sheet.addImage(imageId, {
        tl: { col: attachmentColIndex, row: addedRow.number - 1 },
        ext: { width: THUMB_PX, height: THUMB_PX },
        editAs: "oneCell",
      });
      addedRow.height = ROW_HEIGHT_WITH_THUMB;
      embeddedCount++;
    } catch (error) {
      console.error("[prio] could not embed attachment thumbnail:", error);
      addedRow.getCell("attachments").value = image.filename;
    }
  }

  const headerRow = sheet.getRow(1);
  headerRow.height = 20;
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: HEADER_TEXT } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BRAND_PRIMARY } };
    cell.alignment = { vertical: "middle", horizontal: "left" };
  });

  const lastRow = rows.length + 1;
  sheet.autoFilter = { from: "A1", to: `${sheet.getColumn(COLUMNS.length).letter}${lastRow}` };

  const dateColumn = sheet.getColumn("dueDate");
  dateColumn.numFmt = "yyyy-mm-dd";
  const timestampFormat = "yyyy-mm-dd hh:mm";
  sheet.getColumn("createdAt").numFmt = timestampFormat;
  sheet.getColumn("updatedAt").numFmt = timestampFormat;

  for (let i = 2; i <= lastRow; i++) {
    sheet.getRow(i).eachCell((cell) => {
      cell.alignment = { vertical: "middle", wrapText: false };
    });
  }

  // Deliberately no `sheet.protect(...)` and no per-cell `.protection` lock —
  // the downloaded workbook must open as a completely normal, editable sheet.

  const raw = await workbook.xlsx.writeBuffer();
  const body = new Uint8Array(raw);
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `Prio-Issues-Export-${stamp}.xlsx`;

  return new NextResponse(body, {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(body.byteLength),
      "Cache-Control": "no-store",
    },
  });
}
