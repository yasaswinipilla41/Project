"use server";

import ExcelJS from "exceljs";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { accessibleProjectIds } from "@/lib/authz";
import {
  ISSUE_STATUSES,
  ISSUE_TYPES,
  ISSUE_TYPE_LABEL,
  PRIORITIES,
  PRIORITY_LABEL,
  STATUS_LABEL,
} from "@/lib/domain";
import type { IssueStatus, IssueType, Priority } from "@prisma/client";
import { createIssue } from "@/server/issues";

/**
 * Bringing work items in from a spreadsheet.
 *
 * The whole point of this module is what it does *not* do: it never writes an
 * issue. Every row that survives validation is handed to `createIssue`, the
 * same action the Create form calls, so an imported work item gets the same
 * authorization, the same project rules, the same key from the same sequence,
 * the same activity entry and the same notifications as one typed in by hand.
 * A second creation path would agree with that one today and drift from it by
 * the next change to either.
 *
 * Two orderings matter and are deliberate:
 *
 *  - **Everything is validated before anything is created.** A spreadsheet
 *    with a bad row in the middle should cost somebody a correction, not half
 *    an import they then have to unpick. Nothing is written until every row
 *    has been read, resolved and accepted.
 *  - **Nothing is resolved from the file that the reader could not already
 *    reach.** Projects, assignees and labels are looked up inside what this
 *    person can see, so a spreadsheet naming another project's key imports
 *    nothing and says so.
 *
 * The header names match the export in `api/issues/export`, so the round trip
 * somebody actually wants — export, edit in Excel, import — needs no
 * rearranging of columns.
 */

/** What a spreadsheet may carry, matching the export's own header names. */
const HEADERS = {
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

/** The only two a row cannot do without. */
const REQUIRED_HEADERS = [HEADERS.title, HEADERS.projectKey] as const;

/** Spreadsheets arrive from people, so this is a ceiling rather than a limit. */
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 500;

export interface ImportProblem {
  /** The row as Excel numbers it, so somebody can go and look at it. */
  row: number;
  column?: string;
  message: string;
}

export type ImportResult =
  | { ok: true; created: number }
  | { ok: false; error: string; problems?: ImportProblem[] };

/** Cell text, with the shapes ExcelJS hands back for a formula or a link. */
function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();

  if (typeof value === "object") {
    /*
     * A formula cell carries both the formula and its last cached result. The
     * result is taken and the formula is ignored — nothing here evaluates
     * anything a spreadsheet asked for, which is the only safe reading of a
     * file somebody else wrote.
     */
    if ("result" in value && value.result !== undefined) {
      return cellText(value.result as ExcelJS.CellValue);
    }
    if ("text" in value && typeof value.text === "string") {
      return value.text.trim();
    }
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text).join("").trim();
    }
    if ("hyperlink" in value && typeof value.hyperlink === "string") {
      return "";
    }
  }
  return "";
}

/** Matches a label back to its enum value, accepting either spelling. */
function fromLabel<T extends string>(
  text: string,
  values: readonly T[],
  labels: Record<T, string>,
): T | null {
  const wanted = text.trim().toLowerCase();
  if (wanted === "") return null;
  return (
    values.find(
      (value) =>
        value.toLowerCase() === wanted ||
        labels[value].toLowerCase() === wanted,
    ) ?? null
  );
}

function parseDate(text: string): string | null | "invalid" {
  if (text === "") return null;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return "invalid";
  return parsed.toISOString();
}

/** One row, resolved into what `createIssue` expects. */
interface PreparedRow {
  row: number;
  projectId: string;
  title: string;
  description: string | null;
  type: IssueType;
  status: IssueStatus | undefined;
  priority: Priority | undefined;
  assigneeId: string | null;
  labelIds: string[];
  dueDate: string | null;
}

export async function importWorkItems(
  formData: FormData,
): Promise<ImportResult> {
  const user = await requireUser();

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "Choose a spreadsheet to import." };
  }
  if (file.size > MAX_BYTES) {
    return {
      ok: false,
      error: "That file is larger than 5 MB. Split it and import in parts.",
    };
  }
  if (!/\.xlsx$/i.test(file.name)) {
    return {
      ok: false,
      error: "Import expects an .xlsx spreadsheet — the format Export produces.",
    };
  }

  const workbook = new ExcelJS.Workbook();
  try {
    /* The extension is a claim; this is the check. A file that is not a
       workbook fails here rather than part-way through a read. */
    await workbook.xlsx.load(await file.arrayBuffer());
  } catch {
    return {
      ok: false,
      error: "That file could not be read as a spreadsheet.",
    };
  }

  const sheet = workbook.worksheets[0];
  if (!sheet || sheet.rowCount < 2) {
    return { ok: false, error: "That spreadsheet has no rows to import." };
  }

  /* Headers, by name rather than by position, so a spreadsheet with extra or
     reordered columns still imports. */
  const headerRow = sheet.getRow(1);
  const columnOf = new Map<string, number>();
  headerRow.eachCell((cell, index) => {
    const name = cellText(cell.value);
    if (name !== "") columnOf.set(name.toLowerCase(), index);
  });

  const missing = REQUIRED_HEADERS.filter(
    (header) => !columnOf.has(header.toLowerCase()),
  );
  if (missing.length > 0) {
    return {
      ok: false,
      error: `Missing required column${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`,
    };
  }

  const read = (row: ExcelJS.Row, header: string): string => {
    const index = columnOf.get(header.toLowerCase());
    return index === undefined ? "" : cellText(row.getCell(index).value);
  };

  /* Everything this person may write into, loaded once. A key naming anything
     else is not resolved and the row is refused. */
  const allowedIds = await accessibleProjectIds(user);
  const projects = await prisma.project.findMany({
    where: { id: { in: allowedIds }, isArchived: false },
    select: {
      id: true,
      key: true,
      labels: { select: { id: true, name: true } },
      members: { select: { user: { select: { id: true, name: true, email: true } } } },
    },
  });
  const projectByKey = new Map(projects.map((p) => [p.key.toUpperCase(), p]));

  const problems: ImportProblem[] = [];
  const prepared: PreparedRow[] = [];

  for (let number = 2; number <= sheet.rowCount; number += 1) {
    const row = sheet.getRow(number);
    const title = read(row, HEADERS.title);
    const projectKey = read(row, HEADERS.projectKey).toUpperCase();

    /* A wholly empty row is spreadsheet padding, not an omission. */
    if (title === "" && projectKey === "") continue;

    if (prepared.length >= MAX_ROWS) {
      problems.push({
        row: number,
        message: `More than ${MAX_ROWS} rows — import in smaller batches.`,
      });
      break;
    }

    if (title === "") {
      problems.push({ row: number, column: HEADERS.title, message: "Title is required." });
      continue;
    }

    const project = projectByKey.get(projectKey);
    if (!project) {
      problems.push({
        row: number,
        column: HEADERS.projectKey,
        message:
          projectKey === ""
            ? "Project key is required."
            : `No project "${projectKey}" you can add work to.`,
      });
      continue;
    }

    const typeText = read(row, HEADERS.type);
    const type =
      typeText === ""
        ? "TASK"
        : fromLabel<IssueType>(typeText, ISSUE_TYPES, ISSUE_TYPE_LABEL);
    if (!type) {
      problems.push({ row: number, column: HEADERS.type, message: `Unknown type "${typeText}".` });
      continue;
    }

    const statusText = read(row, HEADERS.status);
    const status =
      statusText === ""
        ? undefined
        : (fromLabel<IssueStatus>(statusText, ISSUE_STATUSES, STATUS_LABEL) ?? "invalid");
    if (status === "invalid") {
      problems.push({ row: number, column: HEADERS.status, message: `Unknown status "${statusText}".` });
      continue;
    }

    const priorityText = read(row, HEADERS.priority);
    const priority =
      priorityText === ""
        ? undefined
        : (fromLabel<Priority>(priorityText, PRIORITIES, PRIORITY_LABEL) ?? "invalid");
    if (priority === "invalid") {
      problems.push({
        row: number,
        column: HEADERS.priority,
        message: `Unknown priority "${priorityText}".`,
      });
      continue;
    }

    const assigneeText = read(row, HEADERS.assignee);
    let assigneeId: string | null = null;
    if (assigneeText !== "") {
      const wanted = assigneeText.toLowerCase();
      const match = project.members.find(
        (m) =>
          m.user.email.toLowerCase() === wanted ||
          m.user.name.toLowerCase() === wanted,
      );
      if (!match) {
        problems.push({
          row: number,
          column: HEADERS.assignee,
          message: `"${assigneeText}" is not a member of ${project.key}.`,
        });
        continue;
      }
      assigneeId = match.user.id;
    }

    const labelsText = read(row, HEADERS.labels);
    const labelIds: string[] = [];
    let labelProblem: string | null = null;
    for (const name of labelsText.split(",").map((l) => l.trim()).filter(Boolean)) {
      const label = project.labels.find(
        (l) => l.name.toLowerCase() === name.toLowerCase(),
      );
      if (!label) {
        labelProblem = `${project.key} has no label "${name}".`;
        break;
      }
      labelIds.push(label.id);
    }
    if (labelProblem) {
      problems.push({ row: number, column: HEADERS.labels, message: labelProblem });
      continue;
    }

    const due = parseDate(read(row, HEADERS.dueDate));
    if (due === "invalid") {
      problems.push({
        row: number,
        column: HEADERS.dueDate,
        message: "Due date is not a date.",
      });
      continue;
    }

    const description = read(row, HEADERS.description);

    prepared.push({
      row: number,
      projectId: project.id,
      title,
      description: description === "" ? null : description,
      type,
      status: status as IssueStatus | undefined,
      priority: priority as Priority | undefined,
      assigneeId,
      labelIds,
      dueDate: due,
    });
  }

  if (problems.length > 0) {
    return {
      ok: false,
      error: `Nothing was imported. ${problems.length} row${problems.length === 1 ? "" : "s"} need${problems.length === 1 ? "s" : ""} correcting.`,
      problems: problems.slice(0, 50),
    };
  }

  if (prepared.length === 0) {
    return { ok: false, error: "That spreadsheet has no rows to import." };
  }

  /*
   * Created one at a time, through the ordinary action.
   *
   * Not a bulk insert: each work item needs its own key from the project's
   * sequence, its own activity entry and its own notifications, and
   * `createIssue` is where all of that lives. It also re-checks every rule
   * against the signed-in user, so the validation above is a courtesy that
   * produces good messages rather than the thing standing between a
   * spreadsheet and the database.
   */
  const failures: ImportProblem[] = [];
  let created = 0;

  for (const item of prepared) {
    const result = await createIssue({
      projectId: item.projectId,
      type: item.type,
      title: item.title,
      description: item.description,
      status: item.status,
      priority: item.priority,
      assigneeId: item.assigneeId,
      labelIds: item.labelIds,
      dueDate: item.dueDate,
    });

    if (result.ok) {
      created += 1;
    } else {
      failures.push({ row: item.row, message: result.error });
    }
  }

  if (failures.length > 0) {
    return {
      ok: false,
      error:
        created === 0
          ? "Nothing could be imported."
          : `${created} imported; ${failures.length} refused.`,
      problems: failures.slice(0, 50),
    };
  }

  return { ok: true, created };
}
