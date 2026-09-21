"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "@/components/ui/Menu";
import { IconChevronDown, IconInfo, IconRefresh } from "@/components/ui/Icon";
import {
  COLUMN_COOKIE,
  DEFAULT_COLUMNS,
  OPTIONAL_COLUMNS,
  serializeColumnPreference,
  visibleColumnCount,
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

  /*
   * One source of truth, with the tick following the finger.
   *
   * The table is drawn by the server, so what it drew — `visible` — is the
   * truth. Toggling writes the cookie and asks for a fresh render, and the
   * set held here is the optimistic picture in between, so the tick and the
   * count move on the click rather than a round trip later.
   *
   * The moment the server comes back with a different set, that set wins:
   * `rendered` is compared against what was last adopted, and the state is
   * re-seeded during the render React then restarts. Without that the chooser
   * would keep its own answer for the life of the page and could drift from
   * the table it describes — which is the bug this state used to have.
   */
  const rendered = serializeColumnPreference(visible);
  const [chosen, setChosen] = useState<Set<TableColumnId>>(() => new Set(visible));
  const [adopted, setAdopted] = useState(rendered);

  if (adopted !== rendered) {
    setAdopted(rendered);
    setChosen(new Set(visible));
  }

  /**
   * Back to the columns the table draws when nobody has chosen.
   *
   * `DEFAULT_COLUMNS` is the application's own answer, read from the same
   * table definition everything else here reads — not a second list written
   * down beside it, which is how a "default" starts disagreeing with the
   * default. Written through the same cookie and the same refresh a toggle
   * uses, so the ticks, the count and the table all land together.
   */
  function reset() {
    setChosen(new Set(DEFAULT_COLUMNS));
    rememberColumns(DEFAULT_COLUMNS);
    router.refresh();
  }

  function toggle(id: TableColumnId) {
    const next = new Set(chosen);
    if (!next.delete(id)) next.add(id);
    setChosen(next);

    rememberColumns([...next]);

    /* The server draws the table, so the server has to draw it again. */
    router.refresh();
  }

  /*
   * The badge counts the columns that are on, not the ones that are off.
   *
   * It used to show how many optional columns were hidden, so turning a column
   * on made the number go down and a table showing everything had no number at
   * all. It now says what it appears to say: how many columns the table is
   * drawing. `visibleColumnCount` derives it from the same set the table
   * renders from — see `lib/tableColumns`.
   */
  const shown = visibleColumnCount(chosen);
  /* The chip still marks itself active when something is turned off, which is
     what the other filter chips mean by it: this one is not at its default. */
  const hidden = OPTIONAL_COLUMNS.filter((column) => !chosen.has(column.id)).length;
  const optionalOn = OPTIONAL_COLUMNS.length - hidden;

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
          <span className="prio-filterchip__count">{shown}</span>
          <IconChevronDown size={12} />
        </button>
      )}
    >
      <MenuLabel>Columns to show</MenuLabel>

      {/*
        * Why Key and Summary are not on the list.
        *
        * They were always absent — they are the link into a work item, and a
        * table with neither is a list nobody can open — but absence explains
        * nothing. Somebody looking for Key and failing to find it cannot tell
        * a deliberate rule from a missing row, so the rule is stated where
        * the row would have been.
        */}
      <p className="prio-menu__note">
        <IconInfo size={14} />
        <span>Key and Summary are always visible and cannot be hidden.</span>
      </p>

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

      <MenuSeparator />

      {/*
        * How many of the optional columns are on, and the way back.
        *
        * `role="menuitem"` on a real button rather than a `MenuItem`, because
        * this is not one of the things being chosen between and should not
        * look like one — but the menu's arrow keys walk exactly that role, so
        * without it the control would be reachable by mouse alone: Tab closes
        * the menu, and the arrows would step straight past it.
        */}
      <div className="prio-menu__footer">
        <span className="prio-menu__footertext">
          {optionalOn} of {OPTIONAL_COLUMNS.length} selected
        </span>
        <button
          type="button"
          role="menuitem"
          /* Stays open, the same way the column toggles do: what Reset did is
             nine ticks coming back, and a menu that shuts on the click hides
             its own result. */
          data-menu-keep-open
          className="prio-btn prio-btn--secondary prio-btn--sm"
          onClick={reset}
        >
          <IconRefresh size={13} />
          Reset to default
        </button>
      </div>
    </Menu>
  );
}
