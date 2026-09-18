import { describe, expect, it } from "vitest";
import {
  DEFAULT_COLUMNS,
  OPTIONAL_COLUMNS,
  REQUIRED_COLUMNS,
  TABLE_COLUMNS,
  parseColumnPreference,
  serializeColumnPreference,
} from "@/lib/tableColumns";

/**
 * Which columns the work item table draws.
 *
 * The cookie behind this is written by a browser and can therefore arrive in
 * any shape at all — stale after the column list changes, truncated, reordered,
 * or edited by hand. The one thing no value of it may produce is a table
 * nobody can open, which is what most of this file is about.
 */

describe("reading a stored preference", () => {
  it("shows everything when nothing was ever chosen", () => {
    expect(parseColumnPreference(undefined)).toEqual(DEFAULT_COLUMNS);
    expect(parseColumnPreference(null)).toEqual(DEFAULT_COLUMNS);
    expect(parseColumnPreference("")).toEqual(DEFAULT_COLUMNS);
  });

  it("keeps the columns that were chosen", () => {
    const chosen = parseColumnPreference("key,title,status,actions");
    expect(chosen).toContain("status");
    expect(chosen).not.toContain("priority");
    expect(chosen).not.toContain("updated");
  });

  it("puts back the columns that cannot be turned off", () => {
    /* The claim the whole thing rests on: Key and Summary are the link into a
       work item, so no cookie may take them away. */
    const chosen = parseColumnPreference("status");
    for (const id of REQUIRED_COLUMNS) {
      expect(chosen, `${id} survives`).toContain(id);
    }
  });

  it("ignores names it does not recognise rather than giving up", () => {
    /* A cookie written before a column was renamed should cost a preference,
       never a usable table. */
    const chosen = parseColumnPreference("key,title,actions,nonsense,status");
    expect(chosen).toContain("status");
    expect(chosen).not.toContain("nonsense" as never);
  });

  it("falls back to everything when nothing in it is recognisable", () => {
    expect(parseColumnPreference("nonsense,rubbish")).toEqual(DEFAULT_COLUMNS);
  });

  it("draws columns in the table's order, not the cookie's", () => {
    /* Otherwise a reordered cookie would reorder the table, and the header row
       would stop matching the cells beneath it. */
    const chosen = parseColumnPreference("updated,status,title,key,actions");
    const order = TABLE_COLUMNS.map((c) => c.id).filter((id) =>
      chosen.includes(id),
    );
    expect(chosen).toEqual(order);
  });

  it("tolerates spacing around the names", () => {
    expect(parseColumnPreference(" key , title , status , actions ")).toContain(
      "status",
    );
  });
});

describe("writing a preference down", () => {
  it("round-trips a chosen set", () => {
    const chosen = parseColumnPreference("key,title,status,actions");
    expect(parseColumnPreference(serializeColumnPreference(chosen))).toEqual(
      chosen,
    );
  });

  it("writes the required columns even when asked not to", () => {
    const written = serializeColumnPreference(["status"]);
    for (const id of REQUIRED_COLUMNS) {
      expect(written.split(",")).toContain(id);
    }
  });

  it("writes an empty choice as just the required ones", () => {
    const written = serializeColumnPreference([]);
    expect(written.split(",").sort()).toEqual([...REQUIRED_COLUMNS].sort());
  });
});

describe("the column list itself", () => {
  it("offers every column that is not required", () => {
    expect(OPTIONAL_COLUMNS.length).toBe(
      TABLE_COLUMNS.length - REQUIRED_COLUMNS.length,
    );
    for (const column of OPTIONAL_COLUMNS) {
      expect(REQUIRED_COLUMNS).not.toContain(column.id);
    }
  });

  it("gives every offered column something to call it", () => {
    /* The actions cell has no header and is required, so it is never offered;
       anything the chooser does list has to have a name on it. */
    for (const column of OPTIONAL_COLUMNS) {
      expect(column.label.length).toBeGreaterThan(0);
    }
  });

  it("has no duplicate ids", () => {
    const ids = TABLE_COLUMNS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
