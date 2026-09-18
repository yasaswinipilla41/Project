import { afterAll, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/prisma";
import { importWorkItems } from "@/server/issueImport";
import { actAs, projectByKey } from "./helpers";

/**
 * Importing work items from a spreadsheet.
 *
 * Two claims carry this feature, and both are about what does *not* happen:
 * a spreadsheet with a bad row writes nothing at all, and a spreadsheet naming
 * a project somebody cannot reach writes nothing either. Everything else —
 * keys, activity, notifications, the project's own rules — comes from
 * `createIssue`, which this calls rather than reimplements, so it is covered
 * by that action's own tests.
 */

const ADMIN = "admin@symbiosystech.com";
const MEMBER = "kiran.das@symbiosystech.com";

const createdIssueIds: string[] = [];

afterAll(async () => {
  if (createdIssueIds.length > 0) {
    await prisma.notification.deleteMany({
      where: { issueId: { in: createdIssueIds } },
    });
    await prisma.issue.deleteMany({ where: { id: { in: createdIssueIds } } });
  }
  await prisma.$disconnect();
});

/** A workbook in memory, as a File the action can read. */
async function sheetFile(
  rows: Record<string, string>[],
  headers: string[],
  name = "import.xlsx",
): Promise<File> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Work items");
  sheet.addRow(headers);
  for (const row of rows) {
    sheet.addRow(headers.map((header) => row[header] ?? ""));
  }
  const buffer = await workbook.xlsx.writeBuffer();
  return new File([buffer], name, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

function formOf(file: File): FormData {
  const body = new FormData();
  body.set("file", file);
  return body;
}

/** Remembers whatever the import created, so the suite cleans up after itself. */
async function trackByTitle(titles: string[]) {
  const rows = await prisma.issue.findMany({
    where: { title: { in: titles } },
    select: { id: true },
  });
  createdIssueIds.push(...rows.map((r) => r.id));
  return rows.length;
}

const HEADERS = [
  "Title",
  "Project key",
  "Type",
  "Status",
  "Priority",
  "Due date",
  "Description",
];

describe("a spreadsheet Prio can use", () => {
  it("creates a work item per row, through the ordinary creation path", async () => {
    await actAs(ADMIN);
    const project = await projectByKey("ENG");
    const stamp = Date.now();
    const titles = [`Imported one ${stamp}`, `Imported two ${stamp}`];

    const file = await sheetFile(
      [
        {
          Title: titles[0]!,
          "Project key": project.key,
          Type: "Task",
          Priority: "High",
        },
        {
          Title: titles[1]!,
          "Project key": project.key,
          Type: "Bug",
          Status: "Backlog",
        },
      ],
      HEADERS,
    );

    const result = await importWorkItems(formOf(file));
    expect(result.ok, result.ok ? "" : result.error).toBe(true);
    if (!result.ok) return;

    expect(result.created).toBe(2);
    expect(await trackByTitle(titles)).toBe(2);

    /* Real work items: a key from the project's own sequence, and the type
       and priority the sheet asked for. */
    const made = await prisma.issue.findFirstOrThrow({
      where: { title: titles[0]! },
      select: { key: true, type: true, priority: true, projectId: true },
    });
    expect(made.key.startsWith(`${project.key}-`)).toBe(true);
    expect(made.type).toBe("TASK");
    expect(made.priority).toBe("HIGH");
    expect(made.projectId).toBe(project.id);
  });

  it("records the creation in the trail, because it used the real action", async () => {
    await actAs(ADMIN);
    const project = await projectByKey("ENG");
    const title = `Imported with history ${Date.now()}`;

    const result = await importWorkItems(
      formOf(
        await sheetFile([{ Title: title, "Project key": project.key }], HEADERS),
      ),
    );
    expect(result.ok).toBe(true);
    await trackByTitle([title]);

    const issue = await prisma.issue.findFirstOrThrow({
      where: { title },
      select: { id: true },
    });
    const trail = await prisma.activityLogEntry.count({
      where: { issueId: issue.id },
    });
    expect(trail).toBeGreaterThan(0);
  });
});

describe("a spreadsheet Prio refuses", () => {
  it("writes nothing at all when one row is wrong", async () => {
    /*
     * The claim the whole design rests on. The good row sits before the bad
     * one, so an importer that wrote as it read would have created it by the
     * time it noticed.
     */
    await actAs(ADMIN);
    const project = await projectByKey("ENG");
    const stamp = Date.now();
    const goodTitle = `Should not exist ${stamp}`;

    const file = await sheetFile(
      [
        { Title: goodTitle, "Project key": project.key },
        { Title: `Bad row ${stamp}`, "Project key": project.key, Priority: "Critical" },
      ],
      HEADERS,
    );

    const result = await importWorkItems(formOf(file));
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.problems?.[0]?.row).toBe(3); // Excel's own numbering.
    expect(result.problems?.[0]?.message).toMatch(/priority/i);

    // And the row before it was never written.
    expect(await prisma.issue.count({ where: { title: goodTitle } })).toBe(0);
  });

  it("says which column is missing rather than failing blankly", async () => {
    await actAs(ADMIN);
    const file = await sheetFile([{ Summary: "no title column" }], ["Summary"]);

    const result = await importWorkItems(formOf(file));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Title/);
  });

  it("names the row and the reason for a missing title", async () => {
    await actAs(ADMIN);
    const project = await projectByKey("ENG");

    const result = await importWorkItems(
      formOf(await sheetFile([{ "Project key": project.key }], HEADERS)),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems?.[0]?.row).toBe(2);
    expect(result.problems?.[0]?.message).toMatch(/required/i);
  });

  it("refuses an assignee who is not on the project", async () => {
    await actAs(ADMIN);
    const project = await projectByKey("ENG");

    const result = await importWorkItems(
      formOf(
        await sheetFile(
          [
            {
              Title: `Bad assignee ${Date.now()}`,
              "Project key": project.key,
              Assignee: "nobody@example.com",
            },
          ],
          [...HEADERS, "Assignee"],
        ),
      ),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problems?.[0]?.message).toMatch(/not a member/i);
  });

  it("refuses a file that is not a spreadsheet", async () => {
    await actAs(ADMIN);
    const body = new FormData();
    body.set("file", new File(["not a workbook"], "notes.txt", { type: "text/plain" }));

    const result = await importWorkItems(body);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/xlsx/i);
  });

  it("refuses a workbook whose name lies about its contents", async () => {
    /* The extension is a claim by whoever named the file; reading it is the
       check. */
    await actAs(ADMIN);
    const body = new FormData();
    body.set(
      "file",
      new File(["still not a workbook"], "pretend.xlsx", {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    );

    const result = await importWorkItems(body);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/could not be read/i);
  });
});

describe("a spreadsheet naming somebody else's project", () => {
  it("imports nothing, and says the project is not theirs", async () => {
    /*
     * Testing is the administrator's own project and this member is not in it.
     * The key is resolved inside what the signed-in person can reach, so a
     * spreadsheet cannot be used to reach past that.
     */
    await actAs(MEMBER);
    const testing = await projectByKey("TES");
    const title = `Across the fence ${Date.now()}`;

    const result = await importWorkItems(
      formOf(await sheetFile([{ Title: title, "Project key": testing.key }], HEADERS)),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems?.[0]?.message).toMatch(/no project/i);
    }
    expect(await prisma.issue.count({ where: { title } })).toBe(0);
  });
});
