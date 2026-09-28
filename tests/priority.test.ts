import { afterAll, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/prisma";
import {
  DEFAULT_PRIORITY,
  humanizeEnumValue,
  LEGACY_PRIORITY,
  PRIORITIES,
  PRIORITY_LABEL,
  PRIORITY_OPTIONS,
  PRIORITY_WEIGHT,
  priorityFromLegacy,
} from "@/lib/domain";
import { IMPORT_COLUMNS, TEMPLATE_HEADERS } from "@/lib/importTemplate";
import { prioritySchema, createIssueSchema } from "@/server/schemas";
import { buildIssueWhere } from "@/server/queries/issues";
import { createIssue, updateIssue } from "@/server/issues";
import { importWorkItems, validateWorkItemsImport } from "@/server/issueImport";
import { actAs, deleteIssues, projectByKey } from "./helpers";

/**
 * Priority is P0 / P1 / P2 / P3 — and the stored value is the bare code, never
 * its label. "P0 (Urgent)" is what a person reads; `P0` is what the database,
 * the API, the filters and every comparison in code use. These tests hold the
 * two apart.
 */

const ADMIN = "admin@symbiosystech.com";
const created: string[] = [];
const S = IMPORT_COLUMNS;

afterAll(async () => {
  await deleteIssues(created);
  await prisma.$disconnect();
});

describe("the canonical definition", () => {
  it("has exactly P0, P1, P2, P3, most urgent first", () => {
    expect([...PRIORITIES]).toEqual(["P0", "P1", "P2", "P3"]);
  });

  it("displays P0 as 'P0 (Urgent)' and the rest as themselves", () => {
    expect(PRIORITY_LABEL.P0).toBe("P0 (Urgent)");
    expect(PRIORITY_LABEL.P1).toBe("P1");
    expect(PRIORITY_LABEL.P2).toBe("P2");
    expect(PRIORITY_LABEL.P3).toBe("P3");
  });

  it("offers value/label pairs from that one definition", () => {
    expect(PRIORITY_OPTIONS).toEqual([
      { value: "P0", label: "P0 (Urgent)" },
      { value: "P1", label: "P1" },
      { value: "P2", label: "P2" },
      { value: "P3", label: "P3" },
    ]);
  });

  it("defaults to P2", () => {
    expect(DEFAULT_PRIORITY).toBe("P2");
  });

  it("sorts P0 first", () => {
    const byWeight = [...PRIORITIES].sort(
      (a, b) => PRIORITY_WEIGHT[b] - PRIORITY_WEIGHT[a],
    );
    expect(byWeight).toEqual(["P0", "P1", "P2", "P3"]);
  });

  it("does not accept a label as a value", () => {
    expect(prioritySchema.safeParse("P0").success).toBe(true);
    expect(prioritySchema.safeParse("P0 (Urgent)").success).toBe(false);
  });
});

describe("what a legacy value means", () => {
  it("maps each old word to its new value, and nothing else", () => {
    expect(LEGACY_PRIORITY).toEqual({
      URGENT: "P0",
      HIGH: "P1",
      MEDIUM: "P2",
      LOW: "P3",
      NONE: "P3",
    });
    expect(priorityFromLegacy("High")).toBe("P1");
    expect(priorityFromLegacy("urgent")).toBe("P0");
    expect(priorityFromLegacy("Critical")).toBeNull();
  });

  it("reads old activity entries as the value they became", () => {
    expect(humanizeEnumValue("priority", "URGENT")).toBe("P0 (Urgent)");
    expect(humanizeEnumValue("priority", "HIGH")).toBe("P1");
    expect(humanizeEnumValue("priority", "MEDIUM")).toBe("P2");
    expect(humanizeEnumValue("priority", "LOW")).toBe("P3");
    expect(humanizeEnumValue("priority", "NONE")).toBe("P3");
    expect(humanizeEnumValue("priority", "P0")).toBe("P0 (Urgent)");
    // Unknown text is shown as it is, never guessed at.
    expect(humanizeEnumValue("priority", "SOMETHING")).toBe("SOMETHING");
  });
});

describe("the server refuses anything else", () => {
  const INVALID = [
    "URGENT",
    "HIGH",
    "MEDIUM",
    "LOW",
    "NONE",
    "P4",
    "p0",
    "P0 (Urgent)",
    "",
  ];

  it("rejects an invalid priority in the create contract", () => {
    for (const priority of INVALID) {
      const parsed = createIssueSchema.safeParse({
        projectId: "x",
        type: "TASK",
        title: "Valid title",
        priority,
      });
      expect(parsed.success, `"${priority}"`).toBe(false);
    }
  });

  it("createIssue rejects each, writes nothing, and names the field", async () => {
    await actAs(ADMIN);
    const project = await projectByKey("ENG");
    const before = await prisma.issue.count({ where: { projectId: project.id } });

    for (const priority of INVALID) {
      const result = await createIssue({
        projectId: project.id,
        type: "TASK",
        title: `Invalid priority ${priority || "(empty)"}`,
        status: "TODO",
        priority,
      });
      expect(result.ok, `"${priority}"`).toBe(false);
      if (!result.ok) expect(result.fieldErrors?.priority).toBeDefined();
    }

    expect(await prisma.issue.count({ where: { projectId: project.id } })).toBe(before);
  });

  it("updateIssue rejects each and leaves the stored value alone", async () => {
    await actAs(ADMIN);
    const project = await projectByKey("ENG");
    const made = await createIssue({
      projectId: project.id,
      type: "TASK",
      title: `Update target ${Date.now()}`,
      status: "TODO",
      priority: "P1",
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    created.push(made.data.id);

    for (const priority of INVALID) {
      const result = await updateIssue({ issueId: made.data.id, priority });
      expect(result.ok, `"${priority}"`).toBe(false);
    }
    const row = await prisma.issue.findUniqueOrThrow({
      where: { id: made.data.id },
      select: { priority: true },
    });
    expect(row.priority).toBe("P1");
  });
});

describe("create and edit use the canonical values", () => {
  it("stores exactly what was sent, for each of P0..P3", async () => {
    await actAs(ADMIN);
    const project = await projectByKey("ENG");

    for (const priority of PRIORITIES) {
      const result = await createIssue({
        projectId: project.id,
        type: "TASK",
        title: `Canonical ${priority} ${Date.now()}`,
        status: "TODO",
        priority,
      });
      expect(result.ok, result.ok ? "" : result.error).toBe(true);
      if (!result.ok) continue;
      created.push(result.data.id);

      const row = await prisma.issue.findUniqueOrThrow({
        where: { id: result.data.id },
        select: { priority: true },
      });
      expect(row.priority).toBe(priority);
    }
  });

  it("defaults to P2 when nothing is chosen", async () => {
    await actAs(ADMIN);
    const project = await projectByKey("ENG");
    const result = await createIssue({
      projectId: project.id,
      type: "TASK",
      title: `Default priority ${Date.now()}`,
      status: "TODO",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    created.push(result.data.id);

    const row = await prisma.issue.findUniqueOrThrow({
      where: { id: result.data.id },
      select: { priority: true },
    });
    expect(row.priority).toBe("P2");
  });

  it("edits to a canonical value and logs the codes, not the labels", async () => {
    await actAs(ADMIN);
    const project = await projectByKey("ENG");
    const made = await createIssue({
      projectId: project.id,
      type: "TASK",
      title: `Edit priority ${Date.now()}`,
      status: "TODO",
      priority: "P3",
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    created.push(made.data.id);

    const result = await updateIssue({ issueId: made.data.id, priority: "P0" });
    expect(result.ok, result.ok ? "" : result.error).toBe(true);

    const entry = await prisma.activityLogEntry.findFirstOrThrow({
      where: { issueId: made.data.id, field: "priority" },
      select: { oldValue: true, newValue: true },
    });
    expect(entry).toEqual({ oldValue: "P3", newValue: "P0" });
  });
});

describe("filters use the canonical values", () => {
  it("filters by P0 and ignores anything that is not a priority", async () => {
    const user = await actAs(ADMIN);
    const asUser = { ...user, isActive: true } as Parameters<typeof buildIssueWhere>[0];

    const where = buildIssueWhere(asUser, { priorities: ["P0", "P1"] });
    expect(where.priority).toEqual({ in: ["P0", "P1"] });

    // A junk value is dropped rather than reaching the query.
    const junk = buildIssueWhere(asUser, { priorities: ["P0 (Urgent)", "P9"] });
    expect(junk.priority).toBeUndefined();
  });

  it("still understands a bookmarked ?priority=HIGH from before P0-P3", async () => {
    const user = await actAs(ADMIN);
    const asUser = { ...user, isActive: true } as Parameters<typeof buildIssueWhere>[0];

    const where = buildIssueWhere(asUser, { priorities: ["URGENT", "HIGH", "high"] });
    expect(where.priority).toEqual({ in: ["P0", "P1"] });
  });
});

describe("import", () => {
  async function sheet(priorityCells: string[]): Promise<File> {
    const workbook = new ExcelJS.Workbook();
    const ws = workbook.addWorksheet("Work items");
    ws.addRow([...TEMPLATE_HEADERS]);
    priorityCells.forEach((cell, i) => {
      ws.addRow(
        TEMPLATE_HEADERS.map((h) =>
          h === S.summary ? `Priority import ${i} ${Date.now()}` : h === S.priority ? cell : "",
        ),
      );
    });
    return new File([await workbook.xlsx.writeBuffer()], "p.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
  }
  function form(file: File, projectId: string): FormData {
    const body = new FormData();
    body.set("file", file);
    body.set("projectId", projectId);
    return body;
  }

  it("takes the code or the label, and a legacy word from an old file", async () => {
    await actAs(ADMIN);
    const project = await projectByKey("ENG");
    const cells = ["P0", "P0 (Urgent)", "p1", "P2", "P3", "Urgent", "High", "Medium", "Low", "None", ""];
    const expected = ["P0", "P0", "P1", "P2", "P3", "P0", "P1", "P2", "P3", "P3", "P2"];

    const result = await importWorkItems(form(await sheet(cells), project.id));
    expect(result.ok, result.ok ? "" : result.error).toBe(true);

    const rows = await prisma.issue.findMany({
      where: { title: { startsWith: "Priority import " }, projectId: project.id },
      select: { id: true, title: true, priority: true },
    });
    created.push(...rows.map((r) => r.id));
    const byIndex = rows
      .map((r) => ({ i: Number(r.title.split(" ")[2]), p: r.priority }))
      .sort((a, b) => a.i - b.i)
      .map((r) => r.p);
    expect(byIndex).toEqual(expected.slice(0, cells.length));
  });

  it("rejects a priority that is not one of them, naming the column", async () => {
    await actAs(ADMIN);
    const project = await projectByKey("ENG");
    const result = await validateWorkItemsImport(form(await sheet(["P4", "Critical"]), project.id));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.valid).toBe(0);
    expect(result.invalidCount).toBe(2);
    for (const row of result.invalid) {
      expect(row.errors.some((e) => e.column === S.priority)).toBe(true);
    }
  });
});
