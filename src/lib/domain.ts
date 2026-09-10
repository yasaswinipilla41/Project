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

/* ------------------------------------------------ status, by who is asking */

/**
 * The statuses each half of the job may set.
 *
 * Two lists, not one per role name, because a Full Stack Developer holds both
 * halves and a table keyed by name would need a fourth row that is only ever
 * the union of two others — and a fifth the next time the combination changes.
 * `allowedStatusesFor` composes them with `doesQaWork` / `doesDeveloperWork`,
 * the same question the rest of the model asks.
 *
 *   DEVELOPMENT  New, In Progress, Ready for QA. The build, and handing it
 *                over. Declaring work tested or finished would be marking
 *                their own homework, deciding what sits in the backlog is
 *                planning rather than building, and reopening finished work
 *                is a decision about what is finished rather than about the
 *                build.
 *   QA           Backlog, In QA, Done, Reopen, Reject / Not an Issue,
 *                Cancelled. Taking work in, testing it, and saying what the
 *                testing found — including the two verdicts that are not a
 *                defect at all, and the one that sends failed work back.
 *
 * Each list is what that half of the job is *for*, and the two are now
 * disjoint: Ready for QA is the developer's hand-off and theirs alone, so a
 * tester cannot mark work ready to be tested and then test it. A tester who
 * finds a fault sends it back to the Backlog or writes it off, which are
 * verdicts rather than a claim about the build.
 *
 * Reopen is testing's, because failing something is testing's. It is the other
 * half of the verdict Done is: a tester who checks work either finishes it or
 * sends it back, and without Reopen they could only finish it. Writing work off
 * — Reject / Not an Issue, Cancelled — sits beside it for the same reason.
 *
 * It is deliberately not the developer's. Reopening reverses a conclusion
 * somebody else reached about the build; a developer who disagrees says so
 * through the build.
 *
 * This is the authorization, read by everything that offers or accepts a
 * status — the issue page's menu, the board's columns and card menus, the
 * create and clone forms, and `updateIssue` itself — so a control that is
 * hidden and a request that is refused agree by construction.
 * `STATUS_TRANSITIONS` below answers a different question, which moves make
 * sense from where, and neither substitutes for the other.
 */
export const DEVELOPMENT_STATUSES = [
  "TODO",
  "IN_PROGRESS",
  "IN_REVIEW",
] as const satisfies readonly IssueStatus[];

export const QA_STATUSES = [
  "BACKLOG",
  "IN_QA",
  "DONE",
  "REOPENED",
  "REJECTED",
  "CANCELLED",
] as const satisfies readonly IssueStatus[];

/**
 * The statuses this person may put *this* issue into.
 *
 * The union of the halves they hold — so a Full Stack Developer, who builds
 * and checks, gets both — plus one rule that belongs to testing alone: Done is
 * what testing concluded, so somebody whose only claim to it is their QA half
 * may set it from In QA and nowhere else. A tester cannot mark something done
 * that was never tested; that is the intended workflow expressed as the one
 * move that carries a verdict.
 *
 * The rule does not touch anybody who also builds, and never touches an
 * administrator: closing work straight from Ready for QA is still open to
 * both, which is the path several surfaces have always used.
 *
 * `current` is null when work is being created rather than moved. Creation is
 * not a transition — an issue may be filed in whatever state the person filing
 * it says it is in — so only the lists apply.
 */
export function allowedStatusesFor(
  role: WorkRole,
  current: IssueStatus | null = null,
): readonly IssueStatus[] {
  if (role === "ADMIN") return ISSUE_STATUSES;

  const allowed = ISSUE_STATUSES.filter(
    (status) =>
      (doesDeveloperWork(role) &&
        (DEVELOPMENT_STATUSES as readonly IssueStatus[]).includes(status)) ||
      (doesQaWork(role) && (QA_STATUSES as readonly IssueStatus[]).includes(status)),
  );

  if (doesDeveloperWork(role)) return allowed;

  /*
   * Done is the verdict, so it follows In QA — including at creation, where
   * `current` is null and there is no In QA behind the issue at all. Filing
   * something as already finished is the same skip as moving it there
   * straight from Ready for QA, and it is the one a create form could
   * otherwise wave through.
   *
   * Staying put is not a verdict: refusing Done on something already Done
   * would refuse every other edit to finished work.
   */
  return allowed.filter(
    (status) => status !== "DONE" || current === "IN_QA" || current === "DONE",
  );
}

/**
 * The statuses work may be *filed* as.
 *
 * Raising work and moving it are separate decisions, so this is not the
 * transition list — and for a pure tester it is not the settable list either.
 * A tester raises work into the backlog and nowhere else: what they file is a
 * request for somebody to pick up, and the person who decides whether it is
 * next, already being built, or finished is not the person who raised it.
 * Filing straight into In QA or a verdict would let a tester walk work past
 * every hand-off the workflow exists to record.
 *
 * One status, therefore, and the create form offers exactly it. Everybody else
 * files in whatever their own half may set: a developer or a full stack
 * developer starts work at New, and an administrator may file anything.
 *
 * Exported because the create and clone dialogs offer these and `createIssue`
 * enforces them; one definition is what keeps the offer and the refusal in
 * agreement.
 */
export const QA_FILABLE_STATUSES = [
  "BACKLOG",
] as const satisfies readonly IssueStatus[];

export function filableStatusesFor(role: WorkRole): readonly IssueStatus[] {
  if (role === "QA") return QA_FILABLE_STATUSES;

  const settable = allowedStatusesFor(role, null);
  return settable.includes("TODO") ? settable : ["TODO", ...settable];
}

/* ----------------------------------------------------- editing a field */

/**
 * Who may rename an issue, and who may change its priority.
 *
 * Not a developer: the summary and the priority are how work is described and
 * ordered, which is the planning around the work rather than the work. A
 * developer building it says so through the status, and asks for the rest.
 * Everybody else keeps what they had.
 */
export function canEditIssueName(role: WorkRole): boolean {
  return role !== "DEVELOPER";
}

export function canEditPriority(role: WorkRole): boolean {
  return role !== "DEVELOPER";
}

/**
 * Who may set a due date: an administrator, and only an administrator.
 *
 * Both halves of the job are excluded — a developer does not date their own
 * work, and a tester raising a defect is reporting something rather than
 * planning when it must be done — which between them leaves nobody else. It is
 * written as its own question anyway, because "nobody but an administrator" is
 * the rule, and a role arriving later should have to answer it rather than
 * inherit an accident.
 */
export function canEditDueDate(role: WorkRole): boolean {
  return role === "ADMIN";
}

/** May this person put this issue into that status? */
export function canSetStatus(
  role: WorkRole,
  current: IssueStatus | null,
  next: IssueStatus,
): boolean {
  return allowedStatusesFor(role, current).includes(next);
}

/**
 * Why a status was refused, in the words the person needs.
 *
 * Kept beside the rule so the sentence and the check cannot drift apart, and
 * so the server and any interface that explains itself say the same thing.
 * Naming the one status they were refused, and what they may say instead, is
 * more use than "forbidden".
 */
export function statusRefusalReason(
  role: WorkRole,
  current: IssueStatus | null,
  next: IssueStatus,
): string {
  /* Refused Done to somebody whose claim to it is their testing half: it is
     theirs, from In QA, and this is them not being there yet. Asked as a
     capability rather than by reading the list back, because the list is
     exactly what has already excluded it. */
  if (next === "DONE" && doesQaWork(role) && !doesDeveloperWork(role)) {
    return "Done is what testing concluded — put this into In QA first.";
  }
  if (next === "IN_QA" || next === "DONE") {
    return "Only a tester or an administrator can put work into QA or mark it done.";
  }

  /* Filing, not moving. A tester may set In QA on work that already exists and
     still may not *file* something as already being tested, so the sentence
     has to name what may be filed rather than what may be set — otherwise it
     lists the very status that was just refused. */
  if (current === null) {
    const filable = filableStatusesFor(role)
      .map((status) => STATUS_LABEL[status])
      .join(", ");
    return `You can raise work as ${filable}. ${STATUS_LABEL[next]} is somewhere it gets to, not somewhere it starts.`;
  }

  const names = allowedStatusesFor(role, current)
    .map((status) => STATUS_LABEL[status])
    .join(", ");
  return `You can move work to ${names}. ${STATUS_LABEL[next]} is someone else's call.`;
}

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

/* ---------------------------------------------------------------- severity

   Severity is no longer a field anybody sets: the control is gone from every
   form, filter, table and chart. What is left here is the vocabulary needed to
   *read* it — the activity log is append-only, so entries that recorded a
   severity change years of work ago still have to render as "Major" rather
   than "MAJOR". The column and its values are untouched in the database. */

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

/** The account roles, in the order a chooser should offer them. */
export const ROLES = ["MEMBER", "ADMIN"] as const satisfies readonly Role[];

export const ROLE_LABEL: Record<Role, string> = {
  ADMIN: "Admin",
  MEMBER: "Member",
};

export const ROLE_DESCRIPTION: Record<Role, string> = {
  ADMIN: "Full access. Manages projects, members, invitations and settings.",
  MEMBER: "Works in assigned projects. Creates and updates issues and bugs.",
};

/**
 * What somebody does here, as opposed to what their account is.
 *
 * `Role` is the account: ADMIN or MEMBER, and that is what the People screen
 * grants. The job is narrower, and it is the job that decides who may raise
 * work, hand it to QA, or call it done. `workRoleOf` in `lib/authz` is the one
 * place that derives it; the labels live here because the badges that show it
 * are client components and must not pull the database in.
 *
 * Two teams answer it between them:
 *
 *   Testing only                 QA
 *   Development only             DEVELOPER
 *   both                         FULLSTACK
 *   neither                      DEVELOPER — the long-standing default
 *
 * FULLSTACK is not a third kind of person. It is the two jobs held at once, so
 * everything below asks what somebody *does* rather than which name they carry
 * — see `doesQaWork` and `doesDeveloperWork`. Code that branches on the name
 * would have to grow a case here every time the combination changes; code that
 * asks about the capability does not.
 */
export type WorkRole = "ADMIN" | "QA" | "DEVELOPER" | "FULLSTACK";

export const WORK_ROLE_LABEL: Record<WorkRole, string> = {
  ADMIN: "Admin",
  QA: "QA member",
  DEVELOPER: "Developer",
  FULLSTACK: "Full Stack Developer",
};

export const WORK_ROLE_DESCRIPTION: Record<WorkRole, string> = {
  ADMIN: "Full access. Manages projects, members, sprints and assignment.",
  QA: "Raises work, verifies what developers hand back, and closes it.",
  DEVELOPER: "Picks up work in their projects and hands it back for QA.",
  FULLSTACK:
    "Builds and verifies: picks work up, hands it back, and checks what comes in.",
};

/* ------------------------------------------------------------ capabilities */

/**
 * May this person raise work and verify it — the tester's half of the job?
 *
 * Asked instead of `role === "QA"` everywhere, because a Full Stack Developer
 * does QA work too and a check written against the name silently excludes them.
 * An administrator is included: nothing is withheld from them.
 */
export function doesQaWork(role: WorkRole): boolean {
  return role === "ADMIN" || role === "QA" || role === "FULLSTACK";
}

/**
 * May this person take development on — pick work up, build it, hand it back?
 *
 * The mirror of `doesQaWork`. A pure tester is the only working role this is
 * false for; a Full Stack Developer builds as well as checks.
 */
export function doesDeveloperWork(role: WorkRole): boolean {
  return role === "ADMIN" || role === "DEVELOPER" || role === "FULLSTACK";
}

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
