import type { IssueStatus, IssueType, Prisma, Priority, Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { dueWindow, monthWindow } from "@/lib/format";
import { accessibleProjectIds, workRoleOf } from "@/lib/authz";
import {
  dueThisWeekFilter,
  dueTodayFilter,
  overdueFilter,
} from "@/server/queries/due";
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
  /** Being tested right now — the other half of a tester's own queue. */
  inQa: number;
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
  /** The viewer themselves, so the list can say so rather than omit them. */
  isYou: boolean;
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
  activity: DashboardActivity[];
  /** Present only for admins. */
  org: {
    users: number;
    activeUsers: number;
    admins: number;
    totalIssues: number;
    openBugs: number;
    urgentOpen: number;
    unassignedOpen: number;
    workload: { id: string; name: string; image: string | null; open: number }[];
  } | null;
  /** Present only for admins — see `DashboardNewUser`. */
  newUsers: DashboardNewUser[] | null;
  /**
   * QA figures, for whoever the panel is for.
   *
   * Two people see it. A tester — a member on the Testing team — always does,
   * because verifying is their job whatever their history looks like. So does
   * anyone whose own history is bug-led, which is how this worked before Prio
   * could tell a tester from a developer at all, and still does: nobody who
   * used to have this panel has lost it.
   *
   * `isTester` says which of the two, and the only thing it changes is what
   * the panel is about: a tester's queue is what has been assigned to them and
   * is waiting to be checked, while a reporter's is the bugs they raised.
   */
  qa: {
    isTester: boolean;
    reportedByMe: number;
    bugsReportedByMe: number;
    awaitingVerification: number;
    readyForQa: number;
    urgentOpen: number;
    resolvedThisWeek: number;
  } | null;
}

/** Day boundaries used across the buckets, computed once per request. */
function windows() {
  const now = new Date();

  /* Shared with the issue list, so the counts here and the rows it shows when
     one is clicked are cut on the same boundaries. */
  const { startOfToday, endOfToday, endOfWeek } = dueWindow(now);

  /* Shared with the issue list's `completedWithin` filter, so the figure on
     the card and the list it opens are cut on the same boundaries. */
  const { startOfMonth, startOfNextMonth, startOfLastMonth } = monthWindow(now);

  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);

  return {
    now,
    startOfToday,
    endOfToday,
    endOfWeek,
    startOfMonth,
    startOfNextMonth,
    startOfLastMonth,
    weekAgo,
  };
}

/**
 * "Not a completion, or one of mine" — the disjunction that scopes Home's feed.
 *
 * A completion is an entry whose field is `status` and whose new value is
 * `DONE`; nothing else on the feed is addressed to anybody. The negation is
 * written as two nullable-safe arms rather than one `NOT`, because `field` and
 * `newValue` are both nullable columns and `NOT (field = 'status' AND newValue
 * = 'DONE')` is NULL — and therefore false — for a row where either is null.
 * A comment or an attachment entry would silently vanish from the feed.
 *
 * Administrators never reach this: they are recipients of every completion by
 * rule, so their feed is the project's whole history.
 */
function notACompletionOrTheirs(userId: string): Prisma.ActivityLogEntryWhereInput[] {
  return [
    { field: null },
    { field: { not: "status" } },
    { newValue: null },
    { newValue: { not: "DONE" } },
    /* The three recipients. The administrators are covered above; these two
       are the person who moved it and the person who was holding it. */
    { actorId: userId },
    { issue: { assigneeId: userId } },
  ];
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
        /*
         * "Needs attention" means someone has to do something, so every arm
         * here is a real workflow state rather than an opinion about impact:
         * overdue, blocked or failed QA, and waiting on QA. `testResult`
         * BLOCKED and FAILED are the values `TestResult` already carries —
         * no new concept was invented to fill this section.
         */
        OR: [
          { priority: { in: ["URGENT", "HIGH"] } },
          /*
           * Overdue, by the one definition of it.
           *
           * This read `dueDate < now`, which made work due at nine this
           * morning "needing attention" by ten — while Overdue everywhere else
           * counts from the start of today and would not list it until
           * tomorrow. Two answers to the same question, and this was the last
           * place still giving the second one.
           */
          overdueFilter(w.now),
          { testResult: { in: ["BLOCKED", "FAILED"] } },
          { status: "IN_REVIEW" },
        ],
        /*
         * An administrator is answering "what is stuck across the org", so
         * theirs stays org-wide within their scope. For everyone else the
         * question is "what is stuck for me" — a member cannot act on a
         * teammate's overdue work, and listing it buries their own.
         */
        ...(isAdmin
          ? {}
          : {
              AND: [
                { OR: [{ assigneeId: user.id }, { reporterId: user.id }] },
              ],
            }),
      },
      select: ISSUE_SELECT,
      orderBy: [{ priority: "asc" }, { updatedAt: "desc" }],
      take: 6,
    }),
    prisma.activityLogEntry.findMany({
      /*
       * The project's activity, scoped to the projects this person can open —
       * with one entry addressed rather than broadcast.
       *
       * A completion is the end of a piece of work and reaches exactly the
       * three people it is about: whoever moved it to Done, whoever was
       * holding it, and the administrators. Sharing the project is
       * deliberately not enough. Everything else on the feed is unchanged and
       * is still the project's news, which is why the exclusion names the one
       * shape it applies to rather than filtering status changes generally.
       *
       * Deduplication is a property of the query rather than a step after it:
       * one activity row is one row however many of the three categories the
       * reader happens to occupy, so somebody who finished their own work sees
       * a single entry.
       */
      where: {
        issue: scope,
        ...(isAdmin ? {} : { OR: notACompletionOrTheirs(user.id) }),
      },
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
      /*
       * Newest first, which this was missing.
       *
       * The cap is fine -- this only decides which unacknowledged assignments
       * are worth surfacing, and nobody reads more than a screenful. Taking
       * fifty of them in whatever order the database happened to return was
       * not: somebody with a large unread backlog could have their *newest*
       * assignment fall outside the fifty and drop out of the list entirely,
       * which is the exact failure the surrounding code exists to prevent.
       * The comment below already says these lead "most recent first"; this
       * makes the query agree with it.
       */
      orderBy: { createdAt: "desc" },
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
      where: { ...scope, ...overdueFilter(w.now) },
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
  /*
   * The viewer belongs on their own team. They are normally already in
   * `teammateRows` through a membership row, but an administrator can reach a
   * project without being a member of it — so they are added explicitly when
   * missing rather than left looking absent from their own team.
   */
  const teamRows = teammateRows.some((person) => person.id === user.id)
    ? teammateRows
    : [
        {
          id: user.id,
          name: user.name,
          image: user.image,
          role: user.role,
          isActive: true,
        },
        ...teammateRows,
      ];

  const teamMembers: DashboardTeammate[] = teamRows
    .map((person) => ({
      id: person.id,
      name: person.name,
      image: person.image,
      role: person.role,
      isActive: person.isActive,
      openInScope: openInScopeById.get(person.id) ?? 0,
      isYou: person.id === user.id,
    }))
    // The viewer leads the list; everyone else keeps the query's name order.
    .sort((a, b) => Number(b.isYou) - Number(a.isYou));

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
    myInQa,
    myCompleted,
    myOverdue,
    myReported,
    overdue,
    dueToday,
    dueThisWeek,
    bugsReportedByMe,
    awaitingVerification,
    urgentOpen,
    resolvedThisWeek,
    readyForQa,
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
    /*
     * Completed means DONE, and nothing else.
     *
     * These used to count every issue with a `completedAt` in range, whatever
     * its status — and `updateIssue` writes `completedAt` for CANCELLED as
     * well as for DONE. Cancelling an issue therefore raised "completed this
     * month" while the "N completed in total" beneath it, which counts
     * `status: DONE`, did not move: one card, two different definitions of
     * completed, disagreeing with each other. This is the definition the
     * project summary already uses — abandoning work is not finishing it.
     *
     * The upper bound matters too: without it a `completedAt` in the future
     * counted as this month's.
     */
    prisma.issue.count({
      where: {
        ...scope,
        status: "DONE",
        completedAt: { gte: w.startOfMonth, lt: w.startOfNextMonth },
      },
    }),
    prisma.issue.count({
      where: {
        ...scope,
        status: "DONE",
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
    /* Work this person is testing now. Ready for QA is what has been handed
       to them; this is what they have picked up, and a tester's own queue is
       both — so My work shows the pair rather than only the first half. */
    prisma.issue.count({ where: { ...mine, status: "IN_QA" } }),
    /*
     * Completed means DONE, and nothing else.
     *
     * This counted every closed status — DONE, REJECTED and CANCELLED — while
     * the tile beneath it links to `status=DONE`, so anybody holding rejected
     * or cancelled work saw a figure larger than the list it opened. Two
     * definitions of "completed" on one tile, which is the fault
     * `completed-metric.test.ts` already pins for the organization-wide card
     * and for `kpi.completed`; the personal one was missed.
     *
     * Rejected is "not an issue" and cancelled is work abandoned. Neither was
     * finished, and neither belongs under a heading that says it was.
     */
    prisma.issue.count({ where: { ...mine, status: "DONE" } }),
    prisma.issue.count({
      where: { ...mine, ...overdueFilter(w.now) },
    }),
    prisma.issue.count({ where: { ...scope, reporterId: user.id } }),

    prisma.issue.count({
      where: { ...mine, ...overdueFilter(w.now) },
    }),
    prisma.issue.count({
      where: { ...mine, ...dueTodayFilter(w.now) },
    }),
    /* Due this week: the whole of the current calendar week, from its first
       moment — `[startOfWeek, startOfNextWeek)`. It overlaps the two buckets
       above by design, because work due on Monday and read on Wednesday is
       both overdue and due this week. The same fragment `dueWeek=1` filters
       on, so the number and the list it opens cannot disagree. */
    prisma.issue.count({ where: { ...mine, ...dueThisWeekFilter(w.now) } }),

    prisma.issue.count({
      where: { ...scope, reporterId: user.id, type: "BUG" },
    }),
    prisma.issue.count({
      where: { ...scope, reporterId: user.id, type: "BUG", status: "IN_REVIEW" },
    }),
    prisma.issue.count({
      where: { ...scope, type: "BUG", priority: "URGENT", status: open },
    }),
    prisma.issue.count({
      where: { ...scope, type: "BUG", completedAt: { gte: w.weekAgo } },
    }),
    /*
     * The tester's queue: what has been handed back for *them* to check.
     *
     * This used to count every IN_REVIEW issue anywhere the person could see,
     * whoever it belonged to — so a QA member's queue included work assigned
     * to their colleagues, work assigned to a developer, and work nobody had
     * picked up. The figure was the project's backlog of unchecked work rather
     * than the reader's own, and the tile that showed it opened a list that did
     * not match it.
     *
     * `mine` is `scope` plus `assigneeId`, so all three conditions hold at
     * once: assigned to this person, in a project they may open, and waiting
     * for QA. Everything else is somebody else's queue.
     */
    prisma.issue.count({ where: { ...mine, status: "IN_REVIEW" } }),
  ]);

  /* Does this person check work? A full stack developer does — they are on
     Testing — so the panel is theirs as much as a pure tester's. An
     administrator is not a tester; nothing is withheld from them, but their
     dashboard is the organization's rather than a queue of their own. */
  const role = await workRoleOf(user);
  const isTester = role === "QA" || role === "FULLSTACK";

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
      inQa: myInQa,
      completed: myCompleted,
      overdue: myOverdue,
      reported: myReported,
    },
    due: { overdue, today: dueToday, thisWeek: dueThisWeek },
    /*
     * Shown to a tester outright — the Testing team is what makes somebody
     * one, and it is not a guess — and, as before, to anyone whose own history
     * is bug-led: they have reported bugs and report more than they are
     * assigned. The second case is kept so that nobody who had this panel
     * before Prio knew what a tester was has lost it.
     */
    qa:
      isTester || (bugsReportedByMe > 0 && myReported >= myAssigned)
        ? {
            isTester,
            reportedByMe: myReported,
            bugsReportedByMe,
            awaitingVerification,
            readyForQa,
            urgentOpen,
            resolvedThisWeek,
          }
        : null,
  };
}

/** Organization-wide figures, admin only. */
async function loadOrgStats() {
  const open = { in: [...OPEN_STATUSES] };

  const [users, activeUsers, admins, totalIssues, openBugs, urgentOpen, unassignedOpen, workloadRows] =
    await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { isActive: true } }),
      prisma.user.count({ where: { role: "ADMIN", isActive: true } }),
      prisma.issue.count(),
      prisma.issue.count({ where: { type: "BUG", status: open } }),
      prisma.issue.count({
        where: { type: "BUG", priority: "URGENT", status: open },
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
    urgentOpen,
    unassignedOpen,
    workload: workloadRows.flatMap((row) => {
      const person = row.assigneeId ? byId.get(row.assigneeId) : undefined;
      return person ? [{ ...person, open: row._count._all }] : [];
    }),
  };
}

/** How far back "new" reaches before Admin Home stops calling someone new. */
const NEW_USER_WINDOW_DAYS = 14;

/**
 * Recently joined people, newest first — admin only, org-wide.
 *
 * Exported so Administration can render the same list from the same query
 * rather than growing a second one beside it.
 */
export async function loadNewUsers(): Promise<DashboardNewUser[]> {
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
      inQa: 0,
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
    activity: [],
    org: null,
    newUsers,
    qa: null,
  };
}
