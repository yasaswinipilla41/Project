"use server";

import ExcelJS from "exceljs";
import type { IssueStatus, IssueType, Priority, Severity } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import {
  accessibleProjectIds,
  AuthorizationError,
  NotFoundError,
  ProjectAtCapacityError,
} from "@/lib/authz";
import {
  ISSUE_STATUSES,
  ISSUE_TYPES,
  ISSUE_TYPE_LABEL,
  PRIORITIES,
  PRIORITY_LABEL,
  SEVERITIES,
  SEVERITY_LABEL,
  STATUS_LABEL,
} from "@/lib/domain";
import {
  IMPORT_COLUMNS,
  IMPORT_MAX_BYTES,
  IMPORT_MAX_ROWS,
  TEMPLATE_HEADERS,
} from "@/lib/importTemplate";
import {
  afterIssueCreated,
  checkNewIssue,
  insertIssue,
  revalidateIssueSurfaces,
} from "@/server/issueCreation";
import type { CreateIssueInput } from "@/server/schemas";

/**
 * Bringing work items in from a spreadsheet.
 *
 * The whole point of this module is what it does *not* do: it holds no rules
 * of its own about what a work item may be. Every row is put through
 * `checkNewIssue` — the function `createIssue` decides with — and written by
 * `insertIssue`, the function `createIssue` writes with. An imported work item
 * gets the same authorization, the same project rules, the same key from the
 * same sequence, the same activity entry and the same notifications as one
 * typed in by hand, and a row this calls valid is a row the Create form would
 * have accepted. A second set of rules would agree with the first today and
 * drift from it by the next change to either.
 *
 * Two entry points, and they share everything:
 *
 *  - `validateWorkItemsImport` reads the file and reports on every row.
 *    Writes nothing, ever. The dialog calls it the moment a file is chosen, so
 *    the person learns what is wrong before they are offered a button.
 *  - `importWorkItems` reads the file **again**, validates it **again**, and
 *    only then writes — all rows, in one transaction. It does not trust that
 *    the file it is given is the file that was validated, or that the
 *    validation was ever run: the browser's word that a spreadsheet is clean
 *    is not what stands between it and the database.
 *
 * Two orderings are deliberate:
 *
 *  - **Nothing is created unless every row is valid.** Not "the valid rows":
 *    a spreadsheet with one bad row in the middle costs somebody a correction,
 *    not half an import they then have to unpick.
 *  - **The write is one transaction.** Validation cannot see everything — a
 *    project can fill up, a connection can drop — so when the write itself
 *    fails part-way, the rows already written go with it and the keys they
 *    took are handed back. There is no state in which some of a file exists.
 *
 * The project is never in the file. It is the one the person opened Import
 * from, sent as `projectId` and looked up inside what they may write to, so a
 * spreadsheet cannot file work anywhere the page it was opened on could not.
 */

export interface ImportRowError {
  /** The column the problem is in, where it is one column's. */
  column?: string;
  message: string;
}

/** A row that cannot be imported, and everything wrong with it. */
export interface InvalidRow {
  /** The row as Excel numbers it, so somebody can go and look at it. */
  row: number;
  /** What the row calls itself, so it is recognisable without opening Excel. */
  summary: string;
  errors: ImportRowError[];
}

/** How many invalid rows are described in full; the count is always exact. */
const MAX_REPORTED_ROWS = 100;

export type ImportValidation =
  | { ok: false; error: string }
  | {
      ok: true;
      fileName: string;
      /** Rows with something in them; blank padding is not counted. */
      total: number;
      valid: number;
      invalidCount: number;
      invalid: InvalidRow[];
    };

export type ImportResult =
  | { ok: true; created: number }
  | {
      ok: false;
      error: string;
      /** Set when the refusal is that rows are invalid, so they can be shown. */
      validation?: Extract<ImportValidation, { ok: true }>;
    };

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

/** "Choose one of: Epic, Feature, …", so a wrong word says what a right one is. */
function choicesOf<T extends string>(
  values: readonly T[],
  labels: Record<T, string>,
): string {
  return values.map((value) => labels[value]).join(", ");
}

/** The form field a refusal names, as the column the person sees it in. */
const COLUMN_OF_FIELD: Record<string, string> = {
  title: IMPORT_COLUMNS.summary,
  description: IMPORT_COLUMNS.description,
  type: IMPORT_COLUMNS.issueType,
  status: IMPORT_COLUMNS.status,
  priority: IMPORT_COLUMNS.priority,
  assigneeId: IMPORT_COLUMNS.assignee,
  severity: IMPORT_COLUMNS.severity,
  parentId: IMPORT_COLUMNS.parentIssue,
};

/**
 * The create form's wording, in the spreadsheet's vocabulary.
 *
 * The rules are the form's and so are the messages; only the name of the field
 * differs, because the column is called Summary and the form calls it a title.
 */
function inSpreadsheetWords(message: string): string {
  return message.replace(/\btitle\b/gi, "summary");
}

/** One row that passed, with exactly what `insertIssue` will be given. */
interface ValidRow {
  input: CreateIssueInput;
  status: IssueStatus;
  filesAsTester: boolean;
}

type Prepared =
  | { ok: false; error: string }
  | {
      ok: true;
      fileName: string;
      total: number;
      valid: ValidRow[];
      invalid: InvalidRow[];
    };

/**
 * Reads the file and judges every row. Reads the database; writes nothing.
 *
 * Shared by both actions, which is what makes "what validation said" and "what
 * the import did" the same thing rather than two implementations that agree.
 */
async function prepare(
  formData: FormData,
  user: Awaited<ReturnType<typeof requireUser>>,
): Promise<Prepared> {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "Choose a spreadsheet to import." };
  }
  if (file.size > IMPORT_MAX_BYTES) {
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
  /* A header row with nothing under it is refused further down, after the
     headers themselves — "you are missing Summary" is the more useful thing
     to hear about a file that is also empty. */
  if (!sheet || sheet.rowCount < 1) {
    return { ok: false, error: "That spreadsheet has no rows to import." };
  }

  /*
   * Headers, by name rather than by position, so a spreadsheet with its
   * columns reordered still imports — but only names the template offers.
   *
   * A column this does not know is refused rather than skipped. Skipping is
   * what made the old Title / Project key sheets look like they had worked:
   * a column read as silence is a column somebody thinks was used. Refusing
   * says so, and names what is accepted instead.
   */
  const canonical = new Map(
    TEMPLATE_HEADERS.map((header) => [header.toLowerCase(), header]),
  );
  const columnOf = new Map<string, number>();
  const duplicated = new Set<string>();
  const unknown: string[] = [];

  sheet.getRow(1).eachCell((cell, index) => {
    const name = cellText(cell.value);
    if (name === "") return;

    const known = canonical.get(name.toLowerCase());
    if (!known) {
      unknown.push(name);
    } else if (columnOf.has(known)) {
      duplicated.add(known);
    } else {
      columnOf.set(known, index);
    }
  });

  const headerProblems: string[] = [];
  if (!columnOf.has(IMPORT_COLUMNS.summary)) {
    headerProblems.push(`Missing required column: ${IMPORT_COLUMNS.summary}.`);
  }
  if (duplicated.size > 0) {
    headerProblems.push(
      `Column${duplicated.size === 1 ? "" : "s"} appear${duplicated.size === 1 ? "s" : ""} more than once: ${[...duplicated].join(", ")}.`,
    );
  }
  if (unknown.length > 0) {
    headerProblems.push(
      `Unrecognised column${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`,
    );
  }
  if (headerProblems.length > 0) {
    return {
      ok: false,
      error: `${headerProblems.join(" ")} The columns are ${TEMPLATE_HEADERS.join(", ")} — Download Template has them.`,
    };
  }

  const read = (row: ExcelJS.Row, header: string): string => {
    const index = columnOf.get(header);
    return index === undefined ? "" : cellText(row.getCell(index).value);
  };

  /*
   * The project this import is for.
   *
   * Resolved here rather than trusted: the id arrives from the browser, and
   * the only thing that makes it safe is that it is looked up inside
   * `accessibleProjectIds`. An id for a project the caller cannot reach finds
   * nothing, and the whole import stops.
   */
  const projectId = formData.get("projectId");
  if (typeof projectId !== "string" || projectId === "") {
    return {
      ok: false,
      error: "Choose the project these work items belong to.",
    };
  }
  const allowedIds = await accessibleProjectIds(user);
  const project = allowedIds.includes(projectId)
    ? await prisma.project.findUnique({
        where: { id: projectId },
        select: {
          id: true,
          key: true,
          maxIssues: true,
          members: {
            select: { user: { select: { id: true, name: true, email: true } } },
          },
        },
      })
    : null;
  if (!project) {
    return { ok: false, error: "You cannot add work to that project." };
  }

  /* Rows with something in them. A wholly blank row is spreadsheet padding,
     not an omission, and is neither counted nor reported. */
  const numbers: number[] = [];
  for (let number = 2; number <= sheet.rowCount; number += 1) {
    const row = sheet.getRow(number);
    if (TEMPLATE_HEADERS.some((header) => read(row, header) !== "")) {
      numbers.push(number);
    }
  }
  if (numbers.length === 0) {
    return { ok: false, error: "That spreadsheet has no rows to import." };
  }
  if (numbers.length > IMPORT_MAX_ROWS) {
    return {
      ok: false,
      error: `That spreadsheet has ${numbers.length} rows. Import at most ${IMPORT_MAX_ROWS} at a time.`,
    };
  }

  /* Every parent named anywhere in the file, looked up once. */
  const parentKeys = [
    ...new Set(
      numbers
        .map((number) =>
          read(sheet.getRow(number), IMPORT_COLUMNS.parentIssue).toUpperCase(),
        )
        .filter((key) => key !== ""),
    ),
  ];
  const parents = new Map(
    (
      await prisma.issue.findMany({
        where: { projectId: project.id, key: { in: parentKeys } },
        select: { id: true, key: true },
      })
    ).map((issue) => [issue.key.toUpperCase(), issue.id]),
  );

  const valid: ValidRow[] = [];
  const invalid: InvalidRow[] = [];

  for (const number of numbers) {
    const row = sheet.getRow(number);
    const errors: ImportRowError[] = [];
    const fail = (column: string, message: string) =>
      errors.push({ column, message });

    const summary = read(row, IMPORT_COLUMNS.summary);
    if (summary === "") fail(IMPORT_COLUMNS.summary, "Summary is required.");

    const typeText = read(row, IMPORT_COLUMNS.issueType);
    let type: IssueType = "TASK";
    if (typeText !== "") {
      const found = fromLabel<IssueType>(typeText, ISSUE_TYPES, ISSUE_TYPE_LABEL);
      if (found) type = found;
      else
        fail(
          IMPORT_COLUMNS.issueType,
          `Issue Type "${typeText}" is not valid. Choose one of: ${choicesOf(ISSUE_TYPES, ISSUE_TYPE_LABEL)}.`,
        );
    }

    /* A blank status is New, said outright. Left to `createIssue` it would be
       "the first status this person may file in", which is Backlog for an
       administrator — a different answer from the one the sheet promises. */
    const statusText = read(row, IMPORT_COLUMNS.status);
    let status: IssueStatus = "TODO";
    if (statusText !== "") {
      const found = fromLabel<IssueStatus>(statusText, ISSUE_STATUSES, STATUS_LABEL);
      if (found) status = found;
      else
        fail(
          IMPORT_COLUMNS.status,
          `Status "${statusText}" is not valid. Choose one of: ${choicesOf(ISSUE_STATUSES, STATUS_LABEL)}.`,
        );
    }

    const priorityText = read(row, IMPORT_COLUMNS.priority);
    let priority: Priority | undefined;
    if (priorityText !== "") {
      const found = fromLabel<Priority>(priorityText, PRIORITIES, PRIORITY_LABEL);
      if (found) priority = found;
      else
        fail(
          IMPORT_COLUMNS.priority,
          `Priority "${priorityText}" is not valid. Choose one of: ${choicesOf(PRIORITIES, PRIORITY_LABEL)}.`,
        );
    }

    const severityText = read(row, IMPORT_COLUMNS.severity);
    let severity: Severity | undefined;
    if (severityText !== "") {
      const found = fromLabel<Severity>(severityText, SEVERITIES, SEVERITY_LABEL);
      if (found) severity = found;
      else
        fail(
          IMPORT_COLUMNS.severity,
          `Severity "${severityText}" is not valid. Choose one of: ${choicesOf(SEVERITIES, SEVERITY_LABEL)}.`,
        );
    }

    const assigneeText = read(row, IMPORT_COLUMNS.assignee);
    let assigneeId: string | null = null;
    if (assigneeText !== "") {
      const wanted = assigneeText.toLowerCase();
      const byEmail = project.members.filter(
        (m) => m.user.email.toLowerCase() === wanted,
      );
      const matches =
        byEmail.length > 0
          ? byEmail
          : project.members.filter((m) => m.user.name.toLowerCase() === wanted);
      if (matches.length === 0) {
        fail(
          IMPORT_COLUMNS.assignee,
          `Assignee "${assigneeText}" was not found in ${project.key}.`,
        );
      } else if (matches.length > 1) {
        fail(
          IMPORT_COLUMNS.assignee,
          `Assignee "${assigneeText}" matches more than one member of ${project.key}. Use their email address.`,
        );
      } else {
        assigneeId = matches[0]!.user.id;
      }
    }

    const parentText = read(row, IMPORT_COLUMNS.parentIssue);
    let parentId: string | null = null;
    if (parentText !== "") {
      parentId = parents.get(parentText.toUpperCase()) ?? null;
      if (!parentId) {
        fail(
          IMPORT_COLUMNS.parentIssue,
          `Parent Issue "${parentText}" does not exist in ${project.key}.`,
        );
      }
    }

    /*
     * The rest is not this file's to decide.
     *
     * Run whenever there is a summary to run it on, with whatever resolved —
     * so a row with a bad assignee and a bad priority hears about the
     * permissions problem too, rather than fixing two things and meeting a
     * third. A column already complained about is not complained about twice.
     */
    let checked: ValidRow | null = null;
    if (summary !== "") {
      try {
        const result = await checkNewIssue(user, {
          projectId: project.id,
          type,
          title: summary,
          description: read(row, IMPORT_COLUMNS.description) || null,
          status,
          priority,
          severity,
          assigneeId,
          parentId,
          labelIds: [],
          dueDate: null,
        });

        if (result.ok) {
          checked = {
            input: result.input,
            status: result.status,
            filesAsTester: result.filesAsTester,
          };
        } else if (result.fieldErrors && Object.keys(result.fieldErrors).length > 0) {
          for (const [field, message] of Object.entries(result.fieldErrors)) {
            const column = COLUMN_OF_FIELD[field];
            if (column && errors.some((e) => e.column === column)) continue;
            errors.push({ column, message: inSpreadsheetWords(message) });
          }
        } else {
          errors.push({ message: inSpreadsheetWords(result.error) });
        }
      } catch (error) {
        /* No access, or not a kind of work this person may raise: a fact
           about the row, so it is reported against it. */
        if (error instanceof AuthorizationError || error instanceof NotFoundError) {
          errors.push({ message: error.message });
        } else {
          throw error;
        }
      }
    }

    if (errors.length === 0 && checked) {
      valid.push(checked);
    } else {
      invalid.push({ row: number, summary: summary || "(empty)", errors });
    }
  }

  /*
   * A project with a limit has to hold all of it.
   *
   * `insertIssue` enforces the limit one work item at a time, which would
   * refuse the last few rows of a file and — in a transaction — undo the
   * rest. Said here instead, before anything is attempted, so the answer is
   * "this project has room for 3 more" and not a failure at row 41.
   */
  if (project.maxIssues !== null && invalid.length === 0) {
    const held = await prisma.issue.count({ where: { projectId: project.id } });
    const room = Math.max(0, project.maxIssues - held);
    if (valid.length > room) {
      return {
        ok: false,
        error: `${project.key} has room for ${room} more work item${room === 1 ? "" : "s"} and this spreadsheet has ${valid.length}. Remove ${valid.length - room} row${valid.length - room === 1 ? "" : "s"} or ask an administrator to raise the limit.`,
      };
    }
  }

  return { ok: true, fileName: file.name, total: numbers.length, valid, invalid };
}

function summaryOf(prepared: Extract<Prepared, { ok: true }>) {
  return {
    ok: true as const,
    fileName: prepared.fileName,
    total: prepared.total,
    valid: prepared.valid.length,
    invalidCount: prepared.invalid.length,
    invalid: prepared.invalid.slice(0, MAX_REPORTED_ROWS),
  };
}

/**
 * Judges a spreadsheet without touching anything.
 *
 * What the dialog shows the moment a file is chosen: how many rows there are,
 * how many would import, and for each that would not, which row and why.
 */
export async function validateWorkItemsImport(
  formData: FormData,
): Promise<ImportValidation> {
  const user = await requireUser();
  const prepared = await prepare(formData, user);
  return prepared.ok ? summaryOf(prepared) : prepared;
}

/**
 * Imports a spreadsheet — every row, or none of them.
 *
 * Validates from scratch (see the note at the top of this file), and refuses
 * unless every row is valid. Then writes them all in a single transaction.
 */
export async function importWorkItems(
  formData: FormData,
): Promise<ImportResult> {
  const user = await requireUser();
  const prepared = await prepare(formData, user);

  if (!prepared.ok) return prepared;

  if (prepared.invalid.length > 0) {
    const n = prepared.invalid.length;
    return {
      ok: false,
      error: `Nothing was imported. ${n} row${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} attention.`,
      validation: summaryOf(prepared),
    };
  }

  try {
    /*
     * One transaction for the whole file.
     *
     * Each work item still takes its own key from the project's sequence and
     * writes its own activity and notifications — that is `insertIssue`'s job
     * and it does it once per row — but they commit together or not at all.
     * The default interactive-transaction timeout is five seconds, which a
     * few hundred rows would not fit in, so it is raised.
     */
    const created = await prisma.$transaction(
      async (tx) => {
        const made = [];
        for (const item of prepared.valid) {
          made.push(await insertIssue(tx, user, item.input, item.status));
        }
        return made;
      },
      { timeout: 120_000, maxWait: 10_000 },
    );

    /*
     * What follows a work item being made, as it does for the Create form —
     * today, handing a tester's unclaimed backlog item to a developer. After
     * the transaction, and each one on its own: it is best-effort by design,
     * and a failure there must not undo, or report as failed, work that is
     * already stored.
     */
    for (const [index, issue] of created.entries()) {
      const item = prepared.valid[index]!;
      await afterIssueCreated({
        created: issue,
        input: item.input,
        status: item.status,
        filesAsTester: item.filesAsTester,
        actorId: user.id,
      });
      revalidateIssueSurfaces(issue.project.key, issue.key);
    }

    return { ok: true, created: created.length };
  } catch (error) {
    if (error instanceof ProjectAtCapacityError) {
      return { ok: false, error: `Nothing was imported. ${error.message}` };
    }
    console.error("[prio] work item import failed:", error);
    return {
      ok: false,
      error: "Nothing was imported. Something went wrong — please try again.",
    };
  }
}
