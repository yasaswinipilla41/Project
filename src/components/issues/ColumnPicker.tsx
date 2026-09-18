"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Menu, MenuItem, MenuLabel } from "@/components/ui/Menu";
import { IconChevronDown } from "@/components/ui/Icon";
import {
  COLUMN_COOKIE,
  OPTIONAL_COLUMNS,
  serializeColumnPreference,
  type TableColumnId,
} from "@/lib/tableColumns";

/**
 * Choosing which columns the work item table draws.
 *
 * The table itself is server-rendered and stays that way: this writes a cookie
 * and asks for a fresh render, so the markup that comes back already has the
 * right columns in it. Nothing is hidden in the browser afterwards, which is
 * what keeps the page's sort and page links — and a reader with no JavaScript
 * — working exactly as they did.
 *
 * The cookie is the same arrangement the sidebar's collapsed state uses:
 * written here, read by the page on the way in, and belonging to this browser
 * rather than to a row in a table somebody else could see.
 *
 * Required columns are not offered. Key and Summary are both the link into a
 * work item, and a table with neither is a list nobody can open — the parser
 * puts them back regardless, so there is nothing to gain by listing them.
 */
/**
 * Writes the preference down.
 *
 * Outside the component on purpose: this is a side effect on the document, and
 * keeping it out of the render scope is both what the immutability rule asks
 * for and the honest description of what it is — the component decides, this
 * records.
 *
 * A year, like the sidebar's. `samesite=lax` so it travels on the ordinary
 * navigations this table is made of, and no `secure` flag because Prio is
 * served over plain HTTP in development.
 */
function rememberColumns(columns: readonly TableColumnId[]): void {
  const value = serializeColumnPreference(columns);
  document.cookie = `${COLUMN_COOKIE}=${value}; path=/; max-age=31536000; samesite=lax`;
}

export function ColumnPicker({
  visible,
}: {
  /** What the server just rendered with, so the ticks match the table. */
  visible: readonly TableColumnId[];
}) {
  const router = useRouter();
  const [chosen, setChosen] = useState<Set<TableColumnId>>(new Set(visible));

  function toggle(id: TableColumnId) {
    const next = new Set(chosen);
    if (!next.delete(id)) next.add(id);
    setChosen(next);

    rememberColumns([...next]);

    /* The server draws the table, so the server has to draw it again. */
    router.refresh();
  }

  /* Only the optional ones are counted: "3" beside the control should mean
     three things turned off, not three things that were never negotiable. */
  const hidden = OPTIONAL_COLUMNS.filter((column) => !chosen.has(column.id)).length;

  return (
    <Menu
      align="end"
      width={230}
      label="Columns"
      trigger={(props) => (
        <button
          type="button"
          className="prio-filterchip"
          data-active={hidden > 0 || undefined}
          {...props}
        >
          Columns
          {hidden > 0 ? (
            <span className="prio-filterchip__count">{hidden}</span>
          ) : null}
          <IconChevronDown size={12} />
        </button>
      )}
    >
      <MenuLabel>Columns to show</MenuLabel>
      {OPTIONAL_COLUMNS.map((column) => (
        <MenuItem
          key={column.id}
          keepOpen
          selected={chosen.has(column.id)}
          onSelect={() => toggle(column.id)}
        >
          {column.label}
        </MenuItem>
      ))}
    </Menu>
  );
}
