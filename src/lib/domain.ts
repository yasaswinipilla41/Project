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
  "DONE",
  "CANCELLED",
] as const satisfies readonly IssueStatus[];

export const STATUS_LABEL: Record<IssueStatus, string> = {
  BACKLOG: "Backlog",
  TODO: "Todo",
  IN_PROGRESS: "In Progress",
  IN_REVIEW: "Ready for QA",
  DONE: "Done",
  CANCELLED: "Cancelled",
};

/** Statuses that take an issue out of active work. */
export const CLOSED_STATUSES = ["DONE", "CANCELLED"] as const satisfies
  readonly IssueStatus[];

export const OPEN_STATUSES = [
  "BACKLOG",
  "TODO",
  "IN_PROGRESS",
  "IN_REVIEW",
] as const satisfies readonly IssueStatus[];

export function isClosedStatus(status: IssueStatus): boolean {
  return status === "DONE" || status === "CANCELLED";
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
