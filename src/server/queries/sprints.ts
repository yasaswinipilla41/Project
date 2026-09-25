import type { IssueStatus, IssueType, SprintStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { isClosedStatus, isIssueStatus, OPEN_STATUSES } from "@/lib/domain";
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
      name: true,
      projectId: true,
      status: true,
      startDate: true,
      endDate: true,
      issues: {
        select: {
          id: true,
          /* Named, so a day's detail can say which issues make up what is
             left rather than only how much of it there is. */
          key: true,
          title: true,
          effortHours: true,
          remainingHours: true,
          /* Read because closed work has nothing left to burn whatever its
             remainder says: finishing an issue does not touch its remaining
             hours, so a chart drawn from remainders alone ran flat across a
             sprint that was being finished. */
          status: true,
          /* Named beside the work in a day's detail: "what is left" is a
             question about people as well as hours. */
          assignee: { select: { name: true } },
        },
      },
    },
  });
  if (!sprint) return null;

  /*
   * Work this sprint used to hold.
   *
   * An issue moved out still belongs in the history: the sprint carried its
   * weight until the day it left, and "why did the line drop?" is answered by
   * saying so. Found through the trail rather than by guessing — an issue's
   * `sprintId` change records the sprint it left by name — and scoped to this
   * sprint's own project, so another project's identically named sprint
   * cannot pull its work in here.
   */
  const departures =
    sprint.name.length === 0
      ? []
      : await prisma.activityLogEntry.findMany({
          where: {
            field: "sprintId",
            oldValue: sprint.name,
            issue: { projectId: sprint.projectId },
          },
          select: { issueId: true },
        });

  const current = new Set(sprint.issues.map((issue) => issue.id));
  const departedIds = [
    ...new Set(departures.map((entry) => entry.issueId)),
  ].filter((id) => !current.has(id));

  const departed =
    departedIds.length === 0
      ? []
      : await prisma.issue.findMany({
          where: { id: { in: departedIds }, projectId: sprint.projectId },
          select: {
            id: true,
            key: true,
            title: true,
            effortHours: true,
            remainingHours: true,
            status: true,
            assignee: { select: { name: true } },
          },
        });

  const issueIds = [...current, ...departed.map((issue) => issue.id)];

  /* The readings, the status changes, the estimates and the moves in and out,
     in one pass over the work this sprint has held. `newValue` is text in the
     trail — it is one column shared by every kind of field — so each is
     parsed back here and anything unparseable is dropped rather than guessed
     at. */
  const entries =
    issueIds.length === 0
      ? []
      : await prisma.activityLogEntry.findMany({
          where: {
            issueId: { in: issueIds },
            field: {
              in: ["remainingHours", "status", "effortHours", "sprintId"],
            },
          },
          select: {
            issueId: true,
            field: true,
            oldValue: true,
            newValue: true,
            createdAt: true,
          },
          orderBy: { createdAt: "asc" },
        });

  const hours = (value: string | null): number | null => {
    if (value === null || value.trim() === "") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const history = entries.flatMap((entry) => {
    if (entry.field !== "remainingHours") return [];
    const remainingHours = hours(entry.newValue);
    if (remainingHours === null) return [];
    return [{ at: entry.createdAt, issueId: entry.issueId, remainingHours }];
  });

  /* When each item was in which status, so the actual line falls on the day
     work was finished rather than on the day the chart is read. `oldValue` is
     kept: it is what makes the days before an item's first recorded change
     knowable instead of guessed. */
  const statusHistory = entries.flatMap((entry) => {
    if (entry.field !== "status" || !isIssueStatus(entry.newValue)) return [];
    return [
      {
        at: entry.createdAt,
        issueId: entry.issueId,
        from: isIssueStatus(entry.oldValue) ? entry.oldValue : null,
        to: entry.newValue,
      },
    ];
  });

  /* Estimates as they stood, so a day's commitment is what the sprint had
     actually been told it was taking on, and a re-estimate can be explained
     with the figure it moved from. */
  const estimateHistory = entries.flatMap((entry) => {
    if (entry.field !== "effortHours") return [];
    return [
      {
        at: entry.createdAt,
        issueId: entry.issueId,
        from: hours(entry.oldValue),
        to: hours(entry.newValue),
      },
    ];
  });

  /* In and out of this sprint. An issue's `sprintId` change names the sprints
     on either side of the move, so an entry naming this one on the right is a
     joining and on the left a leaving; a move between two other sprints says
     nothing here and is skipped. */
  const membershipHistory = entries.flatMap((entry) => {
    if (entry.field !== "sprintId") return [];
    if (entry.newValue === sprint.name) {
      return [{ at: entry.createdAt, issueId: entry.issueId, joined: true }];
    }
    if (entry.oldValue === sprint.name) {
      return [{ at: entry.createdAt, issueId: entry.issueId, joined: false }];
    }
    return [];
  });

  return burndown({
    startDate: sprint.startDate,
    endDate: sprint.endDate,
    items: [
      ...sprint.issues.map((issue) => ({
        issueId: issue.id,
        key: issue.key,
        title: issue.title,
        effortHours: issue.effortHours,
        remainingHours: issue.remainingHours,
        status: issue.status,
        assignee: issue.assignee?.name ?? null,
        member: true,
      })),
      ...departed.map((issue) => ({
        issueId: issue.id,
        key: issue.key,
        title: issue.title,
        effortHours: issue.effortHours,
        remainingHours: issue.remainingHours,
        status: issue.status,
        assignee: issue.assignee?.name ?? null,
        member: false,
      })),
    ],
    history,
    statusHistory,
    estimateHistory,
    membershipHistory,
    /* A marker for today is worth drawing on the sprint being worked, and
       only there. */
    active: sprint.status === "ACTIVE",
    now,
  });
}
