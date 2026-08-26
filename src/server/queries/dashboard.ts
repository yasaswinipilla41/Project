import type { IssueStatus, IssueType, Priority, Role, Severity } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { accessibleProjectIds } from "@/lib/authz";
import { CLOSED_STATUSES, OPEN_STATUSES } from "@/lib/domain";
import type { CurrentUser } from "@/lib/session";

/**
 * Everything the home dashboard renders, gathered in one place.
 *
 * Two rules shape this module:
 *
 *  - **Real data only.** Every figure is an aggregate over rows the caller can
 *    actually see. Nothing is invented to make the page look populated; where
 *    there is nothing, the count is zero and the page shows an empty state.
 *  - **Bounded query count.** The whole dashboard is a fixed number of queries
 *    regardless of how many projects or issues exist — grouped aggregates and
 *    `in` lookups rather than a query per row.
 */

export interface DueBuckets {
  overdue: number;
  today: number;
  thisWeek: number;
}

export interface WorkSummary {
  assigned: number;
  inProgress: number;
  review: number;
  completed: number;
  overdue: number;
  reported: number;
}

export interface DashboardIssue {
  id: string;
  key: string;
  title: string;
  type: IssueType;
  status: IssueStatus;
  priority: Priority;
  severity: Severity | null;
  dueDate: Date | null;
  updatedAt: Date;
  project: { key: string; name: string };
  assignee: { id: string; name: string; image: string | null } | null;
  /** Sub-issue completion, when the issue has children. */
  progress: { done: number; total: number } | null;
}

export interface DashboardProject {
  id: string;
  key: string;
  name: string;
  total: number;
  open: number;
  done: number;
  bugs: number;
  openBugs: number;
  overdue: number;
  members: number;
  assignedToMe: number;
  /** Derived from open bugs and overdue work, never stored. */
  health: "healthy" | "attention" | "at-risk";
}

export interface DashboardActivity {
  id: string;
  action: string;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  createdAt: Date;
  actor: { name: string; image: string | null };
  issue: { key: string; title: string };
}

/**
 * One teammate, as every signed-in person — Member or Admin — is allowed to
 * see them: who they are and how much open work they are carrying in the
 * projects the viewer can already see. Nothing here is data a Member could
 * not already piece together by browsing the issue list and looking at the
 * Assignee column; this only saves them doing that by hand.
 *
 * The deeper, organization-wide breakdown — every project, not just the
 * viewer's own, with completed/overdue/critical detail per person — stays in
 * `DashboardData.org.workload`, which is admin-only.
 */
export interface DashboardTeammate {
  id: string;
  name: string;
  image: string | null;
  role: Role;
  isActive: boolean;
  /** Open issues assigned to them, within the projects the viewer can see. */
  openInScope: number;
}

/**
 * Someone who joined recently, surfaced at the top of Admin Home so a new
 * teammate is never lost among the rest of the dashboard. Admin-only, and
 * org-wide by nature — a new member has to be findable before they belong to
 * any project the admin happens to also be scoped to.
 */
export interface DashboardNewUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  isActive: boolean;
  createdAt: Date;
}

export interface DashboardData {
  scope: { projectIds: string[]; isAdmin: boolean };
  kpi: {
    projects: number;
    openIssues: number;
    openBugs: number;
    inProgress: number;
    completed: number;
    highPriorityOpen: number;
    createdThisMonth: number;
    completedThisMonth: number;
    completedLastMonth: number;
    newProjectsThisMonth: number;
    inProgressThisWeek: number;
  };
  myWork: WorkSummary;
  due: DueBuckets;
  /**
   * `isNewAssignment` reuses the unread `ISSUE_ASSIGNED` notification that
   * `updateIssue` already creates — the same fact the notification bell shows,
   * just surfaced here too. Reading it never marks it read; opening the issue
   * or the notification inbox is what does that, unchanged.
   */
  assigned: (DashboardIssue & { isNewAssignment: boolean })[];
  important: DashboardIssue[];
  projects: DashboardProject[];
  /** Every signed-in user's teammates in their accessible projects — see `DashboardTeammate`. */
  teamMembers: DashboardTeammate[];
  byStatus: Record<string, number>;
  byPriority: Record<string, number>;
  byType: Record<string, number>;
  bySeverity: Record<string, number>;
  activity: DashboardActivity[];
  /** Present only for admins. */
  org: {
    users: number;
    activeUsers: number;
    admins: number;
    totalIssues: number;
    openBugs: number;
    criticalOpen: number;
    unassignedOpen: number;
    workload: { id: string; name: string; image: string | null; open: number }[];
  } | null;
  /** Present only for admins — see `DashboardNewUser`. */
  newUsers: DashboardNewUser[] | null;
  /**
   * Bug-focused figures, shown when the person's own history says they work
   * that way. Derived from behaviour, not from an invented role.
   */
  qa: {
    reportedByMe: number;
    bugsReportedByMe: number;
    awaitingVerification: number;
    criticalOpen: number;
    resolvedThisWeek: number;
  } | null;
}

/** Day boundaries used across the buckets, computed once per request. */
function windows() {
  const now = new Date();

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  const endOfToday = new Date(startOfToday);
  endOfToday.setDate(endOfToday.getDate() + 1);

  const endOfWeek = new Date(startOfToday);
  endOfWeek.setDate(endOfWeek.getDate() + 7);

  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);

  return {
    now,
    startOfToday,
    endOfToday,
    endOfWeek,
    startOfMonth,
    startOfLastMonth,
    weekAgo,
  };
}

/** How many assigned issues the dashboard previews before "View all". */
const ASSIGNED_PREVIEW = 8;

const ISSUE_SELECT = {
  id: true,
  key: true,
  title: true,
  type: true,
  status: true,
  priority: true,
  severity: true,
  dueDate: true,
  updatedAt: true,
  project: { select: { key: true, name: true } },
  assignee: { select: { id: true, name: true, image: true } },
  children: { select: { status: true } },
} as const;

type RawIssue = {
  children: { status: IssueStatus }[];
} & Omit<DashboardIssue, "progress">;

/** Turns child statuses into a progress fraction, or null when there are none. */
function withProgress(issue: RawIssue): DashboardIssue {
  const { children, ...rest } = issue;
  if (children.length === 0) return { ...rest, progress: null };

  const done = children.filter((c) =>
    (CLOSED_STATUSES as readonly string[]).includes(c.status),
  ).length;

  return { ...rest, progress: { done, total: children.length } };
}

export async function loadDashboard(user: CurrentUser): Promise<DashboardData> {
  const isAdmin = user.role === "ADMIN";
  const projectIds = await accessibleProjectIds(user);
  const w = windows();

  // Nothing to aggregate over: return a well-formed empty shape so the page
  // renders its empty states rather than guarding every field. New-user
  // visibility is org-wide, not project-scoped, so it still runs here — a
  // fresh admin with zero projects is exactly when noticing a new teammate
  // matters most.
  if (projectIds.length === 0) {
    return emptyDashboard(isAdmin, isAdmin ? await loadNewUsers() : null);
  }

  const scope = { projectId: { in: projectIds } };
  const open = { in: [...OPEN_STATUSES] };
  const mine = { ...scope, assigneeId: user.id };

  const [
    byStatusRows,
    byPriorityRows,
    byTypeRows,
    bySeverityRows,
    projectRows,
    projectStatRows,
    assignedIssues,
    importantIssues,
    activityRows,
    teammateRows,
    openByAssigneeInScope,
    newAssignmentRows,
    counts,
  ] = await Promise.all([
    prisma.issue.groupBy({
      by: ["status"],
      where: scope,
      _count: { _all: true },
    }),
    prisma.issue.groupBy({
      by: ["priority"],
      where: { ...scope, status: open },
      _count: { _all: true },
    }),
    prisma.issue.groupBy({
      by: ["type"],
      where: scope,
      _count: { _all: true },
    }),
    prisma.issue.groupBy({
      by: ["severity"],
      where: { ...scope, type: "BUG" },
      _count: { _all: true },
    }),
    prisma.project.findMany({
      where: { id: { in: projectIds } },
      select: {
        id: true,
        key: true,
        name: true,
        _count: { select: { members: true } },
      },
      orderBy: { name: "asc" },
    }),
    // One grouped pass covers every per-project tile.
    prisma.issue.groupBy({
      by: ["projectId", "status", "type"],
      where: scope,
      _count: { _all: true },
    }),
    prisma.issue.findMany({
      where: { ...mine, status: open },
      select: ISSUE_SELECT,
      orderBy: [
        { priority: "asc" },
        { dueDate: { sort: "asc", nulls: "last" } },
        { updatedAt: "desc" },
      ],
      take: ASSIGNED_PREVIEW,
    }),
    prisma.issue.findMany({
      where: {
        ...scope,
        status: open,
        OR: [
          { priority: { in: ["URGENT", "HIGH"] } },
          { severity: "CRITICAL" },
          { dueDate: { lt: w.now } },
        ],
      },
      select: ISSUE_SELECT,
      orderBy: [{ priority: "asc" }, { updatedAt: "desc" }],
      take: 6,
    }),
    prisma.activityLogEntry.findMany({
      where: { issue: scope },
      select: {
        id: true,
        action: true,
        field: true,
        oldValue: true,
        newValue: true,
        createdAt: true,
        actor: { select: { name: true, image: true } },
        issue: { select: { key: true, title: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    /*
     * Every teammate visible to every signed-in user, Member or Admin alike —
     * the people who share a project with the viewer. Scoped to `projectIds`
     * exactly like `filterOptions()` scopes the Reporter/Assignee pickers, so
     * this never shows someone from a project the viewer cannot otherwise see
     * into.
     */
    prisma.user.findMany({
      where: {
        isActive: true,
        projectMemberships: { some: { projectId: { in: projectIds } } },
      },
      select: { id: true, name: true, image: true, role: true, isActive: true },
      orderBy: { name: "asc" },
      take: 24,
    }),
    // One grouped pass gives every teammate's open-work count at once.
    prisma.issue.groupBy({
      by: ["assigneeId"],
      where: { ...scope, status: open, assigneeId: { not: null } },
      _count: { _all: true },
    }),
    // Which of "my assigned tasks" are unread assignments — reuses the
    // Notification row `updateIssue` already writes, rather than a second
    // "seen" concept.
    prisma.notification.findMany({
      where: { userId: user.id, type: "ISSUE_ASSIGNED", readAt: null },
      select: { issueId: true },
      take: 50,
    }),
    countBundle(user, scope, w),
  ]);

  // Per-project rollup from the single grouped result.
  const perProject = new Map<
    string,
    { total: number; open: number; done: number; bugs: number; openBugs: number }
  >();

  for (const row of projectStatRows) {
    const entry = perProject.get(row.projectId) ?? {
      total: 0,
      open: 0,
      done: 0,
      bugs: 0,
      openBugs: 0,
    };
    const n = row._count._all;
    const isOpen = (OPEN_STATUSES as readonly string[]).includes(row.status);

    entry.total += n;
    if (isOpen) entry.open += n;
    if (row.status === "DONE") entry.done += n;
    if (row.type === "BUG") {
      entry.bugs += n;
      if (isOpen) entry.openBugs += n;
    }
    perProject.set(row.projectId, entry);
  }

  const [overdueByProject, assignedByProject] = await Promise.all([
    prisma.issue.groupBy({
      by: ["projectId"],
      where: { ...scope, status: open, dueDate: { lt: w.now } },
      _count: { _all: true },
    }),
    prisma.issue.groupBy({
      by: ["projectId"],
      where: { ...mine, status: open },
      _count: { _all: true },
    }),
  ]);

  const overdueMap = new Map(
    overdueByProject.map((r) => [r.projectId, r._count._all]),
  );
  const assignedMap = new Map(
    assignedByProject.map((r) => [r.projectId, r._count._all]),
  );

  const projects: DashboardProject[] = projectRows.map((project) => {
    const stats = perProject.get(project.id) ?? {
      total: 0,
      open: 0,
      done: 0,
      bugs: 0,
      openBugs: 0,
    };
    const overdue = overdueMap.get(project.id) ?? 0;

    /*
     * Health is derived, and only from things that are unambiguously bad:
     * overdue work and unresolved bugs. It is a reading of the data, not a
     * score with invented weights.
     */
    const health: DashboardProject["health"] =
      overdue >= 3 || stats.openBugs >= 5
        ? "at-risk"
        : overdue > 0 || stats.openBugs >= 2
          ? "attention"
          : "healthy";

    return {
      id: project.id,
      key: project.key,
      name: project.name,
      ...stats,
      overdue,
      members: project._count.members,
      assignedToMe: assignedMap.get(project.id) ?? 0,
      health,
    };
  });

  const openInScopeById = new Map(
    openByAssigneeInScope.map((row) => [row.assigneeId as string, row._count._all]),
  );
  const teamMembers: DashboardTeammate[] = teammateRows.map((person) => ({
    id: person.id,
    name: person.name,
    image: person.image,
    role: person.role,
    isActive: person.isActive,
    openInScope: openInScopeById.get(person.id) ?? 0,
  }));

  const [org, newUsers] = isAdmin
    ? await Promise.all([loadOrgStats(), loadNewUsers()])
    : [null, null];

  // `Notification.issueId` is nullable (not every kind of notification has an
  // issue), so the nulls are dropped before this becomes an id lookup.
  const newAssignmentIds = new Set(
    newAssignmentRows
      .map((r) => r.issueId)
      .filter((id): id is string => id !== null),
  );

  /*
   * "My assigned tasks" is capped and sorted by priority, so somebody already
   * carrying a full page of urgent work would never see a newly assigned
   * MEDIUM or LOW one — it was assigned, saved and scoped correctly, it simply
   * sorted off the end. That is the whole of the "new assignments don't show
   * up" complaint; nothing about it was a caching problem.
   *
   * The ones that fell off are fetched by *recency*, deliberately not by
   * priority: sorting these by priority too would reproduce the very bug this
   * exists to fix, just one level down. They then lead the list, because an
   * assignment the person has not yet acknowledged is the thing they are
   * least likely to know about, whatever its priority.
   */
  const shownIds = new Set(assignedIssues.map((i) => i.id));
  const missedIds = [...newAssignmentIds].filter((id) => !shownIds.has(id));

  const missed = await prisma.issue.findMany({
    // An empty `in` matches nothing, so the no-missed case costs one trivial
    // query rather than needing a branch that widens the selected row type.
    where: { ...mine, status: open, id: { in: missedIds } },
    select: ISSUE_SELECT,
    orderBy: { updatedAt: "desc" },
    take: ASSIGNED_PREVIEW,
  });

  /*
   * Merge, then rank — rather than concatenating, which would let a run of
   * unacknowledged items push every high-priority one off the end.
   *
   * New assignments lead, most recent first. Everything else keeps the
   * priority order the query already applied. Still a preview of at most
   * `ASSIGNED_PREVIEW`; the count beside the heading and "View all assigned"
   * remain the full picture.
   */
  const byId = new Map<string, (typeof assignedIssues)[number]>();
  for (const issue of [...assignedIssues, ...missed]) byId.set(issue.id, issue);

  const priorityRank = new Map(assignedIssues.map((i, index) => [i.id, index]));

  const assigned = [...byId.values()]
    .sort((a, b) => {
      const aNew = newAssignmentIds.has(a.id);
      const bNew = newAssignmentIds.has(b.id);
      if (aNew !== bNew) return aNew ? -1 : 1;
      if (aNew && bNew) return b.updatedAt.getTime() - a.updatedAt.getTime();
      return (
        (priorityRank.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
        (priorityRank.get(b.id) ?? Number.MAX_SAFE_INTEGER)
      );
    })
    .slice(0, ASSIGNED_PREVIEW)
    .map(withProgress)
    .map((issue) => ({
      ...issue,
      isNewAssignment: newAssignmentIds.has(issue.id),
    }));

  return {
    scope: { projectIds, isAdmin },
    kpi: counts.kpi,
    myWork: counts.myWork,
    due: counts.due,
    assigned,
    important: importantIssues.map(withProgress),
    projects,
    teamMembers,
    byStatus: tally(byStatusRows, "status"),
    byPriority: tally(byPriorityRows, "priority"),
    byType: tally(byTypeRows, "type"),
    bySeverity: tally(bySeverityRows, "severity"),
    activity: activityRows,
    org,
    newUsers,
    qa: counts.qa,
  };
}

/** All the plain counts, issued together. */
async function countBundle(
  user: CurrentUser,
  scope: { projectId: { in: string[] } },
  w: ReturnType<typeof windows>,
) {
  const open = { in: [...OPEN_STATUSES] };
  const closed = { in: [...CLOSED_STATUSES] };
  const mine = { ...scope, assigneeId: user.id };

  const [
    openIssues,
    openBugs,
    inProgress,
    completed,
    highPriorityOpen,
    createdThisMonth,
    completedThisMonth,
    completedLastMonth,
    inProgressThisWeek,
    newProjectsThisMonth,
    myAssigned,
    myInProgress,
    myReview,
    myCompleted,
    myOverdue,
    myReported,
    overdue,
    dueToday,
    dueThisWeek,
    bugsReportedByMe,
    awaitingVerification,
    criticalOpen,
    resolvedThisWeek,
  ] = await Promise.all([
    prisma.issue.count({ where: { ...scope, status: open } }),
    prisma.issue.count({ where: { ...scope, type: "BUG", status: open } }),
    prisma.issue.count({ where: { ...scope, status: "IN_PROGRESS" } }),
    prisma.issue.count({ where: { ...scope, status: "DONE" } }),
    prisma.issue.count({
      where: { ...scope, status: open, priority: { in: ["URGENT", "HIGH"] } },
    }),
    prisma.issue.count({
      where: { ...scope, createdAt: { gte: w.startOfMonth } },
    }),
    prisma.issue.count({
      where: { ...scope, completedAt: { gte: w.startOfMonth } },
    }),
    prisma.issue.count({
      where: {
        ...scope,
        completedAt: { gte: w.startOfLastMonth, lt: w.startOfMonth },
      },
    }),
    prisma.issue.count({
      where: { ...scope, status: "IN_PROGRESS", updatedAt: { gte: w.weekAgo } },
    }),
    prisma.project.count({
      where: { id: { in: scope.projectId.in }, createdAt: { gte: w.startOfMonth } },
    }),

    prisma.issue.count({ where: { ...mine, status: open } }),
    prisma.issue.count({ where: { ...mine, status: "IN_PROGRESS" } }),
    prisma.issue.count({ where: { ...mine, status: "IN_REVIEW" } }),
    prisma.issue.count({ where: { ...mine, status: closed } }),
    prisma.issue.count({
      where: { ...mine, status: open, dueDate: { lt: w.now } },
    }),
    prisma.issue.count({ where: { ...scope, reporterId: user.id } }),

    prisma.issue.count({
      where: { ...mine, status: open, dueDate: { lt: w.startOfToday } },
    }),
    prisma.issue.count({
      where: {
        ...mine,
        status: open,
        dueDate: { gte: w.startOfToday, lt: w.endOfToday },
      },
    }),
    prisma.issue.count({
      where: {
        ...mine,
        status: open,
        dueDate: { gte: w.endOfToday, lt: w.endOfWeek },
      },
    }),

    prisma.issue.count({
      where: { ...scope, reporterId: user.id, type: "BUG" },
    }),
    prisma.issue.count({
      where: { ...scope, reporterId: user.id, type: "BUG", status: "IN_REVIEW" },
    }),
    prisma.issue.count({
      where: { ...scope, type: "BUG", severity: "CRITICAL", status: open },
    }),
    prisma.issue.count({
      where: { ...scope, type: "BUG", completedAt: { gte: w.weekAgo } },
    }),
  ]);

  return {
    kpi: {
      projects: scope.projectId.in.length,
      openIssues,
      openBugs,
      inProgress,
      completed,
      highPriorityOpen,
      createdThisMonth,
      completedThisMonth,
      completedLastMonth,
      newProjectsThisMonth,
      inProgressThisWeek,
    },
    myWork: {
      assigned: myAssigned,
      inProgress: myInProgress,
      review: myReview,
      completed: myCompleted,
      overdue: myOverdue,
      reported: myReported,
    },
    due: { overdue, today: dueToday, thisWeek: dueThisWeek },
    /*
     * Shown when the person's own history is bug-led — they have reported bugs
     * and report more than they are assigned. Prio has two roles, so this is
     * read from behaviour rather than pretending a QA role exists.
     */
    qa:
      bugsReportedByMe > 0 && myReported >= myAssigned
        ? {
            reportedByMe: myReported,
            bugsReportedByMe,
            awaitingVerification,
            criticalOpen,
            resolvedThisWeek,
          }
        : null,
  };
}

/** Organization-wide figures, admin only. */
async function loadOrgStats() {
  const open = { in: [...OPEN_STATUSES] };

  const [users, activeUsers, admins, totalIssues, openBugs, criticalOpen, unassignedOpen, workloadRows] =
    await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { isActive: true } }),
      prisma.user.count({ where: { role: "ADMIN", isActive: true } }),
      prisma.issue.count(),
      prisma.issue.count({ where: { type: "BUG", status: open } }),
      prisma.issue.count({
        where: { type: "BUG", severity: "CRITICAL", status: open },
      }),
      prisma.issue.count({ where: { assigneeId: null, status: open } }),
      prisma.issue.groupBy({
        by: ["assigneeId"],
        where: { status: open, assigneeId: { not: null } },
        _count: { _all: true },
        orderBy: { _count: { id: "desc" } },
        take: 6,
      }),
    ]);

  const ids = workloadRows
    .map((r) => r.assigneeId)
    .filter((id): id is string => id !== null);

  const people = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true, image: true },
  });
  const byId = new Map(people.map((p) => [p.id, p]));

  return {
    users,
    activeUsers,
    admins,
    totalIssues,
    openBugs,
    criticalOpen,
    unassignedOpen,
    workload: workloadRows.flatMap((row) => {
      const person = row.assigneeId ? byId.get(row.assigneeId) : undefined;
      return person ? [{ ...person, open: row._count._all }] : [];
    }),
  };
}

/** How far back "new" reaches before Admin Home stops calling someone new. */
const NEW_USER_WINDOW_DAYS = 14;

/** Recently joined people, newest first — admin only, org-wide. */
async function loadNewUsers(): Promise<DashboardNewUser[]> {
  const since = new Date();
  since.setDate(since.getDate() - NEW_USER_WINDOW_DAYS);

  return prisma.user.findMany({
    where: { createdAt: { gte: since } },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      isActive: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
    take: 10,
  });
}

function tally<K extends string>(
  rows: ({ _count: { _all: number } } & Record<K, string | null>)[],
  key: K,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const row of rows) {
    const value = row[key];
    if (value !== null) result[value] = row._count._all;
  }
  return result;
}

function emptyDashboard(
  isAdmin: boolean,
  newUsers: DashboardNewUser[] | null,
): DashboardData {
  return {
    scope: { projectIds: [], isAdmin },
    kpi: {
      projects: 0,
      openIssues: 0,
      openBugs: 0,
      inProgress: 0,
      completed: 0,
      highPriorityOpen: 0,
      createdThisMonth: 0,
      completedThisMonth: 0,
      completedLastMonth: 0,
      newProjectsThisMonth: 0,
      inProgressThisWeek: 0,
    },
    myWork: {
      assigned: 0,
      inProgress: 0,
      review: 0,
      completed: 0,
      overdue: 0,
      reported: 0,
    },
    due: { overdue: 0, today: 0, thisWeek: 0 },
    assigned: [],
    important: [],
    projects: [],
    teamMembers: [],
    byStatus: {},
    byPriority: {},
    byType: {},
    bySeverity: {},
    activity: [],
    org: null,
    newUsers,
    qa: null,
  };
}
