import { afterAll, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/prisma";
import { SEVERITIES, SEVERITY_LABEL, severityAppliesTo } from "@/lib/domain";
import { IMPORT_COLUMNS, TEMPLATE_HEADERS } from "@/lib/importTemplate";
import { createIssue, updateIssue } from "@/server/issues";
import { importWorkItems, validateWorkItemsImport } from "@/server/issueImport";
import { actAs, deleteIssues, projectByKey } from "./helpers";

/**
 * Severity is how bad a *bug* is — Critical, Major, Minor or Trivial — and it
 * exists on bugs only. Optional; "not set" is a real answer. These tests hold
 * the "bugs only" line on every write path: create, edit, and the import.
 */

const ADMIN = "admin@symbiosystech.com";
const created: string[] = [];
const S = IMPORT_COLUMNS;

afterAll(async () => {
  await deleteIssues(created);
  await prisma.$disconnect();
});

async function makeIssue(type: "BUG" | "TASK", severity?: string) {
  await actAs(ADMIN);
  const project = await projectByKey("ENG");
  const result = await createIssue({
    projectId: project.id,
    type,
    title: `Severity ${type} ${Date.now()}${Math.random().toString(36).slice(2, 5)}`,
    status: "TODO",
    priority: "P2",
    ...(severity === undefined ? {} : { severity }),
  });
  if (result.ok) created.push(result.data.id);
  return result;
}

async function severityOf(issueId: string) {
  return (
    await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: { severity: true },
    })
  ).severity;
}

describe("the vocabulary", () => {
  it("keeps Critical / Major / Minor / Trivial", () => {
    expect([...SEVERITIES]).toEqual(["CRITICAL", "MAJOR", "MINOR", "TRIVIAL"]);
    expect(SEVERITY_LABEL).toEqual({
      CRITICAL: "Critical",
      MAJOR: "Major",
      MINOR: "Minor",
      TRIVIAL: "Trivial",
    });
  });

  it("applies to bugs and to nothing else", () => {
    expect(severityAppliesTo("BUG")).toBe(true);
    for (const type of ["TASK", "STORY", "EPIC", "FEATURE"] as const) {
      expect(severityAppliesTo(type)).toBe(false);
    }
  });
});

describe("creating", () => {
  for (const severity of SEVERITIES) {
    it(`stores ${severity} on a bug`, async () => {
      const result = await makeIssue("BUG", severity);
      expect(result.ok, result.ok ? "" : result.error).toBe(true);
      if (!result.ok) return;
      expect(await severityOf(result.data.id)).toBe(severity);
    });
  }

  it("leaves it empty when a bug is filed without one", async () => {
    const result = await makeIssue("BUG");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await severityOf(result.data.id)).toBeNull();
  });

  it("refuses a severity on anything that is not a bug, and writes nothing", async () => {
    await actAs(ADMIN);
    const project = await projectByKey("ENG");
    const before = await prisma.issue.count({ where: { projectId: project.id } });

    for (const type of ["TASK", "STORY"] as const) {
      const result = await createIssue({
        projectId: project.id,
        type,
        title: `Should not exist ${type}`,
        status: "TODO",
        severity: "MAJOR",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.fieldErrors?.severity).toBeDefined();
    }
    expect(await prisma.issue.count({ where: { projectId: project.id } })).toBe(before);
  });

  it("refuses a value that is not a severity", async () => {
    for (const bad of ["HIGH", "Major", "P0", "", "URGENT"]) {
      const result = await makeIssue("BUG", bad);
      expect(result.ok, `"${bad}"`).toBe(false);
    }
  });
});

describe("editing", () => {
  it("sets, changes and clears a bug's severity, logging each change", async () => {
    const made = await makeIssue("BUG", "MINOR");
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const issueId = made.data.id;

    const raised = await updateIssue({ issueId, severity: "CRITICAL" });
    expect(raised.ok, raised.ok ? "" : raised.error).toBe(true);
    expect(await severityOf(issueId)).toBe("CRITICAL");

    const cleared = await updateIssue({ issueId, severity: null });
    expect(cleared.ok).toBe(true);
    expect(await severityOf(issueId)).toBeNull();

    const entries = await prisma.activityLogEntry.findMany({
      where: { issueId, field: "severity" },
      orderBy: { createdAt: "asc" },
      select: { oldValue: true, newValue: true },
    });
    expect(entries).toEqual([
      { oldValue: "MINOR", newValue: "CRITICAL" },
      { oldValue: "CRITICAL", newValue: null },
    ]);
  });

  it("refuses to set a severity on a task, and leaves it empty", async () => {
    const made = await makeIssue("TASK");
    expect(made.ok).toBe(true);
    if (!made.ok) return;

    const result = await updateIssue({ issueId: made.data.id, severity: "MAJOR" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.fieldErrors?.severity).toBe("Severity applies to bugs only.");
    expect(await severityOf(made.data.id)).toBeNull();
  });

  it("refuses an invalid value on a bug and keeps the old one", async () => {
    const made = await makeIssue("BUG", "MAJOR");
    expect(made.ok).toBe(true);
    if (!made.ok) return;

    for (const bad of ["HIGH", "Major", "P1"]) {
      const result = await updateIssue({ issueId: made.data.id, severity: bad });
      expect(result.ok, `"${bad}"`).toBe(false);
    }
    expect(await severityOf(made.data.id)).toBe("MAJOR");
  });

  it("does not touch severity when an update does not mention it", async () => {
    const made = await makeIssue("BUG", "TRIVIAL");
    expect(made.ok).toBe(true);
    if (!made.ok) return;

    await updateIssue({ issueId: made.data.id, priority: "P0" });
    expect(await severityOf(made.data.id)).toBe("TRIVIAL");
  });
});

describe("the spreadsheet import", () => {
  async function sheet(rows: { type: string; severity: string }[]): Promise<File> {
    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet("Work items");
    ws.addRow([...TEMPLATE_HEADERS]);
    rows.forEach((row, i) => {
      ws.addRow(
        TEMPLATE_HEADERS.map((h) =>
          h === S.summary
            ? `Severity import ${i} ${Date.now()}`
            : h === S.issueType
              ? row.type
              : h === S.severity
                ? row.severity
                : "",
        ),
      );
    });
    return new File([await workbook.xlsx.writeBuffer()], "s.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
  }
  async function form(file: File): Promise<FormData> {
    const project = await projectByKey("ENG");
    const body = new FormData();
    body.set("file", file);
    body.set("projectId", project.id);
    return body;
  }

  it("reads Severity on Bug rows", async () => {
    await actAs(ADMIN);
    const result = await importWorkItems(
      await form(
        await sheet([
          { type: "Bug", severity: "Critical" },
          { type: "Bug", severity: "MINOR" },
          { type: "Bug", severity: "" },
        ]),
      ),
    );
    expect(result.ok, result.ok ? "" : result.error).toBe(true);

    const rows = await prisma.issue.findMany({
      where: { title: { startsWith: "Severity import " } },
      select: { id: true, title: true, severity: true, type: true },
    });
    created.push(...rows.map((r) => r.id));
    const bySlot = rows
      .sort((a, b) => Number(a.title.split(" ")[2]) - Number(b.title.split(" ")[2]))
      .map((r) => r.severity);
    expect(bySlot).toEqual(["CRITICAL", "MINOR", null]);
    expect(rows.every((r) => r.type === "BUG")).toBe(true);
  });

  it("rejects Severity on a non-Bug row, naming the Severity column", async () => {
    await actAs(ADMIN);
    const result = await validateWorkItemsImport(
      await form(
        await sheet([
          { type: "Task", severity: "Major" },
          { type: "Bug", severity: "Major" },
        ]),
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.valid).toBe(1);
    expect(result.invalidCount).toBe(1);
    const errors = result.invalid[0]!.errors;
    expect(errors.some((e) => e.column === S.severity)).toBe(true);
  });

  it("rejects a Severity that is not one of the four", async () => {
    await actAs(ADMIN);
    const result = await validateWorkItemsImport(
      await form(await sheet([{ type: "Bug", severity: "High" }])),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.invalidCount).toBe(1);
    expect(result.invalid[0]!.errors.some((e) => e.column === S.severity)).toBe(true);
  });
});
