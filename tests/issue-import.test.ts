import { afterAll, describe, expect, it, vi } from "vitest";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/prisma";
import { IMPORT_COLUMNS, TEMPLATE_HEADERS } from "@/lib/importTemplate";
import { importWorkItems, validateWorkItemsImport } from "@/server/issueImport";
import * as creation from "@/server/issueCreation";
import { actAs, projectByKey } from "./helpers";

/*
 * `insertIssue` is wrapped so one test can make the write itself fail part-way.
 * Everywhere else it is the real thing: the wrapper calls through.
 */
vi.mock("@/server/issueCreation", async (original) => {
  const actual = await original<typeof import("@/server/issueCreation")>();
  return { ...actual, insertIssue: vi.fn(actual.insertIssue) };
});

/**
 * Importing work items from a spreadsheet.
 *
 * The claims that carry this feature are about what does *not* happen: a file
 * with one bad row writes nothing at all; a file that fails part-way through
 * the write leaves nothing behind; a file cannot name a project, so it cannot
 * reach one. Everything else — keys, activity, notifications, the project's
 * own rules — comes from `checkNewIssue` and `insertIssue`, the functions
 * `createIssue` is made of, so it is covered by that action's own tests.
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

/** A workbook in memory, as a File the actions can read. */
async function sheetFile(
  rows: Record<string, string>[],
  headers: readonly string[] = TEMPLATE_HEADERS,
  name = "import.xlsx",
): Promise<File> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Work items");
  sheet.addRow([...headers]);
  for (const row of rows) {
    sheet.addRow(headers.map((header) => row[header] ?? ""));
  }
  const buffer = await workbook.xlsx.writeBuffer();
  return new File([buffer], name, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

function formOf(file: File, projectId?: string): FormData {
  const body = new FormData();
  body.set("file", file);
  if (projectId) body.set("projectId", projectId);
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

/** What a valid answer looks like, narrowed so tests can read it. */
async function validate(file: File, projectId?: string) {
  const result = await validateWorkItemsImport(formOf(file, projectId));
  if (!result.ok) throw new Error(`Refused: ${result.error}`);
  return result;
}

const S = IMPORT_COLUMNS;

describe("a spreadsheet Prio can use", () => {
  it("creates a work item per row, in the project it was opened from", async () => {
    await actAs(ADMIN);
    const project = await projectByKey("ENG");
    const stamp = Date.now();
    const titles = [`Imported one ${stamp}`, `Imported two ${stamp}`];

    const file = await sheetFile([
      { [S.summary]: titles[0]!, [S.issueType]: "Task", [S.priority]: "High" },
      { [S.summary]: titles[1]!, [S.issueType]: "Bug", [S.status]: "Backlog" },
    ]);

    const result = await importWorkItems(formOf(file, project.id));
    expect(result.ok, result.ok ? "" : result.error).toBe(true);
    if (!result.ok) return;

    expect(result.created).toBe(2);
    expect(await trackByTitle(titles)).toBe(2);

    const made = await prisma.issue.findFirstOrThrow({
      where: { title: titles[0]! },
      select: { key: true, type: true, priority: true, projectId: true },
    });
    expect(made.key.startsWith(`${project.key}-`)).toBe(true);
    expect(made.type).toBe("TASK");
    expect(made.priority).toBe("HIGH");
    /* No project column anywhere in the file: the project is the one the
       import was opened from. */
    expect(made.projectId).toBe(project.id);
  });

  it("files a blank Status as New, and honours one that is given", async () => {
    await actAs(ADMIN);
    const project = await projectByKey("ENG");
    const stamp = Date.now();
    const titles = [`Blank status ${stamp}`, `Said Backlog ${stamp}`, `Said In Progress ${stamp}`];

    const result = await importWorkItems(
      formOf(
        await sheetFile([
          { [S.summary]: titles[0]! },
          { [S.summary]: titles[1]!, [S.status]: "Backlog" },
          { [S.summary]: titles[2]!, [S.status]: "In Progress" },
        ]),
        project.id,
      ),
    );
    expect(result.ok, result.ok ? "" : result.error).toBe(true);
    await trackByTitle(titles);

    const status = async (title: string) =>
      (await prisma.issue.findFirstOrThrow({ where: { title }, select: { status: true } })).status;

    /* "New" is TODO on screen. An administrator's default would otherwise be
       Backlog, which is not what the template says a blank means. */
    expect(await status(titles[0]!)).toBe("TODO");
    expect(await status(titles[1]!)).toBe("BACKLOG");
    expect(await status(titles[2]!)).toBe("IN_PROGRESS");
  });

  it("maps every column onto its work-item field", async () => {
    await actAs(ADMIN);
    const project = await projectByKey("ENG");
    const member = await prisma.projectMember.findFirstOrThrow({
      where: { projectId: project.id, user: { email: MEMBER } },
      select: { user: { select: { id: true, name: true } } },
    });
    const parent = await prisma.issue.findFirstOrThrow({
      where: { projectId: project.id, parentId: null },
      select: { id: true, key: true },
    });
    const title = `Every column ${Date.now()}`;

    const result = await importWorkItems(
      formOf(
        await sheetFile([
          {
            [S.summary]: title,
            [S.description]: "Written in the spreadsheet",
            [S.issueType]: "Bug",
            [S.status]: "New",
            [S.priority]: "Urgent",
            [S.assignee]: member.user.name,
            [S.severity]: "Major",
            [S.parentIssue]: parent.key.toLowerCase(),
          },
        ]),
        project.id,
      ),
    );
    expect(result.ok, result.ok ? "" : result.error).toBe(true);
    await trackByTitle([title]);

    const made = await prisma.issue.findFirstOrThrow({
      where: { title },
      select: {
        description: true,
        type: true,
        status: true,
        priority: true,
        assigneeId: true,
        severity: true,
        parentId: true,
      },
    });
    expect(made).toEqual({
      description: "Written in the spreadsheet",
      type: "BUG",
      status: "TODO",
      priority: "URGENT",
      assigneeId: member.user.id,
      severity: "MAJOR",
      parentId: parent.id,
    });
  });

  it("records the creation in the trail, because it used the real write", async () => {
    await actAs(ADMIN);
    const project = await projectByKey("ENG");
    const title = `Imported with history ${Date.now()}`;

    const result = await importWorkItems(
      formOf(await sheetFile([{ [S.summary]: title }]), project.id),
    );
    expect(result.ok).toBe(true);
    await trackByTitle([title]);

    const issue = await prisma.issue.findFirstOrThrow({
      where: { title },
      select: { id: true },
    });
    expect(
      await prisma.activityLogEntry.count({ where: { issueId: issue.id } }),
    ).toBeGreaterThan(0);
  });

  it("skips blank padding rows and does not count them", async () => {
    await actAs(ADMIN);
    const project = await projectByKey("ENG");
    const title = `Between the blanks ${Date.now()}`;

    const result = await validate(
      await sheetFile([{}, { [S.summary]: title }, {}, {}]),
      project.id,
    );
    expect(result.total).toBe(1);
    expect(result.valid).toBe(1);
  });
});

describe("validating without writing", () => {
  it("reports every row, and creates nothing", async () => {
    await actAs(ADMIN);
    const project = await projectByKey("ENG");
    const stamp = Date.now();
    const before = await prisma.issue.count({ where: { projectId: project.id } });

    const result = await validate(
      await sheetFile([
        { [S.summary]: `Fine ${stamp}` },
        { [S.summary]: `Bad priority ${stamp}`, [S.priority]: "Critical" },
        { [S.summary]: "" , [S.description]: "no summary" },
      ]),
      project.id,
    );

    expect(result.total).toBe(3);
    expect(result.valid).toBe(1);
    expect(result.invalidCount).toBe(2);
    expect(result.invalid.map((r) => r.row)).toEqual([3, 4]); // Excel's own numbering.
    expect(result.invalid[0]!.summary).toBe(`Bad priority ${stamp}`);
    expect(result.invalid[0]!.errors[0]).toMatchObject({ column: S.priority });
    expect(result.invalid[1]!.summary).toBe("(empty)");
    expect(result.invalid[1]!.errors[0]!.message).toMatch(/summary is required/i);

    expect(await prisma.issue.count({ where: { projectId: project.id } })).toBe(before);
  });

  it("names the parent that does not exist, and the assignee who is not there", async () => {
    await actAs(ADMIN);
    const project = await projectByKey("ENG");
    const stamp = Date.now();

    const result = await validate(
      await sheetFile([
        { [S.summary]: `Ghost parent ${stamp}`, [S.parentIssue]: "ENG-99999" },
        { [S.summary]: `Ghost assignee ${stamp}`, [S.assignee]: "John123" },
      ]),
      project.id,
    );

    expect(result.invalidCount).toBe(2);
    expect(result.invalid[0]!.errors[0]!.message).toBe(
      'Parent Issue "ENG-99999" does not exist in ENG.',
    );
    expect(result.invalid[1]!.errors[0]!.message).toBe(
      'Assignee "John123" was not found in ENG.',
    );
  });

  it("refuses a status Prio does not have, listing the ones it does", async () => {
    await actAs(ADMIN);
    const project = await projectByKey("ENG");

    const result = await validate(
      await sheetFile([{ [S.summary]: `Odd status ${Date.now()}`, [S.status]: "Shipped" }]),
      project.id,
    );
    const message = result.invalid[0]!.errors[0]!.message;
    expect(message).toMatch(/Status "Shipped" is not valid/);
    expect(message).toMatch(/New/);
  });

  it("refuses an unknown issue type and severity", async () => {
    await actAs(ADMIN);
    const project = await projectByKey("ENG");

    const result = await validate(
      await sheetFile([
        {
          [S.summary]: `Odd type ${Date.now()}`,
          [S.issueType]: "Saga",
          [S.severity]: "Awful",
        },
      ]),
      project.id,
    );
    const columns = result.invalid[0]!.errors.map((e) => e.column);
    expect(columns).toEqual(expect.arrayContaining([S.issueType, S.severity]));
  });

  it("reuses the create form's rules: a one-letter summary is refused", async () => {
    await actAs(ADMIN);
    const project = await projectByKey("ENG");

    const result = await validate(await sheetFile([{ [S.summary]: "x" }]), project.id);
    expect(result.invalidCount).toBe(1);
    expect(result.invalid[0]!.errors[0]).toMatchObject({ column: S.summary });
    /* The rule is the form's; the word is the spreadsheet's. */
    expect(result.invalid[0]!.errors[0]!.message).toMatch(/summary/i);
  });
});

describe("all or nothing", () => {
  it("writes nothing at all when one row is wrong", async () => {
    /*
     * The claim the whole design rests on. The good rows sit either side of
     * the bad one, so an importer that wrote as it read would have created
     * some of them by the time it noticed.
     */
    await actAs(ADMIN);
    const project = await projectByKey("ENG");
    const stamp = Date.now();
    const titles = [`Should not exist A ${stamp}`, `Should not exist B ${stamp}`];

    const file = await sheetFile([
      { [S.summary]: titles[0]! },
      { [S.summary]: `Bad row ${stamp}`, [S.priority]: "Critical" },
      { [S.summary]: titles[1]! },
    ]);

    const result = await importWorkItems(formOf(file, project.id));
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.validation?.invalidCount).toBe(1);
    expect(result.validation?.valid).toBe(2);
    expect(result.validation?.invalid[0]?.row).toBe(3);
    expect(await prisma.issue.count({ where: { title: { in: titles } } })).toBe(0);
  });

  it("leaves nothing behind when the write itself fails part-way", async () => {
    /*
     * Validation cannot see everything: a connection drops, a project fills
     * up between the check and the write. Here the third of four writes throws.
     * The first two have already been written inside the transaction, and must
     * go with it — along with the keys they took from the project's sequence.
     */
    await actAs(ADMIN);
    const project = await projectByKey("ENG");
    const stamp = Date.now();
    const titles = [1, 2, 3, 4].map((n) => `Atomic ${n} ${stamp}`);
    const sequenceBefore = (
      await prisma.project.findUniqueOrThrow({
        where: { id: project.id },
        select: { issueSequence: true },
      })
    ).issueSequence;

    const real = (await vi.importActual<typeof import("@/server/issueCreation")>(
      "@/server/issueCreation",
    )).insertIssue;
    const insert = vi.mocked(creation.insertIssue);
    insert
      .mockImplementationOnce(real)
      .mockImplementationOnce(real)
      .mockImplementationOnce(async () => {
        throw new Error("the connection dropped");
      });

    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await importWorkItems(
      formOf(await sheetFile(titles.map((t) => ({ [S.summary]: t }))), project.id),
    );
    quiet.mockRestore();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/nothing was imported/i);

    expect(await prisma.issue.count({ where: { title: { in: titles } } })).toBe(0);
    expect(
      (
        await prisma.project.findUniqueOrThrow({
          where: { id: project.id },
          select: { issueSequence: true },
        })
      ).issueSequence,
    ).toBe(sequenceBefore);
  });

  it("refuses a file that would overfill the project before writing any of it", async () => {
    await actAs(ADMIN);
    const project = await projectByKey("KB");
    const held = await prisma.issue.count({ where: { projectId: project.id } });
    await prisma.project.update({
      where: { id: project.id },
      data: { maxIssues: held + 1 },
    });

    try {
      const titles = [`Fits ${Date.now()}`, `Does not fit ${Date.now()}`];
      const result = await importWorkItems(
        formOf(await sheetFile(titles.map((t) => ({ [S.summary]: t }))), project.id),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/room for 1 more/);
      expect(await prisma.issue.count({ where: { title: { in: titles } } })).toBe(0);
    } finally {
      await prisma.project.update({
        where: { id: project.id },
        data: { maxIssues: null },
      });
    }
  });
});

describe("a file whose shape Prio refuses", () => {
  it("says the Summary column is missing, and offers the template's columns", async () => {
    await actAs(ADMIN);
    const project = await projectByKey("ENG");
    const result = await validateWorkItemsImport(
      formOf(await sheetFile([], ["Description"]), project.id),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Missing required column: Summary/);
      expect(result.error).toMatch(/Parent Issue/);
    }
  });

  it("refuses the old template: Title, Project key, Type, Labels and Due date", async () => {
    await actAs(ADMIN);
    const project = await projectByKey("ENG");
    const result = await validateWorkItemsImport(
      formOf(
        await sheetFile(
          [{ Title: "Old", "Project key": "ENG" }],
          ["Title", "Project key", "Type", "Status", "Labels", "Due date"],
        ),
        project.id,
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/Missing required column: Summary/);
      expect(result.error).toMatch(/Unrecognised columns: Title, Project key, Type, Labels, Due date/);
    }
  });

  it("refuses a column that is not in the template, rather than ignoring it", async () => {
    await actAs(ADMIN);
    const project = await projectByKey("ENG");
    const result = await validateWorkItemsImport(
      formOf(await sheetFile([], [...TEMPLATE_HEADERS, "Notes"]), project.id),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/Unrecognised column: Notes/);
  });

  it("refuses a column that appears twice", async () => {
    await actAs(ADMIN);
    const project = await projectByKey("ENG");
    const result = await validateWorkItemsImport(
      formOf(await sheetFile([], ["Summary", "Status", "status"]), project.id),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/more than once: Status/);
  });

  it("finds columns by name, so reordering them still works", async () => {
    await actAs(ADMIN);
    const project = await projectByKey("ENG");
    const result = await validate(
      await sheetFile(
        [{ [S.summary]: `Reordered ${Date.now()}`, [S.priority]: "Low" }],
        [S.priority, S.summary],
      ),
      project.id,
    );
    expect(result.valid).toBe(1);
  });

  it("refuses a spreadsheet with a header and nothing under it", async () => {
    await actAs(ADMIN);
    const project = await projectByKey("ENG");
    const result = await validateWorkItemsImport(
      formOf(await sheetFile([]), project.id),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no rows/i);
  });

  it("refuses an empty file", async () => {
    await actAs(ADMIN);
    const project = await projectByKey("ENG");
    const result = await validateWorkItemsImport(
      formOf(new File([], "empty.xlsx"), project.id),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/choose a spreadsheet/i);
  });

  it("refuses a file that is not a spreadsheet", async () => {
    await actAs(ADMIN);
    const project = await projectByKey("ENG");
    const body = formOf(
      new File(["not a workbook"], "notes.txt", { type: "text/plain" }),
      project.id,
    );
    const result = await importWorkItems(body);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/xlsx/i);
  });

  it("refuses a workbook whose name lies about its contents", async () => {
    /* The extension is a claim by whoever named the file; reading it is the
       check. */
    await actAs(ADMIN);
    const project = await projectByKey("ENG");
    const body = formOf(
      new File(["still not a workbook"], "pretend.xlsx", {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
      project.id,
    );
    const result = await importWorkItems(body);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/could not be read/i);
  });
});

describe("the project", () => {
  it("has to be named by the page, since the file cannot name one", async () => {
    await actAs(ADMIN);
    const result = await validateWorkItemsImport(
      formOf(await sheetFile([{ [S.summary]: `No project ${Date.now()}` }])),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/choose the project/i);
  });

  it("cannot be one the person has no access to", async () => {
    /*
     * The id comes from the browser, so it is looked up inside what the
     * signed-in person can reach. A project they are not in resolves to
     * nothing and the import stops.
     */
    const member = await actAs(MEMBER);
    const stranger = await prisma.project.findFirst({
      where: { members: { none: { userId: member.id } } },
      select: { id: true },
    });
    if (!stranger) return; // Everybody is on everything in this data set.

    const title = `Across the fence ${Date.now()}`;
    const result = await importWorkItems(
      formOf(await sheetFile([{ [S.summary]: title }]), stranger.id),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/cannot add work/i);
    expect(await prisma.issue.count({ where: { title } })).toBe(0);
  });
});
