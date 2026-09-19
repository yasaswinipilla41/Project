import { describe, expect, it } from "vitest";
import {
  DEFAULT_COLUMNS,
  OPTIONAL_COLUMNS,
  REQUIRED_COLUMNS,
  TABLE_COLUMNS,
  parseColumnPreference,
  serializeColumnPreference,
  visibleColumnCount,
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

describe("counting the columns on screen", () => {
  it("counts what is shown, never what is hidden", () => {
    /* The bug this replaces: the badge counted the columns that were turned
       off, so turning one on made the number go down. */
    const chosen = parseColumnPreference("key,title,status,actions");
    expect(visibleColumnCount(chosen)).toBe(3);
  });

  it("counts the whole default set when nothing was chosen", () => {
    /* Every column except the actions cell, which has no header to count. */
    expect(visibleColumnCount(DEFAULT_COLUMNS)).toBe(TABLE_COLUMNS.length - 1);
    expect(visibleColumnCount(DEFAULT_COLUMNS)).toBe(
      OPTIONAL_COLUMNS.length + REQUIRED_COLUMNS.length - 1,
    );
  });

  it("goes up by one when a column is turned on", () => {
    const before = parseColumnPreference("key,title,actions");
    const after = parseColumnPreference("key,title,actions,priority");
    expect(visibleColumnCount(after)).toBe(visibleColumnCount(before) + 1);
  });

  it("goes down by one when a column is turned off", () => {
    const before = parseColumnPreference("key,title,actions,priority,status");
    const after = parseColumnPreference("key,title,actions,status");
    expect(visibleColumnCount(after)).toBe(visibleColumnCount(before) - 1);
  });

  it("never falls below the columns that cannot be turned off", () => {
    /* A cookie asking for nothing still draws Key and Summary, so the badge
       may not read nought while a table is on screen. */
    const chosen = parseColumnPreference(serializeColumnPreference([]));
    expect(visibleColumnCount(chosen)).toBe(REQUIRED_COLUMNS.length - 1);
    expect(visibleColumnCount(chosen)).toBeGreaterThan(0);
  });

  it("leaves the unnamed actions cell out of the count", () => {
    const withActions = visibleColumnCount(["key", "title", "actions"]);
    const without = visibleColumnCount(["key", "title"]);
    expect(withActions).toBe(without);
  });

  it("ignores names the table does not draw", () => {
    /* A stale cookie may still be in a browser; the badge counts the columns
       that exist, in step with the table, which draws the same set. */
    const chosen = parseColumnPreference("key,title,actions,nonsense,status");
    expect(visibleColumnCount(chosen)).toBe(3);
    expect(visibleColumnCount(["key", "nonsense" as never])).toBe(1);
  });

  it("agrees with the table for every preference that can be stored", () => {
    /* The property the badge rests on: whatever the cookie says, the number
       equals the headers the table will draw. */
    for (const column of OPTIONAL_COLUMNS) {
      const chosen = parseColumnPreference(
        serializeColumnPreference([column.id]),
      );
      const drawn = TABLE_COLUMNS.filter(
        (c) => chosen.includes(c.id) && c.label !== "",
      ).length;
      expect(visibleColumnCount(chosen), column.id).toBe(drawn);
    }
  });
});
