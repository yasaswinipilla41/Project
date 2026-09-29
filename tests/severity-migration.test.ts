import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

/**
 * The Severity migration, run for real against every old value.
 *
 * Builds the database as it was just before it — every earlier migration, in
 * order — inside a throwaway schema, fills it with one issue per old severity
 * (and some with none), runs the migration and checks the result:
 *
 *   CRITICAL -> HIGH   MAJOR -> HIGH   MINOR -> MEDIUM   TRIVIAL -> LOW   NULL -> NULL
 */

const MIGRATIONS = join(process.cwd(), "prisma", "migrations");
const SEVERITY = "20260929090000_severity_high_medium_low";
const WANT: Record<string, string | null> = {
  CRITICAL: "HIGH",
  MAJOR: "HIGH",
  MINOR: "MEDIUM",
  TRIVIAL: "LOW",
  NONE: null,
};

const schema = `sevmig_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
let client: Client;
const sql = (name: string) => readFileSync(join(MIGRATIONS, name, "migration.sql"), "utf8");

const OTHER_COLUMNS = `SELECT id, md5(row_to_json(t)::text) AS h FROM (
  SELECT id, key, number, "projectId", type, title, description, status, priority,
         "assigneeId", "reporterId", "dueDate", "sortIndex", "parentId", "sprintId",
         "testResult", "effortHours", "remainingHours", "completedAt", "createdAt", "updatedAt"
  FROM issue) t ORDER BY id`;

beforeAll(async () => {
  client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET search_path TO "${schema}"`);
  for (const name of readdirSync(MIGRATIONS).filter((d) => /^\d/.test(d)).sort().filter((d) => d < SEVERITY)) {
    await client.query(sql(name));
  }
  await client.query(`INSERT INTO "user"(id,name,email,"updatedAt") VALUES ('u1','U','u@x.io',now())`);
  await client.query(`INSERT INTO project(id,name,key,"createdById","updatedAt") VALUES ('p1','P','PP','u1',now())`);
  let n = 0;
  for (const old of Object.keys(WANT)) {
    for (const type of ["BUG", "TASK"]) {
      n += 1;
      await client.query(
        `INSERT INTO issue(id,key,number,"projectId",type,title,priority,"reporterId",severity,"updatedAt")
         VALUES ($1,$2,$3,'p1',$4::"IssueType",$5,'P1','u1',$6::"Severity",now())`,
        [`i${n}_${old}`, `PP-${n}`, n, type, `Title ${n}`, old === "NONE" ? null : old],
      );
    }
  }
});

afterAll(async () => {
  await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await client.end();
});

describe("the Severity migration", () => {
  it("maps every old value, keeps NULL, and changes nothing else", async () => {
    const before = (await client.query(OTHER_COLUMNS)).rows;

    await client.query(sql(SEVERITY));

    const rows = (await client.query(`SELECT id, severity::text AS s FROM issue ORDER BY id`)).rows;
    expect(rows).toHaveLength(10);
    for (const row of rows) {
      const old = row.id.split("_")[1];
      expect(row.s, `${row.id}`).toBe(WANT[old]);
    }
    expect((await client.query(OTHER_COLUMNS)).rows).toEqual(before);

    const labels = (
      await client.query(
        `SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
         WHERE t.typname = 'Severity' AND t.typnamespace = to_regnamespace('"${schema}"') ORDER BY enumsortorder`,
      )
    ).rows.map((r) => r.enumlabel);
    expect(labels).toEqual(["HIGH", "MEDIUM", "LOW"]);
    expect(
      (await client.query(`SELECT count(*)::int n FROM pg_indexes WHERE indexname='issue_severity_idx' AND schemaname=$1`, [schema]))
        .rows[0].n,
    ).toBe(1);
  });

  it("is a harmless no-op when run again", async () => {
    const snapshot = JSON.stringify((await client.query(`SELECT id, severity::text s FROM issue ORDER BY id`)).rows);
    await client.query(sql(SEVERITY));
    expect(JSON.stringify((await client.query(`SELECT id, severity::text s FROM issue ORDER BY id`)).rows)).toBe(snapshot);
  });
});
