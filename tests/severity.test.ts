import { afterAll, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/prisma";
import {
  humanizeEnumValue,
  LEGACY_SEVERITY,
  SEVERITIES,
  SEVERITY_LABEL,
  severityFromLegacy,
} from "@/lib/domain";
import { IMPORT_COLUMNS, TEMPLATE_HEADERS } from "@/lib/importTemplate";
import { buildIssueWhere } from "@/server/queries/issues";
import { createIssue, reportBug, updateIssue } from "@/server/issues";
import { importWorkItems, validateWorkItemsImport } from "@/server/issueImport";
import { actAs, deleteIssues, projectByKey } from "./helpers";

/**
 * Severity is how bad the problem is — High, Medium or Low — optional, on
 * every type of work item. The stored value is the code (`HIGH`); the label is
 * what people read. These tests hold that on every write path: create, edit,
 * import — and the list filter.
 */

const ADMIN = "admin@symbiosystech.com";
const created: string[] = [];
const S = IMPORT_COLUMNS;

afterAll(async () => {
  await deleteIssues(created);
  await prisma.$disconnect();
});

async function makeIssue(type: "BUG" | "TASK" | "STORY", severity?: string) {
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
  it("is High / Medium / Low, most severe first", () => {
    expect([...SEVERITIES]).toEqual(["HIGH", "MEDIUM", "LOW"]);
    expect(SEVERITY_LABEL).toEqual({ HIGH: "High", MEDIUM: "Medium", LOW: "Low" });
  });

  it("maps the old four-level scale without downgrading anything serious", () => {
    expect(LEGACY_SEVERITY).toEqual({
      CRITICAL: "HIGH",
      MAJOR: "HIGH",
      MINOR: "MEDIUM",
      TRIVIAL: "LOW",
    });
    expect(severityFromLegacy("critical")).toBe("HIGH");
    expect(severityFromLegacy("Awful")).toBeNull();
  });

  it("reads old activity entries as the value they became", () => {
    expect(humanizeEnumValue("severity", "CRITICAL")).toBe("High");
    expect(humanizeEnumValue("severity", "MAJOR")).toBe("High");
    expect(humanizeEnumValue("severity", "MINOR")).toBe("Medium");
    expect(humanizeEnumValue("severity", "TRIVIAL")).toBe("Low");
    expect(humanizeEnumValue("severity", "HIGH")).toBe("High");
    expect(humanizeEnumValue("severity", "SOMETHING")).toBe("SOMETHING");
  });
});

describe("creating", () => {
  for (const type of ["BUG", "TASK", "STORY"] as const) {
    for (const severity of SEVERITIES) {
      it(`stores ${severity} on a ${type}`, async () => {
        const result = await makeIssue(type, severity);
        expect(result.ok, result.ok ? "" : result.error).toBe(true);
        if (!result.ok) return;
        expect(await severityOf(result.data.id)).toBe(severity);
      });
    }
  }

  it("leaves it empty when none is chosen", async () => {
    const result = await makeIssue("TASK");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await severityOf(result.data.id)).toBeNull();
  });

  it("refuses anything that is not a current severity, and writes nothing", async () => {
    await actAs(ADMIN);
    const project = await projectByKey("ENG");
    const before = await prisma.issue.count({ where: { projectId: project.id } });
    for (const bad of ["CRITICAL", "MAJOR", "High", "P0", "", "URGENT"]) {
      const result = await makeIssue("BUG", bad);
      expect(result.ok, `"${bad}"`).toBe(false);
      if (!result.ok) expect(result.fieldErrors?.severity).toBeDefined();
    }
    expect(await prisma.issue.count({ where: { projectId: project.id } })).toBe(before);
  });
});

describe("editing", () => {
  it("sets, changes and clears severity on any type, logging each change", async () => {
    const made = await makeIssue("TASK", "LOW");
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const issueId = made.data.id;

    const raised = await updateIssue({ issueId, severity: "HIGH" });
    expect(raised.ok, raised.ok ? "" : raised.error).toBe(true);
    expect(await severityOf(issueId)).toBe("HIGH");

    const cleared = await updateIssue({ issueId, severity: null });
    expect(cleared.ok).toBe(true);
    expect(await severityOf(issueId)).toBeNull();

    const entries = await prisma.activityLogEntry.findMany({
      where: { issueId, field: "severity" },
      orderBy: { createdAt: "asc" },
      select: { oldValue: true, newValue: true },
    });
    expect(entries).toEqual([
      { oldValue: "LOW", newValue: "HIGH" },
      { oldValue: "HIGH", newValue: null },
    ]);
  });

  it("refuses an invalid value and keeps the old one", async () => {
    const made = await makeIssue("BUG", "MEDIUM");
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    for (const bad of ["CRITICAL", "Medium", "P1"]) {
      const result = await updateIssue({ issueId: made.data.id, severity: bad });
      expect(result.ok, `"${bad}"`).toBe(false);
    }
    expect(await severityOf(made.data.id)).toBe("MEDIUM");
  });

  it("does not touch severity when an update does not mention it", async () => {
    const made = await makeIssue("BUG", "LOW");
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    await updateIssue({ issueId: made.data.id, priority: "P0" });
    expect(await severityOf(made.data.id)).toBe("LOW");
  });
});

describe("reporting a bug against work", () => {
  it("stores the severity chosen in the Report Bug dialog, or none", async () => {
    const target = await makeIssue("TASK");
    expect(target.ok).toBe(true);
    if (!target.ok) return;

    for (const severity of ["HIGH", undefined] as const) {
      const result = await reportBug({
        issueId: target.data.id,
        title: `Reported against it ${Date.now()}`,
        affectedModule: "Checkout",
        ...(severity ? { severity } : {}),
      });
      expect(result.ok, result.ok ? "" : result.error).toBe(true);
      if (!result.ok) continue;
      created.push(result.data.id);
      expect(await severityOf(result.data.id)).toBe(severity ?? null);
    }

    const refused = await reportBug({
      issueId: target.data.id,
      title: "Reported with a bad severity",
      affectedModule: "Checkout",
      severity: "CRITICAL",
    });
    expect(refused.ok).toBe(false);
  });
});

describe("the list filter", () => {
  it("filters by the codes, and understands an old ?severity=CRITICAL", async () => {
    const user = await actAs(ADMIN);
    const asUser = { ...user, isActive: true } as Parameters<typeof buildIssueWhere>[0];
    expect(buildIssueWhere(asUser, { severities: ["HIGH", "LOW"] }).severity).toEqual({
      in: ["HIGH", "LOW"],
    });
    expect(buildIssueWhere(asUser, { severities: ["CRITICAL", "MAJOR"] }).severity).toEqual({
      in: ["HIGH"],
    });
    expect(buildIssueWhere(asUser, { severities: ["Awful"] }).severity).toBeUndefined();
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

  it("reads Severity on any row, taking labels, codes and the old words", async () => {
    await actAs(ADMIN);
    const result = await importWorkItems(
      await form(
        await sheet([
          { type: "Task", severity: "High" },
          { type: "Story", severity: "medium" },
          { type: "Bug", severity: "LOW" },
          { type: "Bug", severity: "Critical" },
          { type: "Task", severity: "Minor" },
          { type: "Bug", severity: "" },
        ]),
      ),
    );
    expect(result.ok, result.ok ? "" : result.error).toBe(true);

    const rows = await prisma.issue.findMany({
      where: { title: { startsWith: "Severity import " } },
      select: { id: true, title: true, severity: true },
    });
    created.push(...rows.map((r) => r.id));
    const bySlot = rows
      .sort((a, b) => Number(a.title.split(" ")[2]) - Number(b.title.split(" ")[2]))
      .map((r) => r.severity);
    expect(bySlot).toEqual(["HIGH", "MEDIUM", "LOW", "HIGH", "MEDIUM", null]);
  });

  it("rejects a Severity it does not know, naming the Severity column", async () => {
    await actAs(ADMIN);
    const result = await validateWorkItemsImport(
      await form(await sheet([{ type: "Task", severity: "Awful" }])),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.invalidCount).toBe(1);
    expect(result.invalid[0]!.errors.some((e) => e.column === S.severity)).toBe(true);
  });
});
