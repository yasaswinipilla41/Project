import Link from "next/link";
import { Avatar, Card, CardBody, Stat } from "@/components/ui/primitives";
import {
  IssueKey,
  IssueTypeIcon,
  PriorityIndicator,
  SeverityChip,
  StatusPill,
} from "@/components/ui/Indicators";
import { IconBug, IconIssues, IconWarning } from "@/components/ui/Icon";
import {
  CLOSED_STATUSES,
  ISSUE_STATUSES,
  OPEN_STATUSES,
  PRIORITIES,
  SEVERITIES,
} from "@/lib/domain";
import { barWidth, formatRelative, percent } from "@/lib/format";
import { prisma } from "@/lib/prisma";

/**
 * The aggregations behind Reports, over whichever projects it is given.
 *
 * Lifted out of the Reports page unchanged so two surfaces share one
 * implementation: `/reports`, which passes every project the caller can see,
 * and the Flow Board's Insights, which passes the one project being looked at.
 * Only the scope varies; every figure, table and bar below is the same code
 * that has always drawn them.
 *
 * An async Server Component, so it runs its own queries where it is rendered
 * rather than needing its data threaded through the page that hosts it.
 */
function reportWindow(): { now: Date; weekAgo: Date } {
  const now = new Date();
  return { now, weekAgo: new Date(now.getTime() - 7 * 86_400_000) };
}

export async function InsightsPanel({
  projectIds,
}: {
  projectIds: string[];
}) {
  const { now, weekAgo } = reportWindow();
  const scope = { projectId: { in: projectIds } };

  const [
    byStatus,
    byPriority,
    bugsBySeverity,
    byAssignee,
    byProject,
    byLabel,
    createdRecently,
    resolvedRecently,
    overdue,
    oldestOpen,
    recentlyReportedBugs,
    totals,
  ] = await Promise.all([
    prisma.issue.groupBy({
      by: ["status"],
      where: scope,
      _count: { _all: true },
    }),
    prisma.issue.groupBy({
      by: ["priority"],
      where: scope,
      _count: { _all: true },
    }),
    prisma.issue.groupBy({
      by: ["severity"],
      where: { ...scope, type: "BUG" },
      _count: { _all: true },
    }),
    prisma.issue.groupBy({
      by: ["assigneeId"],
      where: { ...scope, status: { in: [...OPEN_STATUSES] } },
      _count: { _all: true },
      orderBy: { _count: { id: "desc" } },
      take: 12,
    }),
    prisma.issue.groupBy({
      by: ["projectId", "type"],
      where: scope,
      _count: { _all: true },
    }),
    prisma.issueLabel.groupBy({
      by: ["labelId"],
      where: { issue: scope },
      _count: { _all: true },
      orderBy: { _count: { labelId: "desc" } },
      take: 10,
    }),
    prisma.issue.count({ where: { ...scope, createdAt: { gte: weekAgo } } }),
    prisma.issue.count({ where: { ...scope, completedAt: { gte: weekAgo } } }),
    prisma.issue.count({
      where: {
        ...scope,
        dueDate: { lt: now },
        status: { notIn: [...CLOSED_STATUSES] },
      },
    }),
    prisma.issue.findFirst({
      where: { ...scope, status: { in: [...OPEN_STATUSES] } },
      orderBy: { createdAt: "asc" },
      select: { key: true, title: true, createdAt: true, type: true },
    }),
    prisma.issue.findMany({
      where: { ...scope, type: "BUG" },
      orderBy: { createdAt: "desc" },
      take: 6,
      select: {
        id: true,
        key: true,
        title: true,
        status: true,
        priority: true,
        severity: true,
        createdAt: true,
      },
    }),
    prisma.issue.aggregate({ where: scope, _count: { _all: true } }),
  ]);

  // Resolve the ids the groupings return, in one query each, not per row.
  const assigneeIds = byAssignee
    .map((r) => r.assigneeId)
    .filter((id): id is string => id !== null);

  const [people, projects, labels] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: assigneeIds } },
      select: { id: true, name: true, image: true },
    }),
    prisma.project.findMany({
      where: { id: { in: projectIds } },
      select: { id: true, key: true, name: true },
      /* Newest first, and ordered by the database rather than by whatever
         order the ids happened to arrive in — so a project created a moment
         ago is at the top, and stays there across a refresh or a new
         session. */
      orderBy: { createdAt: "desc" },
    }),
    prisma.label.findMany({
      where: { id: { in: byLabel.map((r) => r.labelId) } },
      select: { id: true, name: true, color: true },
    }),
  ]);

  const personById = new Map(people.map((p) => [p.id, p]));
  const labelById = new Map(labels.map((l) => [l.id, l]));

  const total = totals._count._all;
  const statusCount = (s: string) =>
    byStatus.find((r) => r.status === s)?._count._all ?? 0;

  const open = OPEN_STATUSES.reduce((sum, s) => sum + statusCount(s), 0);
  const done = statusCount("DONE");
  const cancelled = statusCount("CANCELLED");

  const bugTotal = bugsBySeverity.reduce((sum, r) => sum + r._count._all, 0);
  const openBugs = byProject
    .filter((r) => r.type === "BUG")
    .reduce((sum, r) => sum + r._count._all, 0);

  const ageDays = oldestOpen
    ? Math.floor((now.getTime() - oldestOpen.createdAt.getTime()) / 86_400_000)
    : 0;

  const maxAssignee = Math.max(1, ...byAssignee.map((r) => r._count._all));

  return (
    <>
      {/* ------------------------------------------------------ headline */}
      <div className="row g-3" style={{ marginBottom: "var(--prio-space-6)" }}>
        <div className="col-6 col-xl-3">
          {/* The figure counts every issue across the projects this person
              can see, which is exactly what an unfiltered /issues renders —
              the list applies the same `issueScope`, so the destination
              cannot show more than the number claimed here. */}
          <Stat
            label="Total issues"
            value={total}
            icon={<IconIssues size={13} />}
            hint={`${done} done · ${cancelled} cancelled`}
            href="/issues"
          />
        </div>
        <div className="col-6 col-xl-3">
          <Stat
            label="Open"
            value={open}
            tone="brand"
            hint={`${percent(done, total)}% of all work completed`}
          />
        </div>
        <div className="col-6 col-xl-3">
          <Stat
            label="Bugs"
            value={bugTotal}
            icon={<IconBug size={13} />}
            tone={bugTotal > 0 ? "danger" : "default"}
            hint={`${openBugs} tracked in total`}
          />
        </div>
        <div className="col-6 col-xl-3">
          <Stat
            label="Overdue"
            value={overdue}
            icon={<IconWarning size={13} />}
            tone={overdue > 0 ? "danger" : "success"}
            hint="Open, past due date"
          />
        </div>
      </div>

      <div className="row g-3" style={{ marginBottom: "var(--prio-space-6)" }}>
        <div className="col-6 col-xl-3">
          <Stat label="Created this week" value={createdRecently} hint="Last 7 days" />
        </div>
        <div className="col-6 col-xl-3">
          <Stat
            label="Resolved this week"
            value={resolvedRecently}
            tone={resolvedRecently >= createdRecently ? "success" : "warning"}
            hint={
              resolvedRecently >= createdRecently
                ? "Keeping pace with new work"
                : "Falling behind new work"
            }
          />
        </div>
        <div className="col-6 col-xl-3">
          <Stat
            label="Oldest open item"
            value={`${ageDays}d`}
            hint={oldestOpen ? oldestOpen.key : "Nothing open"}
          />
        </div>
        <div className="col-6 col-xl-3">
          <Stat
            label="Ready for QA"
            value={statusCount("IN_REVIEW")}
            hint="Awaiting sign-off"
          />
        </div>
      </div>

      <div className="row g-4">
        {/* ------------------------------------------- status + priority */}
        <div className="col-12 col-xl-6">
          <Card style={{ height: "100%" }}>
            <CardBody>
              <h2 className="prio-issue__section-title">Issues by status</h2>
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
            </CardBody>
          </Card>
        </div>

        <div className="col-12 col-xl-6">
          <Card style={{ height: "100%" }}>
            <CardBody>
              <h2 className="prio-issue__section-title">Issues by priority</h2>
              <ul className="prio-distribution">
                {PRIORITIES.map((priority) => {
                  const count =
                    byPriority.find((r) => r.priority === priority)?._count._all ?? 0;
                  return (
                    <li key={priority} className="prio-distribution__row">
                      <span className="prio-distribution__label">
                        <PriorityIndicator priority={priority} />
                      </span>
                      <span className="prio-distribution__track" aria-hidden>
                        <span
                          className="prio-distribution__bar"
                          style={{ width: barWidth(count, total) }}
                        />
                      </span>
                      <span className="prio-distribution__value">{count}</span>
                    </li>
                  );
                })}
              </ul>
            </CardBody>
          </Card>
        </div>

        {/* ------------------------------------------------ bug severity */}
        <div className="col-12 col-xl-6">
          <Card style={{ height: "100%" }}>
            <CardBody>
              <h2 className="prio-issue__section-title">
                <IconBug size={14} />
                Bugs by severity
              </h2>
              {bugTotal === 0 ? (
                <p className="prio-text-muted">No bugs reported.</p>
              ) : (
                <ul className="prio-distribution">
                  {SEVERITIES.map((severity) => {
                    const count =
                      bugsBySeverity.find((r) => r.severity === severity)?._count
                        ._all ?? 0;
                    return (
                      <li key={severity} className="prio-distribution__row">
                        <span className="prio-distribution__label">
                          <SeverityChip severity={severity} />
                        </span>
                        <span className="prio-distribution__track" aria-hidden>
                          <span
                            className="prio-distribution__bar"
                            style={{ width: barWidth(count, bugTotal) }}
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
        </div>

        {/* --------------------------------------------------- workload */}
        <div className="col-12 col-xl-6">
          <Card style={{ height: "100%" }}>
            <CardBody>
              <h2 className="prio-issue__section-title">
                Open work by assignee
              </h2>
              {byAssignee.length === 0 ? (
                <p className="prio-text-muted">Nothing is open.</p>
              ) : (
                <ul className="prio-distribution">
                  {byAssignee.map((row) => {
                    const person = row.assigneeId
                      ? personById.get(row.assigneeId)
                      : null;
                    const count = row._count._all;
                    return (
                      <li
                        key={row.assigneeId ?? "unassigned"}
                        className="prio-distribution__row"
                      >
                        <span className="prio-distribution__label prio-person">
                          <Avatar
                            name={person?.name ?? null}
                            image={person?.image}
                            size="xs"
                            empty={!person}
                          />
                          <span className="prio-truncate">
                            {person?.name ?? "Unassigned"}
                          </span>
                        </span>
                        <span className="prio-distribution__track" aria-hidden>
                          <span
                            className="prio-distribution__bar"
                            style={{ width: barWidth(count, maxAssignee) }}
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
        </div>

        {/* ---------------------------------------------------- projects */}
        <div className="col-12 col-xl-6">
          <Card style={{ height: "100%" }}>
            <CardBody>
              <h2 className="prio-issue__section-title">By project</h2>
              <div className="prio-table-wrap prio-scroll">
                <table className="prio-table prio-table--compact">
                  <thead>
                    <tr>
                      <th scope="col">Project</th>
                      <th scope="col">Tasks</th>
                      <th scope="col">Stories</th>
                      <th scope="col">Bugs</th>
                      <th scope="col">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {projects.map((project) => {
                      const rows = byProject.filter(
                        (r) => r.projectId === project.id,
                      );
                      const count = (t: string) =>
                        rows.find((r) => r.type === t)?._count._all ?? 0;
                      const sum = rows.reduce((s, r) => s + r._count._all, 0);

                      return (
                        <tr key={project.id}>
                          <td>
                            <Link href={`/projects/${project.key.toLowerCase()}`}>
                              {project.name}
                            </Link>
                          </td>
                          <td>{count("TASK")}</td>
                          <td>{count("STORY")}</td>
                          <td>{count("BUG")}</td>
                          <td>
                            <strong>{sum}</strong>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardBody>
          </Card>
        </div>

        {/* ------------------------------------------------------ labels */}
        <div className="col-12 col-xl-6">
          <Card style={{ height: "100%" }}>
            <CardBody>
              <h2 className="prio-issue__section-title">Most used labels</h2>
              {byLabel.length === 0 ? (
                <p className="prio-text-muted">No labels in use yet.</p>
              ) : (
                <ul className="prio-distribution">
                  {byLabel.map((row) => {
                    const label = labelById.get(row.labelId);
                    if (!label) return null;
                    const max = Math.max(
                      1,
                      ...byLabel.map((r) => r._count._all),
                    );
                    return (
                      <li key={row.labelId} className="prio-distribution__row">
                        <span className="prio-distribution__label">
                          <span className="prio-label-chip">
                            <span
                              className="prio-label-chip__swatch"
                              style={{ background: label.color }}
                              aria-hidden
                            />
                            {label.name}
                          </span>
                        </span>
                        <span className="prio-distribution__track" aria-hidden>
                          <span
                            className="prio-distribution__bar"
                            style={{
                              width: barWidth(row._count._all, max),
                            }}
                          />
                        </span>
                        <span className="prio-distribution__value">
                          {row._count._all}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardBody>
          </Card>
        </div>

        {/* ------------------------------------------ recently reported */}
        <div className="col-12">
          <Card>
            <CardBody>
              <h2 className="prio-issue__section-title">
                Recently reported bugs
              </h2>
              {recentlyReportedBugs.length === 0 ? (
                <p className="prio-text-muted">No bugs reported yet.</p>
              ) : (
                recentlyReportedBugs.map((bug) => (
                  <Link
                    key={bug.id}
                    href={`/issues/${bug.key.toLowerCase()}`}
                    className="prio-relatedrow"
                  >
                    <IssueTypeIcon type="BUG" size={17} />
                    <IssueKey issueKey={bug.key} />
                    <span className="prio-relatedrow__title prio-truncate">
                      {bug.title}
                    </span>
                    {bug.severity ? <SeverityChip severity={bug.severity} /> : null}
                    <PriorityIndicator priority={bug.priority} showLabel={false} />
                    <StatusPill status={bug.status} />
                    <span className="prio-text-muted prio-searchresults__project">
                      {formatRelative(bug.createdAt)}
                    </span>
                  </Link>
                ))
              )}
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
