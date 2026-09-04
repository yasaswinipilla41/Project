import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  Avatar,
  Card,
  CardBody,
  EmptyState,
  Stat,
} from "@/components/ui/primitives";
import {
  IssueKey,
  IssueTypeIcon,
  PriorityIndicator,
  SeverityChip,
  StatusPill,
} from "@/components/ui/Indicators";
import {
  IconBug,
  IconCalendar,
  IconCheck,
  IconClock,
  IconEmptyBox,
  IconIssues,
  IconReports,
  IconUsers,
  IconWarning,
} from "@/components/ui/Icon";
import { StatusDonut } from "@/components/reports/StatusDonut";
import { projectScope } from "@/lib/authz";
import {
  AssignmentActivityList,
  type AssignmentActivityEntry,
} from "@/components/projects/AssignmentActivity";
import { ProjectAttachments } from "@/components/projects/ProjectAttachments";
import { ProjectMembers } from "@/components/projects/ProjectMembers";
import { ProjectAccess } from "@/components/projects/ProjectAccess";
import {
  ISSUE_STATUSES,
  ISSUE_TYPES,
  ISSUE_TYPE_LABEL,
  OPEN_STATUSES,
  PRIORITIES,
  PRIORITY_LABEL,
  SEVERITIES,
} from "@/lib/domain";
import { barWidth, dueWindow, formatRelative, percent } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { recordProjectVisit } from "@/lib/recents";
import { requireUser, type CurrentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Project overview: what this project is made of, and where it stands.
 *
 * Every figure on this page is **this project's**. Each query below carries
 * `projectId: project.id` — there is no global count anywhere on it, and no
 * number is derived from anything but the rows the database returns, so a
 * second project's summary can only ever describe that project.
 *
 * The date buckets read `dueWindow()` from `lib/format`, which is the same
 * definition Home and the issue list use. That matters more than it looks:
 * "due this week" means the current calendar week starting today, so overdue
 * work is never counted as due-this-week, and a second calculation here would
 * be free to disagree with the rest of Prio about what a week is.
 *
 * "Completed" means `DONE` and nothing else. Cancelled and Rejected are closed
 * too, but closing an issue because it was abandoned or because it turned out
 * not to be a defect is not the same as finishing it, and counting them
 * together would flatter the completion rate.
 */

async function loadProject(rawKey: string, user: CurrentUser) {
  return prisma.project.findFirst({
    where: { key: rawKey.toUpperCase(), ...projectScope(user) },
    select: {
      id: true,
      key: true,
      name: true,
      description: true,
      createdAt: true,
      createdById: true,
      createdBy: { select: { name: true } },
      members: {
        orderBy: { createdAt: "asc" },
        select: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              image: true,
              jobTitle: true,
            },
          },
        },
      },
      /*
       * Only the labels this project's work actually carries.
       *
       * A project owns labels whether or not anything uses them — every new
       * project starts with the canonical set — so listing all of them
       * described the vocabulary rather than the work. `some: {}` on the
       * relation keeps the ones with at least one issue behind them, which is
       * what a summary is for. Nothing cross-project can appear: a label
       * belongs to one project, and `createIssue` refuses a label from
       * another.
       */
      labels: {
        where: { issues: { some: {} } },
        select: { id: true, name: true, color: true },
        orderBy: { name: "asc" },
      },
      attachments: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          filename: true,
          mimeType: true,
          byteSize: true,
          createdAt: true,
          uploadedBy: { select: { id: true, name: true, image: true } },
        },
      },
    },
  });
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ key: string }>;
}): Promise<Metadata> {
  const { key } = await params;
  const user = await requireUser();
  const project = await loadProject(key, user);

  /*
   * Raised from metadata so the not-found page is decided before the page body
   * is built, rather than after a partial render.
   *
   * Note the response still carries HTTP 200: on Next 16.3.1 a `notFound()`
   * raised from a `force-dynamic` route renders the not-found page but does not
   * change the status, because the response has already been committed by the
   * time it is thrown. The reader sees the right page; automated clients
   * reading the status alone do not. Both this page and the issue page behave
   * the same way, and `tests/e2e/project-management.spec.ts` asserts the
   * rendered outcome rather than the code for that reason.
   */
  if (!project) notFound();

  return { title: project.name };
}

export default async function ProjectOverviewPage({
  params,
}: {
  params: Promise<{ key: string }>;
}) {
  const { key } = await params;
  const user = await requireUser();

  const project = await loadProject(key, user);
  if (!project) notFound();

  recordProjectVisit(user.id, project.id);

  /* One window for every date bucket below, read once so the cards, the
     "due" breakdown and the issue list can never be cut on different days. */
  const { startOfToday, endOfToday, endOfWeek } = dueWindow();
  const openStatuses = { in: [...OPEN_STATUSES] };

  const [
    byStatus,
    byPriority,
    bySeverity,
    byType,
    byAssignee,
    unassignedOpen,
    dueCounts,
    recentIssues,
    recentBugs,
    assignmentEntries,
  ] = await Promise.all([
      prisma.issue.groupBy({
        by: ["status"],
        where: { projectId: project.id },
        _count: { _all: true },
      }),
      prisma.issue.groupBy({
        by: ["priority"],
        where: { projectId: project.id },
        _count: { _all: true },
      }),
      prisma.issue.groupBy({
        by: ["severity"],
        where: { projectId: project.id, type: "BUG" },
        _count: { _all: true },
      }),
      prisma.issue.groupBy({
        by: ["type"],
        where: { projectId: project.id },
        _count: { _all: true },
      }),
      /* Open work per person, so the workload answers "who is carrying what
         right now" rather than "who has ever been given anything". Only
         assignees that appear on this project's issues — nobody from another
         project can reach this list. */
      prisma.issue.groupBy({
        by: ["assigneeId"],
        where: {
          projectId: project.id,
          status: openStatuses,
          assigneeId: { not: null },
        },
        _count: { _all: true },
        orderBy: { _count: { id: "desc" } },
      }),
      prisma.issue.count({
        where: {
          projectId: project.id,
          status: openStatuses,
          assigneeId: null,
        },
      }),
      /* The date buckets, in one round trip. Overdue and due-today/this-week
         are cut on the same boundaries the rest of Prio uses. */
      Promise.all([
        prisma.issue.count({
          where: {
            projectId: project.id,
            status: openStatuses,
            dueDate: { lt: startOfToday },
          },
        }),
        prisma.issue.count({
          where: {
            projectId: project.id,
            status: openStatuses,
            dueDate: { gte: startOfToday, lt: endOfToday },
          },
        }),
        prisma.issue.count({
          where: {
            projectId: project.id,
            status: openStatuses,
            dueDate: { gte: startOfToday, lt: endOfWeek },
          },
        }),
        prisma.issue.count({
          where: {
            projectId: project.id,
            status: openStatuses,
            dueDate: { gte: endOfWeek },
          },
        }),
        prisma.issue.count({
          where: { projectId: project.id, dueDate: null },
        }),
      ]),
      prisma.issue.findMany({
        where: { projectId: project.id },
        orderBy: { updatedAt: "desc" },
        take: 8,
        select: {
          key: true,
          title: true,
          type: true,
          status: true,
          priority: true,
          updatedAt: true,
          assignee: { select: { name: true, image: true } },
        },
      }),
      prisma.issue.findMany({
        where: { projectId: project.id, type: "BUG" },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: {
          key: true,
          title: true,
          status: true,
          priority: true,
          severity: true,
          createdAt: true,
        },
      }),
      // Assignment history (§31's existing activity trail, filtered to
      // `assigneeId` changes) — reassignments included, since each is its own
      // row already; "not null" excludes pure unassignments, which have no
      // one to name in "assigned ... to ...".
      prisma.activityLogEntry.findMany({
        where: {
          field: "assigneeId",
          newValue: { not: null },
          issue: { projectId: project.id },
        },
        select: {
          id: true,
          newValue: true,
          createdAt: true,
          actor: { select: { name: true, image: true } },
          issue: { select: { key: true, title: true, type: true } },
        },
        orderBy: { createdAt: "desc" },
        take: 8,
      }),
    ]);

  // `newValue` on an assigneeId change is the raw new assignee's user id, not
  // a name — resolved here rather than denormalized onto the activity row.
  const assigneeIds = [
    ...new Set(
      assignmentEntries
        .map((entry) => entry.newValue)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const assigneeUsers =
    assigneeIds.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: assigneeIds } },
          select: { id: true, name: true },
        })
      : [];
  const assigneeNameById = new Map(assigneeUsers.map((u) => [u.id, u.name]));

  const assignmentActivity: AssignmentActivityEntry[] = assignmentEntries.map(
    (entry) => ({
      id: entry.id,
      createdAt: entry.createdAt,
      actorName: entry.actor.name,
      actorImage: entry.actor.image,
      issueKey: entry.issue.key,
      issueTitle: entry.issue.title,
      issueType: entry.issue.type,
      assigneeName:
        (entry.newValue && assigneeNameById.get(entry.newValue)) || "someone",
    }),
  );

  const statusCount = (status: string) =>
    byStatus.find((r) => r.status === status)?._count._all ?? 0;

  /*
   * Membership is an administrator's action — `addProjectMember` and
   * `removeProjectMember` both assert it — so the candidate list is only
   * fetched for one, and only for people not already on the project.
   */
  const canManageMembers = user.role === "ADMIN";
  const memberIds = project.members.map(({ user: member }) => member.id);
  const personSelect = {
    id: true,
    name: true,
    email: true,
    image: true,
    jobTitle: true,
  } as const;

  const memberCandidates = canManageMembers
    ? await prisma.user.findMany({
        where: { isActive: true, id: { notIn: memberIds } },
        select: personSelect,
        orderBy: { name: "asc" },
      })
    : [];

  /*
   * Who a member may name in a share request: the colleagues they can already
   * see, meaning people who share some project with them. Never the whole
   * directory — Share must not become a way to enumerate the organisation.
   */
  const shareCandidates = canManageMembers
    ? []
    : await prisma.user.findMany({
        where: {
          isActive: true,
          id: { notIn: [...memberIds, user.id] },
          projectMemberships: {
            some: { project: { members: { some: { userId: user.id } } } },
          },
        },
        select: personSelect,
        orderBy: { name: "asc" },
      });

  const pendingAccess = canManageMembers
    ? await prisma.projectAccessRequest.findMany({
        where: { projectId: project.id, status: "PENDING" },
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          createdAt: true,
          message: true,
          requester: { select: { name: true, image: true } },
          subject: { select: { name: true, email: true, image: true } },
        },
      })
    : [];

  const total = byStatus.reduce((sum, r) => sum + r._count._all, 0);
  const open = byStatus
    .filter((r) => (OPEN_STATUSES as readonly string[]).includes(r.status))
    .reduce((sum, r) => sum + r._count._all, 0);

  /*
   * Completed means DONE.
   *
   * This used to sum `CLOSED_STATUSES`, which also holds Cancelled and
   * Rejected — so abandoning work or deciding it was never a defect counted
   * towards the completion rate. Closed and completed are different questions
   * and are answered separately below.
   */
  const done = statusCount("DONE");
  const cancelled = statusCount("CANCELLED");
  const rejected = statusCount("REJECTED");
  const reopened = statusCount("REOPENED");
  const readyForQa = statusCount("IN_REVIEW");
  const inQa = statusCount("IN_QA");
  const inProgress = statusCount("IN_PROGRESS");
  const remaining = total - done;

  const bugTotal = bySeverity.reduce((sum, r) => sum + r._count._all, 0);

  const [overdue, dueToday, dueThisWeek, upcoming, noDueDate] = dueCounts;

  const typeCount = (type: string) =>
    byType.find((r) => r.type === type)?._count._all ?? 0;
  const priorityCount = (priority: string) =>
    byPriority.find((r) => r.priority === priority)?._count._all ?? 0;

  /* Names for the workload rows, resolved in one query rather than per row.
     Only ids this project's own issues produced are looked up. */
  const workloadIds = byAssignee
    .map((row) => row.assigneeId)
    .filter((id): id is string => id !== null);
  const workloadPeople =
    workloadIds.length > 0
      ? await prisma.user.findMany({
          where: { id: { in: workloadIds } },
          select: { id: true, name: true, image: true },
        })
      : [];
  const workloadById = new Map(workloadPeople.map((person) => [person.id, person]));

  const workload = [
    ...byAssignee.flatMap((row) => {
      const person = row.assigneeId ? workloadById.get(row.assigneeId) : undefined;
      return person
        ? [{ id: person.id, name: person.name, image: person.image, count: row._count._all }]
        : [];
    }),
    ...(unassignedOpen > 0
      ? [{ id: "unassigned", name: "Unassigned", image: null, count: unassignedOpen }]
      : []),
  ];
  const workloadMax = Math.max(1, ...workload.map((row) => row.count));

  const dueBuckets = [
    { key: "overdue", label: "Overdue", count: overdue },
    { key: "today", label: "Due today", count: dueToday },
    { key: "week", label: "Due this week", count: dueThisWeek },
    { key: "upcoming", label: "Upcoming", count: upcoming },
    { key: "none", label: "No due date", count: noDueDate },
  ];
  const dueMax = Math.max(1, ...dueBuckets.map((row) => row.count));

  return (
    <>

      {/* --------------------------------------------------------- cards */}
      {/* Every figure here is this project's, and every one of them is a
          count the database returned rather than anything derived from a
          label or a guess. */}
      <div className="row g-3" style={{ marginBottom: "var(--prio-space-4)" }}>
        <div className="col-6 col-lg-4 col-xl-2">
          <Stat
            label="Total issues"
            value={total}
            icon={<IconIssues size={13} />}
            hint={total === 0 ? "Nothing filed yet" : `${open} still open`}
          />
        </div>
        <div className="col-6 col-lg-4 col-xl-2">
          <Stat
            label="Completed"
            value={done}
            icon={<IconCheck size={13} />}
            tone="success"
            hint={`${percent(done, total)}% of all work`}
          />
        </div>
        <div className="col-6 col-lg-4 col-xl-2">
          <Stat
            label="In Progress"
            value={inProgress}
            icon={<IconClock size={13} />}
            tone={inProgress > 0 ? "brand" : "default"}
            hint="Being worked on"
          />
        </div>
        <div className="col-6 col-lg-4 col-xl-2">
          <Stat
            label="Ready for QA"
            value={readyForQa}
            icon={<IconReports size={13} />}
            tone={readyForQa > 0 ? "warning" : "default"}
            hint={`${inQa} in QA`}
          />
        </div>
        <div className="col-6 col-lg-4 col-xl-2">
          <Stat
            label="Due this week"
            value={dueThisWeek}
            icon={<IconCalendar size={13} />}
            tone={dueThisWeek > 0 ? "warning" : "default"}
            hint={`${dueToday} due today`}
          />
        </div>
        <div className="col-6 col-lg-4 col-xl-2">
          <Stat
            label="Overdue"
            value={overdue}
            icon={<IconWarning size={13} />}
            tone={overdue > 0 ? "danger" : "default"}
            hint="Past their due date"
          />
        </div>
      </div>

      <div className="row g-3" style={{ marginBottom: "var(--prio-space-6)" }}>
        <div className="col-12 col-sm-6 col-xl-3">
          <Stat label="Open" value={open} tone="brand" hint="Not yet resolved" />
        </div>
        <div className="col-12 col-sm-6 col-xl-3">
          <Stat
            label="Bugs"
            value={bugTotal}
            icon={<IconBug size={13} />}
            tone={bugTotal > 0 ? "danger" : "default"}
            hint="All severities"
          />
        </div>
        <div className="col-12 col-sm-6 col-xl-3">
          <Stat
            label="Closed, not completed"
            value={cancelled + rejected}
            hint={`${cancelled} cancelled · ${rejected} rejected`}
          />
        </div>
        <div className="col-12 col-sm-6 col-xl-3">
          <Stat
            label="Members"
            value={project.members.length}
            icon={<IconUsers size={13} />}
            hint={`Created by ${project.createdBy.name}`}
          />
        </div>
      </div>

      <div className="row g-4">
        {/* ------------------------------------------------ distributions */}
        <div className="col-12 col-xl-8">
          {/* ------------------------------------------ status overview */}
          <Card className="prio-issue__section">
            <CardBody>
              <h2 className="prio-issue__section-title">Status overview</h2>
              <StatusDonut
                total={total}
                label={`Issues in ${project.name} by status`}
                data={ISSUE_STATUSES.map((status) => ({
                  status,
                  count: statusCount(status),
                }))}
              />
            </CardBody>
          </Card>

          {/* ---------------------------------------- completion and QA */}
          <div className="row g-4 prio-issue__section">
            <div className="col-12 col-md-6">
              <Card style={{ height: "100%" }}>
                <CardBody>
                  <h2 className="prio-issue__section-title">Completion</h2>
                  {total === 0 ? (
                    <p className="prio-text-muted">No issues yet.</p>
                  ) : (
                    <>
                      <div className="prio-progress" aria-hidden>
                        <div
                          className="prio-progress__bar"
                          style={{ width: `${percent(done, total)}%` }}
                        />
                      </div>
                      <p className="prio-summary__caption">
                        {percent(done, total)}% completed
                      </p>
                      <ul className="prio-breakdown">
                        <li className="prio-breakdown__row">
                          <span className="prio-breakdown__label">Total</span>
                          <span />
                          <span className="prio-breakdown__value">{total}</span>
                        </li>
                        <li className="prio-breakdown__row">
                          <span className="prio-breakdown__label">Completed</span>
                          <span />
                          <span className="prio-breakdown__value">{done}</span>
                        </li>
                        <li className="prio-breakdown__row">
                          <span className="prio-breakdown__label">Remaining</span>
                          <span />
                          <span className="prio-breakdown__value">{remaining}</span>
                        </li>
                        {/* Closed but not finished, kept apart from Completed
                            so the rate above cannot be inflated by them. */}
                        <li className="prio-breakdown__row">
                          <span className="prio-breakdown__label">Cancelled</span>
                          <span />
                          <span className="prio-breakdown__value">{cancelled}</span>
                        </li>
                        <li className="prio-breakdown__row">
                          <span className="prio-breakdown__label">
                            Reject / Not an Issue
                          </span>
                          <span />
                          <span className="prio-breakdown__value">{rejected}</span>
                        </li>
                      </ul>
                    </>
                  )}
                </CardBody>
              </Card>
            </div>

            <div className="col-12 col-md-6">
              <Card style={{ height: "100%" }}>
                <CardBody>
                  <h2 className="prio-issue__section-title">QA</h2>
                  {total === 0 ? (
                    <p className="prio-text-muted">No issues yet.</p>
                  ) : (
                    <ul className="prio-breakdown">
                      {[
                        { label: "Ready for QA", count: readyForQa },
                        { label: "In QA", count: inQa },
                        { label: "Completed after QA", count: done },
                        { label: "Reopened", count: reopened },
                      ].map((row) => (
                        <li key={row.label} className="prio-breakdown__row">
                          <span className="prio-breakdown__label">{row.label}</span>
                          <span className="prio-breakdown__track" aria-hidden>
                            <span
                              className="prio-breakdown__bar"
                              style={{ width: barWidth(row.count, total) }}
                            />
                          </span>
                          <span className="prio-breakdown__value">{row.count}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </CardBody>
              </Card>
            </div>
          </div>

          {/* --------------------------------------------- issue types */}
          <Card className="prio-issue__section">
            <CardBody>
              <h2 className="prio-issue__section-title">Issue types</h2>
              {total === 0 ? (
                <p className="prio-text-muted">No issues yet.</p>
              ) : (
                <ul className="prio-breakdown">
                  {ISSUE_TYPES.map((type) => {
                    const count = typeCount(type);
                    return (
                      <li key={type} className="prio-breakdown__row">
                        <span className="prio-breakdown__label">
                          <IssueTypeIcon type={type} size={15} />
                          {ISSUE_TYPE_LABEL[type]}
                        </span>
                        <span className="prio-breakdown__track" aria-hidden>
                          <span
                            className="prio-breakdown__bar"
                            style={{ width: barWidth(count, total) }}
                          />
                        </span>
                        <span className="prio-breakdown__value">
                          {count}
                          <span className="prio-breakdown__share">
                            {percent(count, total)}%
                          </span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardBody>
          </Card>

          {/* ------------------------------------------------- workload */}
          <Card className="prio-issue__section">
            <CardBody>
              <h2 className="prio-issue__section-title">Open work by assignee</h2>
              {workload.length === 0 ? (
                <p className="prio-text-muted">
                  No open work is assigned in this project.
                </p>
              ) : (
                <ul className="prio-breakdown">
                  {workload.map((row) => (
                    <li key={row.id} className="prio-breakdown__row">
                      <span className="prio-breakdown__label">
                        <Avatar
                          name={row.id === "unassigned" ? null : row.name}
                          image={row.image}
                          size="xs"
                          empty={row.id === "unassigned"}
                        />
                        <span className="prio-truncate">{row.name}</span>
                      </span>
                      <span className="prio-breakdown__track" aria-hidden>
                        <span
                          className="prio-breakdown__bar"
                          style={{ width: barWidth(row.count, workloadMax) }}
                        />
                      </span>
                      <span className="prio-breakdown__value">{row.count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          {/* ------------------------------------------------- due dates */}
          <Card className="prio-issue__section">
            <CardBody>
              <h2 className="prio-issue__section-title">Due dates</h2>
              {total === 0 ? (
                <p className="prio-text-muted">No issues yet.</p>
              ) : (
                <ul className="prio-breakdown">
                  {dueBuckets.map((row) => (
                    <li key={row.key} className="prio-breakdown__row">
                      <span className="prio-breakdown__label">{row.label}</span>
                      <span className="prio-breakdown__track" aria-hidden>
                        <span
                          className="prio-breakdown__bar"
                          style={{ width: barWidth(row.count, dueMax) }}
                        />
                      </span>
                      <span className="prio-breakdown__value">{row.count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardBody>
          </Card>

          <Card className="prio-issue__section">
            <CardBody>
              <h2 className="prio-issue__section-title">Status distribution</h2>
              {total === 0 ? (
                <p className="prio-text-muted">No issues yet.</p>
              ) : (
                <ul className="prio-distribution">
                  {ISSUE_STATUSES.map((status) => {
                    const count = statusCount(status);
                    return (
                      <li key={status} className="prio-distribution__row">
                        <span className="prio-distribution__label">
                          <StatusPill status={status} />
                        </span>
                        <span className="prio-distribution__track" aria-hidden>
                          <span
                            className="prio-distribution__bar"
                            data-status={status}
                            style={{ width: barWidth(count, total) }}
                          />
                        </span>
                        <span className="prio-distribution__value">{count}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardBody>
          </Card>

          <div className="row g-4 prio-issue__section">
            <div className="col-12 col-md-6">
              <Card style={{ height: "100%" }}>
                <CardBody>
                  <h2 className="prio-issue__section-title">
                    Priority distribution
                  </h2>
                  {total === 0 ? (
                    <p className="prio-text-muted">No issues yet.</p>
                  ) : (
                    /* Bars rather than bare counts: priority is the one
                       breakdown people read comparatively — "is most of this
                       urgent?" — and four numbers in a column do not answer
                       that at a glance. */
                    <ul className="prio-breakdown">
                      {PRIORITIES.map((priority) => {
                        const count = priorityCount(priority);
                        return (
                          <li key={priority} className="prio-breakdown__row">
                            <span className="prio-breakdown__label">
                              <PriorityIndicator
                                priority={priority}
                                showLabel={false}
                              />
                              {PRIORITY_LABEL[priority]}
                            </span>
                            <span className="prio-breakdown__track" aria-hidden>
                              <span
                                className="prio-breakdown__bar"
                                style={{ width: barWidth(count, total) }}
                              />
                            </span>
                            <span className="prio-breakdown__value">
                              {count}
                              <span className="prio-breakdown__share">
                                {percent(count, total)}%
                              </span>
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </CardBody>
              </Card>
            </div>

            <div className="col-12 col-md-6">
              <Card style={{ height: "100%" }}>
                <CardBody>
                  <h2 className="prio-issue__section-title">
                    Bug severity distribution
                  </h2>
                  {bugTotal === 0 ? (
                    <p className="prio-text-muted">No bugs reported.</p>
                  ) : (
                    <ul className="prio-distribution">
                      {SEVERITIES.map((severity) => {
                        const count =
                          bySeverity.find((r) => r.severity === severity)?._count
                            ._all ?? 0;
                        return (
                          <li key={severity} className="prio-distribution__row">
                            <span className="prio-distribution__label">
                              <SeverityChip severity={severity} />
                            </span>
                            <span className="prio-distribution__value">
                              {count}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </CardBody>
              </Card>
            </div>
          </div>

          {/* ----------------------------------------- recently updated */}
          <Card className="prio-issue__section">
            <CardBody>
              <h2 className="prio-issue__section-title">Recently updated</h2>
              {recentIssues.length === 0 ? (
                <EmptyState
                  icon={<IconEmptyBox />}
                  title="No issues found"
                  body="Create an issue to start tracking work."
                />
              ) : (
                <div>
                  {recentIssues.map((issue) => (
                    <Link
                      key={issue.key}
                      href={`/issues/${issue.key.toLowerCase()}`}
                      className="prio-relatedrow"
                    >
                      <IssueTypeIcon type={issue.type} size={17} />
                      <IssueKey issueKey={issue.key} />
                      <span className="prio-relatedrow__title prio-truncate">
                        {issue.title}
                      </span>
                      <PriorityIndicator
                        priority={issue.priority}
                        showLabel={false}
                      />
                      <StatusPill status={issue.status} />
                      {issue.assignee ? (
                        <Avatar
                          name={issue.assignee.name}
                          image={issue.assignee.image}
                          size="xs"
                        />
                      ) : (
                        <Avatar name={null} size="xs" empty />
                      )}
                    </Link>
                  ))}
                </div>
              )}
            </CardBody>
          </Card>

          {/* --------------------------------------------- assignment activity */}
          <Card className="prio-issue__section">
            <CardBody>
              <h2 className="prio-issue__section-title">Assignment activity</h2>
              <AssignmentActivityList entries={assignmentActivity} />
            </CardBody>
          </Card>
        </div>

        {/* -------------------------------------------------------- aside */}
        <div className="col-12 col-xl-4">
          <Card className="prio-issue__section">
            <CardBody>
              <h2 className="prio-issue__section-title">
                Recently reported bugs
              </h2>
              {recentBugs.length === 0 ? (
                <p className="prio-text-muted">
                  No bugs found. Create a bug to start tracking defects.
                </p>
              ) : (
                <div>
                  {recentBugs.map((bug) => (
                    <Link
                      key={bug.key}
                      href={`/issues/${bug.key.toLowerCase()}`}
                      className="prio-bugrow"
                    >
                      <span className="prio-bugrow__head">
                        <IssueTypeIcon type="BUG" size={16} />
                        <IssueKey issueKey={bug.key} />
                        <span className="prio-bugrow__time">
                          {formatRelative(bug.createdAt)}
                        </span>
                      </span>
                      <span className="prio-bugrow__title prio-clamp-2">
                        {bug.title}
                      </span>
                      <span className="prio-bugrow__meta">
                        <PriorityIndicator priority={bug.priority} />
                        {bug.severity ? (
                          <SeverityChip severity={bug.severity} />
                        ) : null}
                        <StatusPill status={bug.status} />
                      </span>
                    </Link>
                  ))}
                </div>
              )}
            </CardBody>
          </Card>

          <Card className="prio-issue__section">
            <CardBody>
              <ProjectMembers
                projectId={project.id}
                members={project.members.map(({ user: member }) => member)}
                candidates={memberCandidates}
                canManage={canManageMembers}
              />
              <ProjectAccess
                projectId={project.id}
                projectName={project.name}
                isAdmin={canManageMembers}
                candidates={shareCandidates}
                pending={pendingAccess}
              />
            </CardBody>
          </Card>

          <Card className="prio-issue__section">
            <CardBody>
              <ProjectAttachments
                projectId={project.id}
                attachments={project.attachments}
                currentUserId={user.id}
                isAdmin={user.role === "ADMIN"}
              />
            </CardBody>
          </Card>

          {project.labels.length > 0 ? (
            <Card className="prio-issue__section">
              <CardBody>
                <h2 className="prio-issue__section-title">Labels</h2>
                <div className="prio-labelrow">
                  {project.labels.map((label) => (
                    <span key={label.id} className="prio-label-chip">
                      <span
                        className="prio-label-chip__swatch"
                        style={{ background: label.color }}
                        aria-hidden
                      />
                      {label.name}
                    </span>
                  ))}
                </div>
              </CardBody>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
