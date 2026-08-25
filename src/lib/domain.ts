import type {
  IssueStatus,
  IssueType,
  Priority,
  Role,
  Severity,
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
  IN_REVIEW: "In Review",
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
  "TASK",
  "BUG",
  "STORY",
] as const satisfies readonly IssueType[];

export const ISSUE_TYPE_LABEL: Record<IssueType, string> = {
  TASK: "Task",
  BUG: "Bug",
  STORY: "Story",
};

export const ISSUE_TYPE_DESCRIPTION: Record<IssueType, string> = {
  TASK: "A unit of work to be completed.",
  BUG: "A defect with reproduction steps and expected vs actual behaviour.",
  STORY: "A user-facing capability described from the user's perspective.",
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
  stepsToReproduce: "steps to reproduce",
  expectedResult: "expected result",
  actualResult: "actual result",
  environment: "environment",
  browser: "browser",
  operatingSystem: "operating system",
  versionBuild: "version/build",
  affectedModule: "affected module",
};
