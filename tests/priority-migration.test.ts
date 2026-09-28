import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";

/**
 * The Priority migration, run for real against every legacy value.
 *
 * Builds the database as it was *before* the migration — every earlier
 * migration applied, in order — inside a throwaway schema (so it can never
 * touch the tables the rest of the suite uses), fills it with one issue per old
 * priority, runs the migration, and checks what came out.
 *
 *   URGENT -> P0    HIGH -> P1    MEDIUM -> P2    LOW -> P3    NONE -> P3
 *
 * and that nothing else moved.
 */

const MIGRATIONS = join(process.cwd(), "prisma", "migrations");
const PRIORITY = "20260928120000_priority_p0_p3";
const TEAM_RENAME = "20260928130000_rename_testing_team_to_qa";

const WANT: Record<string, string> = {
  URGENT: "P0",
  HIGH: "P1",
  MEDIUM: "P2",
  LOW: "P3",
  NONE: "P3",
};

const schema = `migtest_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
let client: Client;

const sql = (name: string) => readFileSync(join(MIGRATIONS, name, "migration.sql"), "utf8");

/** Everything about an issue except its priority, as one comparable string. */
const OTHER_COLUMNS = `SELECT id, md5(row_to_json(t)::text) AS h FROM (
  SELECT id, key, number, "projectId", type, title, description, status, severity,
         "assigneeId", "reporterId", "dueDate", "sortIndex", "parentId", "sprintId",
         "testResult", "effortHours", "remainingHours", "completedAt", "createdAt", "updatedAt"
  FROM issue) t ORDER BY id`;

beforeAll(async () => {
  client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET search_path TO "${schema}"`);

  const earlier = readdirSync(MIGRATIONS)
    .filter((d) => /^\d/.test(d))
    .sort()
    .filter((d) => d < PRIORITY);
  for (const name of earlier) await client.query(sql(name));

  await client.query(
    `INSERT INTO "user"(id,name,email,"updatedAt") VALUES ('u1','U','u@x.io',now())`,
  );
  await client.query(
    `INSERT INTO project(id,name,key,"createdById","updatedAt") VALUES ('p1','P','PP','u1',now())`,
  );
  let n = 0;
  for (const legacy of Object.keys(WANT)) {
    for (let copy = 0; copy < 2; copy++) {
      n += 1;
      await client.query(
        `INSERT INTO issue(id,key,number,"projectId",title,description,priority,"reporterId",severity,"sortIndex","updatedAt")
         VALUES ($1,$2,$3,'p1',$4,$5,$6::"Priority",'u1',$7::"Severity",$8,now())`,
        [`i${n}`, `PP-${n}`, n, `Title ${n}`, `Description ${n}`, legacy, n % 2 ? "MAJOR" : null, n * 1.5],
      );
    }
  }
});

afterAll(async () => {
  await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await client.end();
});

describe("the Priority migration", () => {
  it("maps every legacy value, changes nothing else, and is safe to run only once", async () => {
    const before = (await client.query(OTHER_COLUMNS)).rows;
    const usersBefore = (await client.query(`SELECT count(*)::int n FROM "user"`)).rows[0].n;

    await client.query(sql(PRIORITY));

    // 1. Each old value became the approved new one.
    const rows = (await client.query(`SELECT id, priority::text AS p FROM issue ORDER BY id`)).rows;
    const legacyOf = (id: string) => Object.keys(WANT)[Math.floor((Number(id.slice(1)) - 1) / 2)]!;
    for (const row of rows) {
      expect(row.p, `${row.id} (${legacyOf(row.id)})`).toBe(WANT[legacyOf(row.id)]);
    }

    // 2. P0 appears only where URGENT was: nothing else was promoted to it.
    const p0 = rows.filter((r) => r.p === "P0").map((r) => legacyOf(r.id));
    expect(new Set(p0)).toEqual(new Set(["URGENT"]));

    // 3. Unrelated fields, other tables, and row counts are untouched.
    expect((await client.query(OTHER_COLUMNS)).rows).toEqual(before);
    expect(rows).toHaveLength(10);
    expect((await client.query(`SELECT count(*)::int n FROM "user"`)).rows[0].n).toBe(usersBefore);

    // 4. The type is exactly P0..P3, the old one is gone, the default is P2.
    const labels = (
      await client.query(
        `SELECT enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
         WHERE t.typname = 'Priority' AND t.typnamespace = to_regnamespace('"${schema}"') ORDER BY enumsortorder`,
      )
    ).rows.map((r) => r.enumlabel);
    expect(labels).toEqual(["P0", "P1", "P2", "P3"]);
    expect(
      (await client.query(`SELECT count(*)::int n FROM pg_type WHERE typname IN ('Priority_old','Priority_new')`))
        .rows[0].n,
    ).toBe(0);

    await client.query(
      `INSERT INTO issue(id,key,number,"projectId",title,"reporterId","updatedAt") VALUES ('dflt','PP-99',99,'p1','d','u1',now())`,
    );
    expect((await client.query(`SELECT priority::text p FROM issue WHERE id='dflt'`)).rows[0].p).toBe("P2");
    await client.query(`DELETE FROM issue WHERE id='dflt'`);

    // 5. The index survived the retype.
    expect(
      (await client.query(`SELECT count(*)::int n FROM pg_indexes WHERE indexname='issue_priority_idx' AND schemaname = $1`, [schema]))
        .rows[0].n,
    ).toBe(1);

    // 6. Running it again fails as a whole and moves nothing: P1 never becomes P2.
    const snapshot = JSON.stringify((await client.query(`SELECT id, priority::text p FROM issue ORDER BY id`)).rows);
    await expect(client.query(sql(PRIORITY))).rejects.toThrow();
    await client.query("ROLLBACK").catch(() => undefined);
    expect(JSON.stringify((await client.query(`SELECT id, priority::text p FROM issue ORDER BY id`)).rows)).toBe(snapshot);
  });

  it("keeps existing P0-P3 rows as they are when new work is added afterwards", async () => {
    await client.query(
      `INSERT INTO issue(id,key,number,"projectId",title,priority,"reporterId","updatedAt") VALUES ('after','PP-100',100,'p1','after','P1','u1',now())`,
    );
    expect((await client.query(`SELECT priority::text p FROM issue WHERE id='after'`)).rows[0].p).toBe("P1");
  });
});

describe("the QA team rename", () => {
  it("renames only the display name, never the slug, and only when it is safe", async () => {
    const teams = async () => (await client.query(`SELECT slug, name, id, description FROM team ORDER BY slug`)).rows;
    const before = await teams();
    expect(before.find((t) => t.slug === "testing")!.name).toBe("Testing");

    await client.query(sql(TEAM_RENAME));
    const after = await teams();

    const testing = after.find((t) => t.slug === "testing")!;
    expect(testing.name).toBe("QA Team");
    // Same row: the id and slug authorization keys on are untouched.
    expect(testing.id).toBe(before.find((t) => t.slug === "testing")!.id);
    // Every other team is exactly as it was.
    expect(after.filter((t) => t.slug !== "testing")).toEqual(before.filter((t) => t.slug !== "testing"));

    // Again: nothing more to do, nothing breaks.
    await client.query(sql(TEAM_RENAME));
    expect((await teams()).find((t) => t.slug === "testing")!.name).toBe("QA Team");
  });

  it("leaves a name an administrator already changed, and never collides", async () => {
    await client.query(`UPDATE team SET name = 'Quality' WHERE slug = 'testing'`);
    await client.query(sql(TEAM_RENAME));
    expect((await client.query(`SELECT name FROM team WHERE slug='testing'`)).rows[0].name).toBe("Quality");

    await client.query(`UPDATE team SET name = 'Testing' WHERE slug = 'testing'`);
    await client.query(`INSERT INTO team(id,slug,name,"updatedAt") VALUES ('other','other','QA Team',now())`);
    await client.query(sql(TEAM_RENAME));
    expect((await client.query(`SELECT name FROM team WHERE slug='testing'`)).rows[0].name).toBe("Testing");
  });

  it("does not rewrite stored notifications or any text but the team's own", async () => {
    // The rename touches the "team" table alone; notification text is history.
    const migration = sql(TEAM_RENAME).replace(/--.*$/gm, "");
    expect(migration).not.toMatch(/notification/i);
    expect(migration).not.toMatch(/activity_log_entry/i);
    expect(migration).not.toMatch(/UPDATE\s+"(?!team")/i);
  });
});
