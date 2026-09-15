import ExcelJS from "exceljs";
import { expect, test } from "@playwright/test";

/**
 * The Excel export's Attachment links column, one URL to a line.
 *
 * A cell in a spreadsheet has no DOM and holds one hyperlink, so "each URL its
 * own block" is two things in Excel. Each file has its own clickable cell in
 * `Attachment 1 … n` (pinned in completed-and-export.spec). And in the text
 * columns, every URL and every filename is its own line that starts, runs and
 * ends without wrapping into its neighbour — because the columns are as wide
 * as the longest entry — lined up line for line, with the row's other cells
 * read from the top so Due date, Created and Updated sit level with the first
 * file.
 */

test("every attachment link is its own unwrapped line, level with its file and the row's dates", async ({
  request,
}) => {
  const response = await request.get("/api/issues/export");
  expect(response.status()).toBe(200);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load((await response.body()) as unknown as ExcelJS.Buffer);
  const sheet = workbook.getWorksheet("Issues")!;

  const headers = (sheet.getRow(1).values as unknown[]).slice(1).map((v) => String(v));
  const column = (name: string) => {
    const index = headers.indexOf(name);
    expect(index, `${name} is exported`).toBeGreaterThanOrEqual(0);
    return index + 1;
  };
  const count = column("Attachments");
  const files = column("Attachment files");
  const links = column("Attachment links");
  const dated = ["Due date", "Created", "Updated"].map(column);

  const linksWidth = sheet.getColumn(links).width ?? 0;
  const filesWidth = sheet.getColumn(files).width ?? 0;

  let rowsWithSeveral = 0;
  let longestLink = 0;
  let longestName = 0;

  sheet.eachRow((row, index) => {
    if (index === 1) return;
    const n = Number(row.getCell(count).value ?? 0);
    if (n === 0) return;

    const urls = String(row.getCell(links).value ?? "").split("\n");
    const names = String(row.getCell(files).value ?? "").split("\n");

    // One line per file, in both columns, and nothing merged or split.
    expect(urls, `row ${index}`).toHaveLength(n);
    expect(names, `row ${index}`).toHaveLength(n);
    for (const url of urls) {
      expect(url).toMatch(/^https?:\/\/[^\s]+\/api\/attachments\/[a-z0-9]+$/i);
      longestLink = Math.max(longestLink, url.length);
    }
    for (const name of names) longestName = Math.max(longestName, name.length);
    if (n > 1) rowsWithSeveral += 1;

    // Read from the top, so the first link, first file and dates line up.
    for (const cell of [files, links, ...dated]) {
      expect(row.getCell(cell).alignment?.vertical, `row ${index} col ${cell}`).toBe("top");
    }
    // Allowed to wrap inside its own cell if a link is ever longer than the ceiling.
    expect(row.getCell(links).alignment?.wrapText).toBe(true);
  });

  expect(rowsWithSeveral, "the data includes an issue with several files").toBeGreaterThan(0);
  // Wide enough that no URL (or name, up to its ceiling) wraps mid-line.
  expect(linksWidth).toBeGreaterThanOrEqual(Math.min(longestLink, 120));
  expect(filesWidth).toBeGreaterThanOrEqual(Math.min(longestName, 90));
});
