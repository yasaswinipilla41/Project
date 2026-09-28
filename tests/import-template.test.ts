import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import {
  IMPORT_COLUMNS,
  TEMPLATE_FILENAME,
  TEMPLATE_HEADERS,
  TEMPLATE_OPTIONAL,
  TEMPLATE_REQUIRED,
  TEMPLATE_SHEET,
} from "@/lib/importTemplate";
import { importTemplateWorkbook } from "@/server/importTemplateFile";

/**
 * The template offers exactly what the importer accepts, and exactly what the
 * feature was specified with.
 *
 * A template is a promise about another piece of code: download this, fill it
 * in, and the import will understand it. The way that promise breaks is
 * quiet — a column renamed in the parser, or one invented here that the
 * parser ignores — and it breaks for the person who has already typed two
 * hundred rows into it.
 *
 * `lib/importTemplate` is the one list both sides read, so drift between them
 * is not possible. What these tests hold is the list itself: it is the eight
 * columns that were asked for, in the order they were asked for.
 */

const EXACTLY = [
  "Summary",
  "Description",
  "Issue Type",
  "Status",
  "Priority",
  "Assignee",
  "Severity",
  "Parent Issue",
];

describe("the import template's columns", () => {
  it("is exactly the eight columns, in order", () => {
    expect([...TEMPLATE_HEADERS]).toEqual(EXACTLY);
  });

  it("has none of the columns it replaced", () => {
    for (const gone of ["Title", "Project key", "Type", "Labels", "Due date"]) {
      expect(TEMPLATE_HEADERS).not.toContain(gone);
    }
  });

  it("requires only the Summary", () => {
    expect([...TEMPLATE_REQUIRED]).toEqual([IMPORT_COLUMNS.summary]);
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

describe("the workbook it writes", () => {
  async function open() {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      (await importTemplateWorkbook()) as unknown as ExcelJS.Buffer,
    );
    return workbook.worksheets[0]!;
  }

  it("has one sheet, named as it always was", async () => {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      (await importTemplateWorkbook()) as unknown as ExcelJS.Buffer,
    );
    expect(workbook.worksheets).toHaveLength(1);
    expect(workbook.worksheets[0]!.name).toBe(TEMPLATE_SHEET);
    expect(TEMPLATE_FILENAME).toBe("prio-work-items-template.xlsx");
  });

  it("is one bold header row and nothing else", async () => {
    const sheet = await open();
    /* Header-only on purpose: a sample row would need a real member and a
       real parent to survive validation, and somebody who filled in the rows
       around it would import the sample as work. */
    const header = sheet.getRow(1);
    expect(
      TEMPLATE_HEADERS.map((_, index) => String(header.getCell(index + 1).value)),
    ).toEqual(EXACTLY);
    expect(header.getCell(1).font?.bold).toBe(true);
    expect(header.getCell(9).value).toBeNull();
    expect(sheet.getRow(2).hasValues).toBe(false);
    expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
  });

  it("gives every column room to read and type in", async () => {
    const sheet = await open();
    for (let column = 1; column <= EXACTLY.length; column += 1) {
      expect(sheet.getColumn(column).width).toBeGreaterThanOrEqual(12);
    }
  });

  it("offers drop-downs where the answers are a fixed set", async () => {
    const sheet = await open();
    const list = (header: string) => {
      const column = EXACTLY.indexOf(header) + 1;
      const validation = sheet.getCell(2, column).dataValidation;
      expect(validation?.type, `${header} has a drop-down`).toBe("list");
      return String(validation!.formulae![0]).replace(/^"|"$/g, "").split(",");
    };

    expect(list("Issue Type")).toEqual(["Epic", "Feature", "Story", "Task", "Bug"]);
    expect(list("Priority")).toEqual(["P0 (Urgent)", "P1", "P2", "P3"]);
    expect(list("Severity")).toEqual(["Critical", "Major", "Minor", "Trivial"]);

    /* New leads the status list: it is what a blank cell means. */
    const statuses = list("Status");
    expect(statuses[0]).toBe("New");
    expect(statuses).toEqual(
      expect.arrayContaining(["Backlog", "In Progress", "Done", "Cancelled"]),
    );
  });

  it("reaches the last row an import will read, and no column that is free text", async () => {
    const sheet = await open();
    const status = EXACTLY.indexOf("Status") + 1;
    expect(sheet.getCell(501, status).dataValidation?.type).toBe("list");
    for (const free of ["Summary", "Description", "Assignee", "Parent Issue"]) {
      expect(sheet.getCell(2, EXACTLY.indexOf(free) + 1).dataValidation).toBeUndefined();
    }
  });

  it("says on the Status header what a blank means", async () => {
    const sheet = await open();
    const note = sheet.getCell(1, EXACTLY.indexOf("Status") + 1).note;
    expect(JSON.stringify(note)).toMatch(/blank for New/);
  });
});
