/**
 * The spreadsheet the importer is waiting for: its columns, and what each one
 * accepts.
 *
 * Somebody importing work for the first time has to guess two things: what the
 * columns are called, and which of them they cannot leave out. Both are
 * already decided — by `server/issueImport`, which matches headers by name —
 * so guessing is unnecessary, and a wrong guess costs a round trip through an
 * error message. The downloaded template hands them the answer.
 *
 * **This file is the one list.** The parser reads its header names from here
 * and the template writer reads them from here, so the sheet on offer and the
 * sheet that is accepted cannot drift apart: a column added below is offered
 * and read, a column removed is neither. `tests/import-template.test.ts` holds
 * the list to the eight the feature is specified with.
 *
 * Headers only, and no example row. A sample would have to carry a real
 * member's name and a real parent to survive validation — and somebody who
 * filled in the rows around it and imported would file the sample as work. An
 * empty sheet cannot do that. What a column accepts is said where it is
 * needed instead: on the header, as a note, and in the cell, as a drop-down.
 *
 * There is deliberately no project column. The project is whichever one the
 * person opened Import from, and nothing in the file can say otherwise.
 */

import {
  DEFAULT_PRIORITY,
  ISSUE_STATUSES,
  ISSUE_TYPES,
  ISSUE_TYPE_LABEL,
  PRIORITIES,
  PRIORITY_LABEL,
  SEVERITIES,
  SEVERITY_LABEL,
  STATUS_LABEL,
} from "@/lib/domain";

/** The columns the importer reads, by the name a spreadsheet must give them. */
export const IMPORT_COLUMNS = {
  summary: "Summary",
  description: "Description",
  issueType: "Issue Type",
  status: "Status",
  priority: "Priority",
  assignee: "Assignee",
  severity: "Severity",
  parentIssue: "Parent Issue",
} as const;

/** Required: a row without these is refused. */
export const TEMPLATE_REQUIRED = [IMPORT_COLUMNS.summary] as const;

/** Used when present, left to their defaults when blank. */
export const TEMPLATE_OPTIONAL = [
  IMPORT_COLUMNS.description,
  IMPORT_COLUMNS.issueType,
  IMPORT_COLUMNS.status,
  IMPORT_COLUMNS.priority,
  IMPORT_COLUMNS.assignee,
  IMPORT_COLUMNS.severity,
  IMPORT_COLUMNS.parentIssue,
] as const;

/** Every column, in the order the template lays them out. */
export const TEMPLATE_HEADERS: readonly string[] = [
  ...TEMPLATE_REQUIRED,
  ...TEMPLATE_OPTIONAL,
];

/** What the downloaded file is called. */
export const TEMPLATE_FILENAME = "prio-work-items-template.xlsx";

/** The worksheet the importer reads and the template writes. */
export const TEMPLATE_SHEET = "Work items";

/**
 * Spreadsheets arrive from people, so these are ceilings rather than limits.
 * Here rather than in the parser because the template also needs the row
 * count — its drop-downs are applied down to the last row that can import.
 */
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 500;

/** What "Status" is when a row leaves it blank — the label on screen. */
export const DEFAULT_STATUS_LABEL = STATUS_LABEL.TODO;

/**
 * Wide enough to read the header in, and to type an answer under it.
 *
 * Description widest, because it is the one that holds a sentence.
 */
export const TEMPLATE_WIDTHS: Record<string, number> = {
  [IMPORT_COLUMNS.summary]: 40,
  [IMPORT_COLUMNS.description]: 48,
  [IMPORT_COLUMNS.issueType]: 14,
  [IMPORT_COLUMNS.status]: 22,
  [IMPORT_COLUMNS.priority]: 12,
  [IMPORT_COLUMNS.assignee]: 26,
  [IMPORT_COLUMNS.severity]: 12,
  [IMPORT_COLUMNS.parentIssue]: 16,
};

/**
 * The words a drop-down offers, spelled the way the app spells them.
 *
 * Built from the same label tables the screens read, so a status renamed on
 * screen is renamed in the template. The importer also accepts the underlying
 * names (`IN_PROGRESS`), but the list offers the labels because that is what
 * somebody has seen.
 */
export const TEMPLATE_CHOICES: Record<string, readonly string[]> = {
  [IMPORT_COLUMNS.issueType]: ISSUE_TYPES.map((t) => ISSUE_TYPE_LABEL[t]),
  /* New first: it is what a blank cell means, and a list opens on its first
     entry. */
  [IMPORT_COLUMNS.status]: [
    DEFAULT_STATUS_LABEL,
    ...ISSUE_STATUSES.filter((s) => s !== "TODO").map((s) => STATUS_LABEL[s]),
  ],
  [IMPORT_COLUMNS.priority]: PRIORITIES.map((p) => PRIORITY_LABEL[p]),
  [IMPORT_COLUMNS.severity]: SEVERITIES.map((s) => SEVERITY_LABEL[s]),
};

/** What hovering a header says, for the columns that are not self-evident. */
export const TEMPLATE_NOTES: Record<string, string> = {
  [IMPORT_COLUMNS.summary]:
    "Required. The work item's title, 3 to 200 characters.",
  [IMPORT_COLUMNS.description]: "Optional. Free text.",
  [IMPORT_COLUMNS.issueType]: "Optional. Leave blank for Task.",
  [IMPORT_COLUMNS.status]: `Optional. Leave blank for ${DEFAULT_STATUS_LABEL}.`,
  [IMPORT_COLUMNS.priority]: `Optional. Leave blank for ${PRIORITY_LABEL[DEFAULT_PRIORITY]}.`,
  [IMPORT_COLUMNS.assignee]:
    "Optional. The name or email of a member of this project.",
  [IMPORT_COLUMNS.severity]: "Optional. Bug rows only.",
  [IMPORT_COLUMNS.parentIssue]:
    "Optional. The key of an existing work item in this project, e.g. ENG-12.",
};
