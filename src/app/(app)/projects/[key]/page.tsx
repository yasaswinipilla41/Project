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
  IconBoard,
  IconBug,
  IconEmptyBox,
  IconIssues,
  IconSettings,
  IconUsers,
} from "@/components/ui/Icon";
import { canManageProject, projectScope } from "@/lib/authz";
import {
  AssignmentActivityList,
  type AssignmentActivityEntry,
} from "@/components/projects/AssignmentActivity";
import { ProjectActions } from "@/components/projects/ProjectActions";
import { ProjectAttachments } from "@/components/projects/ProjectAttachments";
import { ProjectMembers } from "@/components/projects/ProjectMembers";
import { ProjectAccess } from "@/components/projects/ProjectAccess";
import { ProjectNav } from "@/components/projects/ProjectNav";
import { BackLink } from "@/components/shell/BackLink";
import {
  CLOSED_STATUSES,
  ISSUE_STATUSES,
  OPEN_STATUSES,
  PRIORITIES,
  SEVERITIES,
} from "@/lib/domain";
import { barWidth, formatRelative } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { recordProjectVisit } from "@/lib/recents";
import { requireUser, type CurrentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Project overview (§21). Board, list, backlog, timeline and reports arrive in
 * later checkpoints; this page shows the project's real composition today.
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
      labels: { select: { id: true, name: true, color: true } },
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

  const [byStatus, byPriority, bySeverity, recentIssues, recentBugs, assignmentEntries] =
    await Promise.all([
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
  const done = byStatus
    .filter((r) => (CLOSED_STATUSES as readonly string[]).includes(r.status))
    .reduce((sum, r) => sum + r._count._all, 0);
  const bugTotal = bySeverity.reduce((sum, r) => sum + r._count._all, 0);

  return (
    <>
      <div className="prio-page-header">
        <div className="prio-page-header__text">
          <BackLink href="/projects" label="All projects" />
          <div className="prio-projecthead">
            <span className="prio-projectcard__badge" aria-hidden>
              {project.key.slice(0, 2)}
            </span>
            <div style={{ minWidth: 0 }}>
              <h1 className="prio-page-header__title">
                {project.name}
                <span className="prio-key">{project.key}</span>
              </h1>
              <p className="prio-page-header__subtitle">
                {project.description ??
                  "No description yet."}
              </p>
            </div>
          </div>
        </div>

        <div className="prio-page-header__actions">
          <Link
            href={`/projects/${project.key.toLowerCase()}/board`}
            className="prio-btn prio-btn--secondary"
          >
            <IconBoard />
            Board
          </Link>
          <Link
            href={`/issues?project=${project.id}`}
            className="prio-btn prio-btn--secondary"
          >
            <IconIssues />
            Issues
          </Link>
          <Link
            href={`/bugs?project=${project.id}`}
            className="prio-btn prio-btn--secondary"
          >
            <IconBug />
            Bugs
          </Link>
          {user.role === "ADMIN" ? (
            <Link
              href={`/projects/${project.key.toLowerCase()}/settings`}
              className="prio-btn prio-btn--secondary"
            >
              <IconSettings />
              Settings
            </Link>
          ) : null}

          {/*
           * Edit and Delete appear for an administrator or for the person who
           * created this project — never for another member of it. The server
           * enforces the same rule inside `updateProject` and `deleteProject`,
           * so this only decides what is worth showing.
           */}
          {canManageProject(user, project) ? (
            <ProjectActions
              project={{
                id: project.id,
                key: project.key,
                name: project.name,
                description: project.description,
              }}
              issueCount={total}
            />
          ) : null}
        </div>
      </div>

      <ProjectNav
        projectKey={project.key}
        projectId={project.id}
        active="summary"
      />

      <div className="row g-3" style={{ marginBottom: "var(--prio-space-6)" }}>
        <div className="col-12 col-sm-6 col-xl-3">
          <Stat
            label="Total issues"
            value={total}
            icon={<IconIssues size={13} />}
            hint={`${done} completed`}
          />
        </div>
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
                    <ul className="prio-distribution">
                      {PRIORITIES.map((priority) => {
                        const count =
                          byPriority.find((r) => r.priority === priority)?._count
                            ._all ?? 0;
                        return (
                          <li key={priority} className="prio-distribution__row">
                            <span className="prio-distribution__label">
                              <PriorityIndicator priority={priority} />
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
