import type { IssueStatus, IssueType, SprintStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isClosedStatus, OPEN_STATUSES } from "@/lib/domain";
import { burndown, type Burndown } from "@/lib/burndown";

/**
 * Everything the sprint views read, in one place and one shape.
 *
 * Two things are worth knowing before reading the rest:
 *
 *  - **Nothing here is stored progress.** A sprint's totals are counted from
 *    its issues' current `status` every time they are asked for, so moving a
 *    card on the board moves the sprint's progress with it. There is no cached
 *    figure to go stale and no second status model to reconcile.
 *
 *  - **A completed sprint is read from its outcome rows, a live one from its
 *    issues.** Completing a sprint moves the unfinished work out of it, so a
 *    completed sprint's membership no longer lives on the issues — it lives in
 *    `SprintIssueOutcome`, written once when the sprint closed. That is what
 *    keeps a finished sprint's report true a month later, whatever has since
 *    happened to the issues that were in it.
 *
 * Every query is scoped by `projectId`. A sprint can only ever describe its
 * own project's work.
 */

export interface SprintIssueSummary {
  id: string;
  key: string;
  title: string;
  type: IssueType;
  status: IssueStatus;
  assignee: { id: string; name: string; image: string | null } | null;
}

export interface SprintStats {
  total: number;
  /** Finished with — Done, Cancelled or Rejected. See `completeSprint`. */
  completed: number;
  remaining: number;
  /** Whole percent, 0 when the sprint holds nothing. */
  progress: number;
  /** Distinct people carrying work in the sprint. */
  assignees: number;
}

export interface SprintView {
  id: string;
  name: string;
  goal: string | null;
  startDate: Date;
  endDate: Date;
  status: SprintStatus;
  startedAt: Date | null;
  completedAt: Date | null;
  /** The work in it: current members while it runs, its final set once closed. */
  issues: SprintIssueSummary[];
  /** How each issue ended, present only for a completed sprint. */
  outcome: { completed: SprintIssueSummary[]; incomplete: SprintIssueSummary[] } | null;
  stats: SprintStats;
}

const ISSUE_SELECT = {
  id: true,
  key: true,
  title: true,
  type: true,
  status: true,
  assignee: { select: { id: true, name: true, image: true } },
} as const;

function statsFor(issues: SprintIssueSummary[]): SprintStats {
  const completed = issues.filter((issue) => isClosedStatus(issue.status)).length;
  const assignees = new Set(
    issues.flatMap((issue) => (issue.assignee ? [issue.assignee.id] : [])),
  ).size;

  return {
    total: issues.length,
    completed,
    remaining: issues.length - completed,
    progress: issues.length === 0 ? 0 : Math.round((completed / issues.length) * 100),
    assignees,
  };
}

/**
 * A project's sprints, newest planning first.
 *
 * Ordered so the sprint being worked leads: active, then planned by start
 * date, then the completed ones newest first as history.
 */
export async function loadSprints(projectId: string): Promise<SprintView[]> {
  const sprints = await prisma.sprint.findMany({
    where: { projectId },
    select: {
      id: true,
      name: true,
      goal: true,
      startDate: true,
      endDate: true,
      status: true,
      startedAt: true,
      completedAt: true,
      /* Ordered by issue `number`, not by `key`: the key is text, so sorting
         on it puts ENG-10 before ENG-2. A sprint holds one project's work by
         construction, so the number is unambiguous here. */
      issues: {
        select: ISSUE_SELECT,
        orderBy: [{ status: "asc" }, { number: "asc" }],
      },
      outcomes: {
        select: { completed: true, issue: { select: ISSUE_SELECT } },
        orderBy: { issue: { number: "asc" } },
      },
    },
    orderBy: [{ startDate: "desc" }],
  });

  const views = sprints.map((sprint): SprintView => {
    if (sprint.status === "COMPLETED") {
      /* The record, not the live membership: these issues may since have been
         reassigned, moved into a later sprint or finished elsewhere, and the
         sprint's own report is about how they stood when it closed. */
      const completed = sprint.outcomes
        .filter((row) => row.completed)
        .map((row) => row.issue);
      const incomplete = sprint.outcomes
        .filter((row) => !row.completed)
        .map((row) => row.issue);
      const issues = [...completed, ...incomplete];

      return {
        ...sprint,
        issues,
        outcome: { completed, incomplete },
        /* Counted from the outcome rows rather than from today's statuses, so
           a completed sprint's figures never move afterwards. */
        stats: {
          total: issues.length,
          completed: completed.length,
          remaining: incomplete.length,
          progress:
            issues.length === 0
              ? 0
              : Math.round((completed.length / issues.length) * 100),
          assignees: new Set(
            issues.flatMap((issue) => (issue.assignee ? [issue.assignee.id] : [])),
          ).size,
        },
      };
    }

    return {
      ...sprint,
      issues: sprint.issues,
      outcome: null,
      stats: statsFor(sprint.issues),
    };
  });

  const rank: Record<SprintStatus, number> = {
    ACTIVE: 0,
    PLANNED: 1,
    COMPLETED: 2,
  };

  return views.sort((a, b) => {
    if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
    // Planned sprints read forwards (what is coming next); history reads back.
    return a.status === "PLANNED"
      ? a.startDate.getTime() - b.startDate.getTime()
      : b.startDate.getTime() - a.startDate.getTime();
  });
}

/**
 * The project's backlog: its open work that is in no sprint.
 *
 * This is the only list the "add issues" picker is ever built from, and it is
 * filtered by `projectId` in the query — so an issue from another project
 * cannot appear in it, whatever the browser asks for. Closed work is left out
 * because there is nothing left to plan.
 */
export async function loadSprintBacklog(
  projectId: string,
): Promise<SprintIssueSummary[]> {
  return prisma.issue.findMany({
    where: {
      projectId,
      sprintId: null,
      status: { in: [...OPEN_STATUSES] },
    },
    select: ISSUE_SELECT,
    orderBy: [{ priority: "asc" }, { sortIndex: "asc" }, { number: "asc" }],
  });
}

/**
 * A sprint's burndown, read from what is actually recorded.
 *
 * Two sources, both of them already there:
 *
 *  - **the items**, for the estimates committed to this sprint and what is
 *    left of them right now;
 *  - **the activity trail**, for how the remainder moved. Every change to
 *    `remainingHours` is written there by `updateIssue` like any other field,
 *    so the history a burndown needs is a query rather than a second table
 *    quietly kept in step with the first.
 *
 * Where the trail has nothing to say, neither does the chart: a sprint nobody
 * has estimated draws no line at all rather than a flattering one.
 */
export async function loadBurndown(
  sprintId: string,
  now: Date = new Date(),
): Promise<Burndown | null> {
  const sprint = await prisma.sprint.findUnique({
    where: { id: sprintId },
    select: {
      startDate: true,
      endDate: true,
      issues: {
        select: { id: true, effortHours: true, remainingHours: true },
      },
    },
  });
  if (!sprint) return null;

  const issueIds = sprint.issues.map((issue) => issue.id);

  /* Only the readings, and only for this sprint's own work. `newValue` is
     text in the trail — it is one column shared by every kind of field — so
     the numbers are parsed back here and anything unparseable is dropped
     rather than guessed at. */
  const entries =
    issueIds.length === 0
      ? []
      : await prisma.activityLogEntry.findMany({
          where: { issueId: { in: issueIds }, field: "remainingHours" },
          select: { issueId: true, newValue: true, createdAt: true },
          orderBy: { createdAt: "asc" },
        });

  const history = entries.flatMap((entry) => {
    if (entry.newValue === null) return [];
    const hours = Number(entry.newValue);
    if (!Number.isFinite(hours)) return [];
    return [{ at: entry.createdAt, issueId: entry.issueId, remainingHours: hours }];
  });

  return burndown({
    startDate: sprint.startDate,
    endDate: sprint.endDate,
    items: sprint.issues.map((issue) => ({
      issueId: issue.id,
      effortHours: issue.effortHours,
      remainingHours: issue.remainingHours,
    })),
    history,
    now,
  });
}
