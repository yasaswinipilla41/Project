import type { IssueStatus, IssueType, SprintStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isClosedStatus, OPEN_STATUSES } from "@/lib/domain";

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
