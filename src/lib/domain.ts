import type {
  IssueStatus,
  IssueType,
  Priority,
  Role,
  Severity,
  TestResult,
} from "@prisma/client";

/**
 * The fixed Prio vocabulary. Every label, order and colour decision for
 * statuses, priorities, severities and issue types is resolved from here so the
 * board, table, filters, reports and detail page can never disagree.
 */

// ------------------------------------------------------------------ status

export const ISSUE_STATUSES = [
  "BACKLOG",
  "TODO",
  "IN_PROGRESS",
  "IN_REVIEW",
  "IN_QA",
  "DONE",
  "REOPENED",
  "REJECTED",
  "CANCELLED",
] as const satisfies readonly IssueStatus[];

export const STATUS_LABEL: Record<IssueStatus, string> = {
  BACKLOG: "Backlog",
  TODO: "New",
  IN_PROGRESS: "In Progress",
  IN_REVIEW: "Ready for QA",
  IN_QA: "In QA",
  DONE: "Done",
  REOPENED: "Reopen",
  REJECTED: "Reject / Not an Issue",
  CANCELLED: "Cancelled",
};

/** Statuses that take an issue out of active work. */
export const CLOSED_STATUSES = ["DONE", "REJECTED", "CANCELLED"] as const satisfies
  readonly IssueStatus[];

/* IN_QA is open work: it is being tested, which is not the same as finished.
   Only DONE and CANCELLED close an issue. */
export const OPEN_STATUSES = [
  "BACKLOG",
  "TODO",
  "IN_PROGRESS",
  "IN_REVIEW",
  "IN_QA",
  /* Reopened work is open again by definition -- that is the whole point of
     reopening it. */
  "REOPENED",
] as const satisfies readonly IssueStatus[];

export function isClosedStatus(status: IssueStatus): boolean {
  return (CLOSED_STATUSES as readonly IssueStatus[]).includes(status);
}

/* ------------------------------------------------------- status workflow */

/**
 * Which statuses an issue may move to, from each status it can be in.
 *
 * One declaration, read by everything that can change a status: the issue
 * page's status menu, the Flow Board's drag and drop, the "submit for review"
 * button, and `updateIssue` on the server. Any of those disagreeing with the
 * others is the bug this exists to prevent, so none of them carries rules of
 * its own.
 *
 * The shape of the workflow, and why:
 *
 *   Backlog ⇄ Todo → In Progress → Ready for QA → In QA → Done
 *
 *  - **Done is only reachable from Ready for QA or In QA.** Work does not
 *    finish without someone other than its author having had the chance to
 *    look at it, which is the point of having those states at all. This is the
 *    rule that makes the workflow more than decoration.
 *  - **Todo may go straight to Ready for QA.** Not every task needs a spell in
 *    In Progress, and forcing a flip through it teaches people to lie to the
 *    board.
 *  - **Anything open may be cancelled**, and anything closed may be reopened.
 *    Work is abandoned and resurrected for reasons a workflow cannot know.
 *  - **Backlog cannot jump to review**: something nobody has picked up has no
 *    work to review.
 *
 * Creation is not a transition and is not restricted here — an issue may be
 * created in whatever status the person filing it says it is in.
 */
export const STATUS_TRANSITIONS: Record<IssueStatus, readonly IssueStatus[]> = {
  BACKLOG: ["TODO", "IN_PROGRESS", "REJECTED", "CANCELLED"],
  TODO: ["IN_PROGRESS", "IN_REVIEW", "BACKLOG", "REJECTED", "CANCELLED"],
  IN_PROGRESS: ["IN_REVIEW", "TODO", "BACKLOG", "REJECTED", "CANCELLED"],
  IN_REVIEW: ["IN_QA", "DONE", "IN_PROGRESS", "REJECTED", "CANCELLED"],
  IN_QA: ["DONE", "IN_REVIEW", "IN_PROGRESS", "REJECTED", "CANCELLED"],
  /* Finished work does not go back to being in progress by pretending it was
     never finished -- it is reopened, which says so. */
  DONE: ["REOPENED", "IN_PROGRESS", "CANCELLED"],
  REOPENED: ["IN_PROGRESS", "TODO", "IN_REVIEW", "DONE", "REJECTED", "CANCELLED"],
  REJECTED: ["REOPENED", "BACKLOG", "TODO"],
  CANCELLED: ["BACKLOG", "TODO", "REOPENED"],
};

/**
 * May this issue move from `from` to `to`?
 *
 * Staying put is always allowed: saving a form without touching the status is
 * not a transition, and treating it as one would refuse edits to every other
 * field on an issue whose status happens to be a dead end.
 */
export function canTransition(from: IssueStatus, to: IssueStatus): boolean {
  if (from === to) return true;
  return STATUS_TRANSITIONS[from].includes(to);
}

/** Where this issue may go next, in the board's own order. */
export function allowedTransitions(from: IssueStatus): IssueStatus[] {
  return ISSUE_STATUSES.filter((status) => canTransition(from, status));
}

/** Ordinal used for sorting; matches the board column order. */
export function statusOrder(status: IssueStatus): number {
  return ISSUE_STATUSES.indexOf(status);
}

// ---------------------------------------------------------------- priority

export const PRIORITIES = [
  "URGENT",
  "HIGH",
  "MEDIUM",
  "LOW",
  "NONE",
] as const satisfies readonly Priority[];

export const PRIORITY_LABEL: Record<Priority, string> = {
  URGENT: "Urgent",
  HIGH: "High",
  MEDIUM: "Medium",
  LOW: "Low",
  NONE: "None",
};

/** Descending weight — higher sorts first. */
export const PRIORITY_WEIGHT: Record<Priority, number> = {
  URGENT: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
  NONE: 0,
};

// ---------------------------------------------------------------- severity

export const SEVERITIES = [
  "CRITICAL",
  "MAJOR",
  "MINOR",
  "TRIVIAL",
] as const satisfies readonly Severity[];

/* ------------------------------------------------------------ QA result */

export const TEST_RESULTS = [
  "NOT_TESTED",
  "PASSED",
  "FAILED",
  "BLOCKED",
] as const satisfies readonly TestResult[];

export const TEST_RESULT_LABEL: Record<TestResult, string> = {
  NOT_TESTED: "Not tested",
  PASSED: "Passed",
  FAILED: "Failed",
  BLOCKED: "Blocked",
};

/** What each verdict means, for the control's own tooltip. */
export const TEST_RESULT_DESCRIPTION: Record<TestResult, string> = {
  NOT_TESTED: "Nobody has verified this yet.",
  PASSED: "Verified working — the change does what it should.",
  FAILED: "Verified broken — it needs another pass from the assignee.",
  BLOCKED: "Could not be tested; something is in the way.",
};

/** The two verdicts that put the ball back in the assignee's court. */
export function needsDeveloperAttention(result: TestResult): boolean {
  return result === "FAILED" || result === "BLOCKED";
}

export function isTestResult(value: string): value is TestResult {
  return (TEST_RESULTS as readonly string[]).includes(value);
}

export const SEVERITY_LABEL: Record<Severity, string> = {
  CRITICAL: "Critical",
  MAJOR: "Major",
  MINOR: "Minor",
  TRIVIAL: "Trivial",
};

export const SEVERITY_WEIGHT: Record<Severity, number> = {
  CRITICAL: 4,
  MAJOR: 3,
  MINOR: 2,
  TRIVIAL: 1,
};

/**
 * Severity describes impact, priority describes scheduling urgency. They are
 * deliberately independent — a Critical bug can carry Low priority and vice
 * versa. Nothing in Prio derives one from the other.
 */
export const SEVERITY_DESCRIPTION: Record<Severity, string> = {
  CRITICAL: "Blocks core work or loses data. No workaround.",
  MAJOR: "A key function is broken. A workaround exists.",
  MINOR: "Limited impact on a non-critical path.",
  TRIVIAL: "Cosmetic or very low impact.",
};

// -------------------------------------------------------------- issue type

/**
 * The labels every project starts with.
 *
 * Labels are project-scoped — `@@unique([projectId, name])` — so these are not
 * a global vocabulary but a set created per project. Names are lower case
 * because that is what the existing labels already use: adding "Backend"
 * beside an existing "backend" would satisfy the unique constraint and leave
 * the project holding both, which is the duplication this is meant to avoid.
 */
export const DEFAULT_PROJECT_LABELS: { name: string; color: string }[] = [
  { name: "frontend", color: "#3B82F6" },
  { name: "backend", color: "#3B82F6" },
  { name: "qa", color: "#0D9488" },
  { name: "auth", color: "#E5484D" },
  { name: "api", color: "#8B5CF6" },
  { name: "performance", color: "#F0961F" },
  { name: "regression", color: "#0D9488" },
  { name: "onboarding", color: "#14A06D" },
  { name: "access", color: "#6B7C98" },
  { name: "reporting", color: "#8B5CF6" },
  { name: "content", color: "#8B5CF6" },
  { name: "seo", color: "#14A06D" },
  { name: "accessibility", color: "#F0961F" },
];

export const ISSUE_TYPES = [
  "EPIC",
  "FEATURE",
  "STORY",
  "TASK",
  "BUG",
] as const satisfies readonly IssueType[];

export const ISSUE_TYPE_LABEL: Record<IssueType, string> = {
  EPIC: "Epic",
  FEATURE: "Feature",
  STORY: "Story",
  TASK: "Task",
  BUG: "Bug",
};

/*
 * Epic and Feature are flat types for now: they classify work, they do not
 * nest it. Prio still allows exactly one level of sub-issues, and that model
 * is deliberately untouched — an Epic cannot yet contain Features the way a
 * hierarchy would. The wording below says only what is true today.
 */
export const ISSUE_TYPE_DESCRIPTION: Record<IssueType, string> = {
  EPIC: "A large body of work that groups related delivery.",
  FEATURE: "A distinct piece of functionality being delivered.",
  STORY: "A user-facing capability described from the user's perspective.",
  TASK: "A unit of work to be completed.",
  BUG: "A defect with reproduction steps and expected vs actual behaviour.",
};

export function isBug(type: IssueType): boolean {
  return type === "BUG";
}

// -------------------------------------------------------------------- role

export const ROLE_LABEL: Record<Role, string> = {
  ADMIN: "Admin",
  MEMBER: "Member",
};

export const ROLE_DESCRIPTION: Record<Role, string> = {
  ADMIN: "Full access. Manages projects, members, invitations and settings.",
  MEMBER: "Works in assigned projects. Creates and updates issues and bugs.",
};

// ------------------------------------------------------------------ guards

export function isIssueStatus(value: unknown): value is IssueStatus {
  return (
    typeof value === "string" &&
    (ISSUE_STATUSES as readonly string[]).includes(value)
  );
}

export function isPriority(value: unknown): value is Priority {
  return (
    typeof value === "string" && (PRIORITIES as readonly string[]).includes(value)
  );
}

export function isSeverity(value: unknown): value is Severity {
  return (
    typeof value === "string" && (SEVERITIES as readonly string[]).includes(value)
  );
}

export function isIssueType(value: unknown): value is IssueType {
  return (
    typeof value === "string" && (ISSUE_TYPES as readonly string[]).includes(value)
  );
}

// ------------------------------------------------------------ presentation

/**
 * Human label for any enum value that reaches the activity feed, where the
 * field name is dynamic and the value arrives as a string.
 */
export function humanizeEnumValue(field: string, value: string | null): string {
  if (value === null || value === "") return "None";
  switch (field) {
    case "status":
      return isIssueStatus(value) ? STATUS_LABEL[value] : value;
    case "priority":
      return isPriority(value) ? PRIORITY_LABEL[value] : value;
    case "severity":
      return isSeverity(value) ? SEVERITY_LABEL[value] : value;
    case "type":
      return isIssueType(value) ? ISSUE_TYPE_LABEL[value] : value;
    case "testResult":
      return isTestResult(value) ? TEST_RESULT_LABEL[value] : value;
    default:
      return value;
  }
}

export const FIELD_LABEL: Record<string, string> = {
  title: "title",
  description: "description",
  status: "status",
  priority: "priority",
  severity: "severity",
  assigneeId: "assignee",
  reporterId: "reporter",
  dueDate: "due date",
  parentId: "parent issue",
  type: "issue type",
  labels: "labels",
  testResult: "test result",
  /*
   * Retired from the issue forms, but kept here on purpose: the activity log
   * is append-only, so entries recorded while these fields were editable
   * still name them. Dropping the labels would turn readable history into
   * raw column names.
   */
  stepsToReproduce: "steps to reproduce",
  expectedResult: "expected result",
  actualResult: "actual result",
  environment: "environment",
  browser: "browser",
  operatingSystem: "operating system",
  versionBuild: "version/build",
  affectedModule: "affected module",
};

/**
 * The colours a label may be given, and how one is chosen for a name.
 *
 * `createLabel` requires a colour, so anything that creates a label without
 * asking for one has to supply it. Picking by the name rather than at random
 * means the same label name always comes out the same colour — including on a
 * second project — which reads as deliberate instead of arbitrary.
 */
export const LABEL_COLOURS: readonly string[] = [
  "#3B82F6",
  "#8B5CF6",
  "#E5484D",
  "#F0961F",
  "#14A06D",
  "#0D9488",
  "#6B7C98",
];

export function labelColourFor(name: string): string {
  let hash = 0;
  for (const char of name.trim().toLowerCase()) {
    hash = (hash * 31 + char.charCodeAt(0)) % 100_000;
  }
  return LABEL_COLOURS[hash % LABEL_COLOURS.length] ?? "#3B82F6";
}
