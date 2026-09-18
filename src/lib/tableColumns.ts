/**
 * Which columns the work item table shows, and how that choice travels.
 *
 * The table is server-rendered on purpose — sorting and paging are links, and
 * the list works with no JavaScript at all. A column chooser held in React
 * state would quietly undo that: the server would render eleven columns and
 * the browser would hide some afterwards, so the markup would no longer be the
 * answer, and somebody without JavaScript would get a chooser that does
 * nothing.
 *
 * So the choice lives in a cookie. The server reads it while rendering and
 * emits only the columns that were asked for; the chooser writes it and asks
 * for a fresh render. That keeps the rendered table the source of truth, keeps
 * every sort and page link working exactly as before, and costs no database
 * column — the same arrangement the sidebar's collapsed state already uses.
 */

export const COLUMN_COOKIE = "prio.issues.columns";

/**
 * Every column the table can draw, in the order it draws them.
 *
 * `id` is what the cookie carries and must stay stable; `label` is what both
 * the header and the chooser say, so the two can never disagree about what a
 * column is called.
 */
export const TABLE_COLUMNS = [
  { id: "key", label: "Key", required: true },
  { id: "title", label: "Summary", required: true },
  { id: "status", label: "Status", required: false },
  { id: "priority", label: "Priority", required: false },
  { id: "assignee", label: "Assignee", required: false },
  { id: "reporter", label: "Reporter", required: false },
  { id: "completedBy", label: "Completed by", required: false },
  { id: "completed", label: "Completed", required: false },
  { id: "due", label: "Due", required: false },
  { id: "updated", label: "Updated", required: false },
  { id: "actions", label: "", required: true },
] as const;

export type TableColumnId = (typeof TABLE_COLUMNS)[number]["id"];

/**
 * The two that cannot be turned off, and why.
 *
 * Key and Summary are both links to the work item, and a table with neither is
 * a list of rows nobody can open. The actions cell carries the row menu and has
 * no header to offer in a chooser. Marking them here rather than trusting the
 * chooser to omit them means a hand-edited cookie cannot produce a table with
 * no way out of it.
 */
export const REQUIRED_COLUMNS: readonly TableColumnId[] = TABLE_COLUMNS.filter(
  (column) => column.required,
).map((column) => column.id);

/** What the table showed before it could be customised, and still shows by default. */
export const DEFAULT_COLUMNS: readonly TableColumnId[] = TABLE_COLUMNS.map(
  (column) => column.id,
);

/** The columns somebody may actually choose between. */
export const OPTIONAL_COLUMNS = TABLE_COLUMNS.filter(
  (column) => !column.required,
);

function isColumnId(value: string): value is TableColumnId {
  return TABLE_COLUMNS.some((column) => column.id === value);
}

/**
 * Reads a cookie value into a set of columns to draw.
 *
 * Anything unrecognised is dropped rather than rejected — a cookie written by
 * an older version of this list, or edited by hand, should cost somebody a
 * column preference and never a usable table. An absent or empty value means
 * "no preference", which is the full default set rather than an empty table.
 *
 * The required columns are added back whatever the cookie says, so there is no
 * value of this cookie that produces rows nobody can open.
 */
export function parseColumnPreference(
  raw: string | undefined | null,
): readonly TableColumnId[] {
  if (!raw) return DEFAULT_COLUMNS;

  const chosen = new Set(
    raw
      .split(",")
      .map((part) => part.trim())
      .filter((part): part is TableColumnId => part.length > 0 && isColumnId(part)),
  );

  if (chosen.size === 0) return DEFAULT_COLUMNS;

  for (const id of REQUIRED_COLUMNS) chosen.add(id);

  /* Emitted in the table's own order rather than the cookie's, so a reordered
     cookie cannot reorder the table. */
  return TABLE_COLUMNS.filter((column) => chosen.has(column.id)).map(
    (column) => column.id,
  );
}

/** The cookie value for a chosen set. */
export function serializeColumnPreference(
  columns: readonly TableColumnId[],
): string {
  const chosen = new Set(columns);
  for (const id of REQUIRED_COLUMNS) chosen.add(id);
  return TABLE_COLUMNS.filter((column) => chosen.has(column.id))
    .map((column) => column.id)
    .join(",");
}
