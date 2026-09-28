import ExcelJS from "exceljs";
import {
  IMPORT_MAX_ROWS,
  TEMPLATE_CHOICES,
  TEMPLATE_HEADERS,
  TEMPLATE_NOTES,
  TEMPLATE_SHEET,
  TEMPLATE_WIDTHS,
} from "@/lib/importTemplate";

/**
 * The empty spreadsheet the importer is waiting for, as bytes.
 *
 * Written on the server with ExcelJS — the library the importer reads uploads
 * with — because it is the one the project already has that can put a real
 * drop-down in a cell. The earlier version of this file was written in the
 * browser, which was fine for a row of headers and has no way to say "Status
 * is one of these".
 *
 * What it keeps from that version: one bold header row, the same widths, the
 * worksheet named "Work items", and no example row (see `lib/importTemplate`
 * for why). What it adds: a frozen header, a note on each header saying what
 * the column takes, and drop-downs for the four columns that have a fixed set
 * of answers — applied down to the last row an import will read.
 *
 * The drop-downs are a convenience and not a control. A spreadsheet
 * application can be told to ignore them and a file can be written without
 * one, so the importer validates every value again regardless.
 */
export async function importTemplateWorkbook(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(TEMPLATE_SHEET, {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  sheet.columns = TEMPLATE_HEADERS.map((header) => ({
    header,
    key: header,
    width: TEMPLATE_WIDTHS[header] ?? 18,
  }));
  sheet.getRow(1).font = { bold: true };

  TEMPLATE_HEADERS.forEach((header, index) => {
    const column = index + 1;
    const note = TEMPLATE_NOTES[header];
    if (note) sheet.getCell(1, column).note = note;

    const choices = TEMPLATE_CHOICES[header];
    if (!choices) return;

    /* Row 2 down to the last row an import will read, one cell at a time:
       per-cell validation is the API ExcelJS documents and types. */
    const validation: ExcelJS.DataValidation = {
      type: "list",
      allowBlank: true,
      formulae: [`"${choices.join(",")}"`],
      showErrorMessage: true,
      errorStyle: "stop",
      errorTitle: header,
      error: `Choose one of: ${choices.join(", ")}.`,
    };
    for (let row = 2; row <= IMPORT_MAX_ROWS + 1; row += 1) {
      sheet.getCell(row, column).dataValidation = validation;
    }
  });

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
