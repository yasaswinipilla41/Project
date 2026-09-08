import Link from "next/link";
import { MemberDetailButton } from "@/components/dashboard/MemberDetailDialog";
import { Avatar, Card, CardBody } from "@/components/ui/primitives";
import {
  IssueKey,
  IssueTypeIcon,
  PriorityIndicator,
  SeverityChip,
  StatusPill,
} from "@/components/ui/Indicators";
import { IconCalendar, IconClock, IconWarning } from "@/components/ui/Icon";
import {
  ISSUE_STATUSES,
  PRIORITIES,
  ROLE_DESCRIPTION,
  ROLE_LABEL,
  STATUS_LABEL,
  WORK_ROLE_DESCRIPTION,
  WORK_ROLE_LABEL,
  type WorkRole,
} from "@/lib/domain";
import {
  daysUntil,
  formatDateCompact,
  barWidth,
  formatDateTime,
  formatRelative,
  humanizeActivity,
  percent,
} from "@/lib/format";
import type { Role } from "@prisma/client";
import type {
  DashboardActivity,
  DashboardIssue,
  DashboardProject,
  WorkSummary,
} from "@/server/queries/dashboard";

/**
 * The building blocks of the home dashboard.
 *
 * All server components: the dashboard is read-only, so none of this needs to
 * ship JavaScript. Every value arrives already aggregated from the database.
 */

/* ------------------------------------------------------------ assigned row */

/**
 * A row in "My assigned tasks" (§9).
 *
 * The due date drives the visual weight: overdue is a warning, due today is
 * urgent-but-fine, everything else is quiet. Colour is used to mean something,
 * not to decorate.
 */
export function AssignedRow({
  issue,
}: {
  issue: DashboardIssue & { isNewAssignment?: boolean };
}) {
  const days = daysUntil(issue.dueDate);
  const dueState =
    days === null
      ? null
      : days < 0
        ? "overdue"
        : days === 0
          ? "today"
          : days <= 7
            ? "soon"
            : "later";

  return (
    <Link
      href={`/issues/${issue.key.toLowerCase()}`}
      className="prio-assigned"
      data-priority={issue.priority}
      data-due={dueState ?? undefined}
      data-new={issue.isNewAssignment || undefined}
    >
      <span className="prio-assigned__rail" aria-hidden />

      <span className="prio-assigned__head">
        {issue.isNewAssignment ? (
          <span className="prio-badge prio-badge--pill" data-tone="brand">
            New
          </span>
        ) : null}
        <IssueTypeIcon type={issue.type} size={18} />
        <IssueKey issueKey={issue.key} />
        <span className="prio-assigned__project">{issue.project.name}</span>
        <span className="prio-assigned__updated">
          {formatRelative(issue.updatedAt)}
        </span>
      </span>

      <span className="prio-assigned__title">{issue.title}</span>

      <span className="prio-assigned__meta">
        <StatusPill status={issue.status} />
        <PriorityIndicator priority={issue.priority} />
        {issue.severity ? <SeverityChip severity={issue.severity} /> : null}

        {issue.dueDate ? (
          <span className="prio-assigned__due" data-state={dueState}>
            {dueState === "overdue" ? (
              <IconWarning size={12} />
            ) : (
              <IconCalendar size={12} />
            )}
            {dueState === "overdue"
              ? `Overdue by ${Math.abs(days!)}d`
              : dueState === "today"
                ? "Due today"
                : `Due ${formatDateCompact(issue.dueDate)}`}
          </span>
        ) : null}

        {/* Only shown when the issue actually has sub-issues to measure. */}
        {issue.progress ? (
          <span className="prio-assigned__progress">
            <span className="prio-progress" aria-hidden>
              <span
                className="prio-progress__bar"
                style={{
                  width: `${percent(issue.progress.done, issue.progress.total)}%`,
                }}
              />
            </span>
            {issue.progress.done}/{issue.progress.total}
          </span>
        ) : null}
      </span>
    </Link>
  );
}

/* ------------------------------------------------------------ compact row */

/** Used by "Important issues" — denser than an assigned card. */
export function IssueRow({ issue }: { issue: DashboardIssue }) {
  return (
    <Link
      href={`/issues/${issue.key.toLowerCase()}`}
      className="prio-relatedrow"
    >
      <IssueTypeIcon type={issue.type} size={17} />
      <IssueKey issueKey={issue.key} />
      <span className="prio-relatedrow__title prio-truncate">{issue.title}</span>
      {issue.severity ? <SeverityChip severity={issue.severity} /> : null}
      <PriorityIndicator priority={issue.priority} showLabel={false} />
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
  );
}

/* ---------------------------------------------------------------- due bar */

/**
 * Overdue / today / this week (§10). Each is a link into the issue list with
 * the matching filter already applied, so the number is a way in, not a label.
 */
export function DueBar({
  overdue,
  today,
  thisWeek,
  userId,
}: {
  overdue: number;
  today: number;
  thisWeek: number;
  userId: string;
}) {
  if (overdue + today + thisWeek === 0) return null;

  const base = `/issues?assignee=${userId}&resolution=open`;

  return (
    <div className="prio-duebar">
      {overdue > 0 ? (
        <Link href={`${base}&overdue=1`} className="prio-duebar__item" data-tone="danger">
          <IconWarning size={14} />
          <strong>{overdue}</strong>
          {overdue === 1 ? "overdue task" : "overdue tasks"}
        </Link>
      ) : null}

      {today > 0 ? (
        <Link href={`${base}&sort=due&dir=asc`} className="prio-duebar__item" data-tone="warning">
          <IconClock size={14} />
          <strong>{today}</strong>
          due today
        </Link>
      ) : null}

      {/* `dueWeek=1` is the filter the count was made with, so clicking the
          number opens exactly the issues it counted — this week's dated, open
          work, with nothing overdue and nothing undated alongside it. It used
          to sort by due date and filter by nothing, which showed every open
          issue assigned to the reader. */}
      {thisWeek > 0 ? (
        <Link
          href={`${base}&dueWeek=1&sort=due&dir=asc`}
          className="prio-duebar__item"
        >
          <IconCalendar size={14} />
          <strong>{thisWeek}</strong>
          due this week
        </Link>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------ distribution */

/** A labelled bar chart row set, used for status/priority/type breakdowns. */
export function Distribution({
  title,
  entries,
  total,
  hrefFor,
}: {
  title: string;
  entries: { key: string; label: React.ReactNode; value: number; tone?: string }[];
  total: number;
  hrefFor?: (key: string) => string;
}) {
  return (
    <Card style={{ height: "100%" }}>
      <CardBody>
        <h2 className="prio-issue__section-title">{title}</h2>

        {total === 0 ? (
          <p className="prio-text-muted">Nothing to show yet.</p>
        ) : (
          <ul className="prio-distribution">
            {entries.map((entry) => {
              const row = (
                <>
                  <span className="prio-distribution__label">{entry.label}</span>
                  <span className="prio-distribution__track" aria-hidden>
                    <span
                      className="prio-distribution__bar"
                      data-status={entry.tone}
                      style={{ width: barWidth(entry.value, total) }}
                    />
                  </span>
                  <span className="prio-distribution__value">{entry.value}</span>
                </>
              );

              return (
                <li key={entry.key} className="prio-distribution__row">
                  {hrefFor ? (
                    <Link href={hrefFor(entry.key)} className="prio-distribution__link">
                      {row}
                    </Link>
                  ) : (
                    row
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

/** Convenience wrappers so the page reads as intent, not plumbing. */
export function StatusDistribution({
  byStatus,
}: {
  byStatus: Record<string, number>;
}) {
  const total = Object.values(byStatus).reduce((s, n) => s + n, 0);
  return (
    <Distribution
      title="Issues by status"
      total={total}
      entries={ISSUE_STATUSES.map((status) => ({
        key: status,
        label: <StatusPill status={status} />,
        value: byStatus[status] ?? 0,
        tone: status,
      }))}
    />
  );
}

export function PriorityDistribution({
  byPriority,
}: {
  byPriority: Record<string, number>;
}) {
  const total = Object.values(byPriority).reduce((s, n) => s + n, 0);
  return (
    <Distribution
      title="Open issues by priority"
      total={total}
      entries={PRIORITIES.map((priority) => ({
        key: priority,
        label: <PriorityIndicator priority={priority} />,
        value: byPriority[priority] ?? 0,
      }))}
    />
  );
}

export function TypeDistribution({
  byType,
}: {
  byType: Record<string, number>;
}) {
  const total = Object.values(byType).reduce((s, n) => s + n, 0);
  return (
    <Distribution
      title="Issues by type"
      total={total}
      entries={(["TASK", "BUG", "STORY"] as const).map((type) => ({
        key: type,
        label: (
          <span className="prio-person">
            <IssueTypeIcon type={type} size={16} />
            {type === "TASK" ? "Task" : type === "BUG" ? "Bug" : "Story"}
          </span>
        ),
        value: byType[type] ?? 0,
      }))}
    />
  );
}

/* ------------------------------------------------------------- project row */

/**
 * One project on the dashboard, and the way into it.
 *
 * The row is a link now. The dashboard is where somebody picks the project
 * they are going to work in, and it was the one project list in Prio that a
 * click did nothing to -- the name, the key, the health and the progress were
 * all there, and following any of them meant going back to the sidebar or the
 * directory to find the same project again.
 *
 * It leads to that project's Welcome page rather than its Summary, which is
 * the whole point of the change: choosing a project from the global dashboard
 * passes through the step that says which project has been chosen and what the
 * reader is to it.
 */
export function ProjectRow({ project }: { project: DashboardProject }) {
  const complete = percent(project.done, project.total);

  return (
    <Link
      href={`/projects/${project.key.toLowerCase()}/welcome`}
      className="prio-projrow"
      data-health={project.health}
      aria-label={`${project.name} (${project.key}): ${complete}% complete, ${project.open} open`}
    >
      <span className="prio-projrow__top">
        <span className="prio-project-chip" aria-hidden>
          {project.key.slice(0, 2)}
        </span>
        <span className="prio-projrow__name">{project.name}</span>
        <span className="prio-key">{project.key}</span>
        <span className="prio-projrow__health" data-health={project.health}>
          {project.health === "healthy"
            ? "Healthy"
            : project.health === "attention"
              ? "Needs attention"
              : "At risk"}
        </span>
        {project.assignedToMe > 0 ? (
          <span className="prio-badge prio-badge--pill" data-tone="brand">
            Assigned to you
          </span>
        ) : null}
      </span>

      <span className="prio-progress" aria-hidden>
        <span
          className="prio-progress__bar"
          style={{ width: `${complete}%` }}
        />
      </span>

      <span className="prio-projrow__stats">
        <span>{complete}% complete</span>
        <span>{project.open} open</span>
        <span>{project.done} done</span>
        {project.openBugs > 0 ? (
          <span data-tone="danger">{project.openBugs} open bugs</span>
        ) : null}
        {project.overdue > 0 ? (
          <span data-tone="danger">{project.overdue} overdue</span>
        ) : null}
        {project.assignedToMe > 0 ? (
          <span data-tone="brand">{project.assignedToMe} assigned to me</span>
        ) : null}
      </span>
    </Link>
  );
}

/* ---------------------------------------------------------------- activity */

/** Recent activity from the real immutable trail (§20). */
export function ActivityList({ entries }: { entries: DashboardActivity[] }) {
  if (entries.length === 0) {
    return <p className="prio-text-muted">No activity recorded yet.</p>;
  }

  return (
    <ol className="prio-activity">
      {entries.map((entry) => (
        <li key={entry.id} className="prio-activity__item">
          <span className="prio-activity__rail" aria-hidden />
          <Avatar
            name={entry.actor.name}
            image={entry.actor.image}
            size="sm"
            className="prio-activity__avatar"
          />
          <div className="prio-activity__body">
            <span className="prio-activity__text">
              <strong>{entry.actor.name}</strong>{" "}
              {humanizeActivity(entry.action, entry.field)}{" "}
              <span className="prio-key">{entry.issue.key}</span>
              {entry.field === "status" && entry.oldValue && entry.newValue ? (
                <span className="prio-activity__change">
                  {STATUS_LABEL[entry.oldValue as never] ?? entry.oldValue}
                  {" → "}
                  {STATUS_LABEL[entry.newValue as never] ?? entry.newValue}
                </span>
              ) : null}
            </span>
            <time
              className="prio-activity__time"
              dateTime={entry.createdAt.toISOString()}
              /* Exact time on hover, relative time at a glance. */
              title={formatDateTime(entry.createdAt)}
            >
              {formatRelative(entry.createdAt)}
            </time>
          </div>
        </li>
      ))}
    </ol>
  );
}

/* -------------------------------------------------------------- role badge */

/**
 * What the signed-in person does here, derived by `workRoleOf` on the server.
 *
 * The account still has exactly two roles and this invents no third one: a
 * developer and a tester are both MEMBER, and telling them apart is the
 * Testing team, not a new value in the database. The badge says which, because
 * the two are offered visibly different things and being told why is better
 * than being left to work it out from an absent button.
 */
export function RoleBadge({ role }: { role: WorkRole }) {
  return (
    <span
      className="prio-rolebadge"
      data-role={role}
      title={WORK_ROLE_DESCRIPTION[role]}
    >
      {WORK_ROLE_LABEL[role]}
    </span>
  );
}

/**
 * Somebody else's account role — Admin or Member — as the People screen grants
 * it, and as the lists below show it.
 *
 * Deliberately not the work role. Whether a member tests or builds is their
 * team membership, which these lists do not load and which is not what an
 * administrator changes here; showing "Developer" beside a person whose access
 * is "Member" would name a thing this row cannot alter.
 */
export function AccountRoleBadge({ role }: { role: Role }) {
  return (
    <span className="prio-rolebadge" data-role={role} title={ROLE_DESCRIPTION[role]}>
      {ROLE_LABEL[role]}
    </span>
  );
}

/* ------------------------------------------------------------ section head */

export function SectionHead({
  title,
  count,
  href,
  linkLabel,
}: {
  title: string;
  count?: number;
  href?: string;
  linkLabel?: string;
}) {
  return (
    <div className="prio-dash__section-head">
      <h2 className="prio-dash__section-title">
        {title}
        {count !== undefined && count > 0 ? (
          <span className="prio-dash__count">{count}</span>
        ) : null}
      </h2>
      {href ? (
        <Link href={href} className="prio-dash__section-link">
          {linkLabel ?? "View all"} →
        </Link>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- kpi card */

/**
 * A headline figure. `href` makes the whole card a link into the filtered list
 * that produced the number, so every KPI is verifiable by clicking it.
 *
 * `trend` is only passed when there is a real previous period to compare
 * against; a first-month figure shows no arrow rather than a fake 0%.
 */
export function KpiCard({
  label,
  value,
  hint,
  icon,
  tone,
  href,
  trend,
}: {
  label: string;
  value: number;
  hint?: string;
  icon?: React.ReactNode;
  tone?: "default" | "brand" | "danger" | "warning" | "success";
  href?: string;
  trend?: { current: number; previous: number; label: string } | null;
}) {
  const delta = trend ? trend.current - trend.previous : 0;
  const dir = delta > 0 ? "up" : delta < 0 ? "down" : "flat";

  const inner = (
    <>
      <span className="prio-kpi__label">
        {icon}
        {label}
      </span>
      <span className="prio-kpi__value">{value}</span>
      <span className="prio-kpi__foot">
        {hint ? <span className="prio-kpi__hint">{hint}</span> : null}
        {trend && delta !== 0 ? (
          <span className="prio-kpi__trend" data-dir={dir}>
            {dir === "up" ? "▲" : "▼"} {Math.abs(delta)} {trend.label}
          </span>
        ) : null}
      </span>
    </>
  );

  if (href) {
    return (
      <Link href={href} className="prio-kpi" data-tone={tone ?? "default"}>
        {inner}
      </Link>
    );
  }

  return (
    <div className="prio-kpi" data-tone={tone ?? "default"}>
      {inner}
    </div>
  );
}

/* --------------------------------------------------------------- my work */

/** The person's own queue, broken down. Every tile links to the same list,
 *  filtered the way the tile describes. */
export function WorkGrid({
  work,
  userId,
}: {
  work: WorkSummary;
  userId: string;
}) {
  const mine = `/issues?assignee=${userId}`;

  const tiles: {
    label: string;
    value: number;
    href: string;
    tone?: "danger";
  }[] = [
    { label: "Assigned", value: work.assigned, href: `${mine}&resolution=open` },
    {
      label: "In progress",
      value: work.inProgress,
      href: `${mine}&status=IN_PROGRESS`,
    },
    { label: "Ready for QA", value: work.review, href: `${mine}&status=IN_REVIEW` },
    /* The other half of a tester's own queue. Ready for QA is what has been
       handed to them; this is what they have picked up and are checking now.
       Both are theirs, so My work names both rather than folding the second
       into the undifferentiated "Assigned". */
    { label: "In QA", value: work.inQa, href: `${mine}&status=IN_QA` },
    { label: "Completed", value: work.completed, href: `${mine}&status=DONE` },
    {
      label: "Overdue",
      value: work.overdue,
      href: `${mine}&resolution=open&overdue=1`,
      tone: work.overdue > 0 ? "danger" : undefined,
    },
    { label: "Reported", value: work.reported, href: `/issues?reporter=${userId}` },
  ];

  return (
    <div className="prio-workgrid">
      {tiles.map((tile) => (
        <Link
          key={tile.label}
          href={tile.href}
          className="prio-worktile"
          data-tone={tile.tone}
        >
          <span className="prio-worktile__value">{tile.value}</span>
          <span className="prio-worktile__label">{tile.label}</span>
        </Link>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------- workload */

/**
 * Admin only. Bars are relative to the busiest person, which answers "is the
 * work evenly spread?" rather than "how much work is there?".
 */
export function WorkloadList({
  people,
}: {
  people: { id: string; name: string; image: string | null; open: number }[];
}) {
  if (people.length === 0) {
    return <p className="prio-text-muted">No open work is assigned to anyone.</p>;
  }

  const busiest = Math.max(...people.map((p) => p.open), 1);

  return (
    <ul className="prio-workload">
      {people.map((person) => (
        <li key={person.id} className="prio-workload__row">
          <Avatar name={person.name} image={person.image} size="xs" />
          <span className="prio-workload__name">{person.name}</span>
          <span className="prio-workload__track" aria-hidden>
            <span
              className="prio-workload__bar"
              style={{ width: `${percent(person.open, busiest)}%` }}
            />
          </span>
          <span className="prio-workload__value">{person.open}</span>
        </li>
      ))}
    </ul>
  );
}

/* --------------------------------------------------------- team members */

/**
 * Who the viewer is working with, visible to every signed-in person by
 * default — Member and Admin alike see this, unlike `WorkloadList` above,
 * which is the deeper organization-wide breakdown and stays admin-only.
 *
 * Each card links to that person's open work, filtered exactly the way
 * clicking "Assignee: <name>" on the issue list already would — this is a
 * shortcut into data the viewer could already reach, not a new exposure.
 */
/**
 * The team roster.
 *
 * A row is not a link. It used to be one, pointing at the global issue list
 * filtered by that person — which reads as a roster entry but navigates away
 * from Home to a different page entirely. Opening a person now uses the member
 * detail dialog that already exists for exactly this, so the context stays put
 * and there is one way to look someone up rather than two.
 */
export function TeamMembers({
  members,
  isAdmin = false,
}: {
  /**
   * Whether the viewer is an administrator, which decides whether the detail
   * control is offered at all.
   *
   * The team list itself is everybody's — who is on the projects you can see,
   * and how much each of them is holding. What sits behind the control is not:
   * `loadMemberDetail` calls `assertAdmin`, so for anyone else the dialog can
   * only open, fail and close again. Offering a button that cannot work is
   * worse than not offering it, and the refusal is still the server's.
   */
  isAdmin?: boolean;
  members: {
    id: string;
    name: string;
    image: string | null;
    role: Role;
    isActive: boolean;
    openInScope: number;
    isYou: boolean;
  }[];
}) {
  if (members.length === 0) {
    return (
      <p className="prio-text-muted">
        Nobody shares a project with you yet.
      </p>
    );
  }

  return (
    <ul className="prio-team">
      {members.map((member) => (
        <li key={member.id}>
          <div className="prio-team__member">
            <Avatar name={member.name} image={member.image} size="md" />
            <span className="prio-team__info">
              <span className="prio-team__name">
                {member.name}
                {member.isYou ? (
                  <span className="prio-team__you"> (You)</span>
                ) : null}
              </span>
              <span className="prio-team__meta">
                <AccountRoleBadge role={member.role} />
                {!member.isActive ? (
                  <span className="prio-team__inactive">Inactive</span>
                ) : null}
              </span>
            </span>
            <span
              className="prio-team__count"
              title="Open issues assigned to them, in your projects"
            >
              {member.openInScope}
            </span>
            {isAdmin ? (
              <MemberDetailButton
                memberId={member.id}
                memberName={member.name}
                canAssign
              />
            ) : null}
          </div>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------- new users */

/**
 * Admin-only, top-of-page: people who joined recently, newest first. Distinct
 * from `TeamMembers` above — that is everyone visible, scoped to the viewer's
 * own projects; this is org-wide and time-windowed, so a brand-new colleague
 * who has not yet been added to a project is still findable.
 */
export function NewUsers({
  users,
}: {
  users: {
    id: string;
    name: string;
    email: string;
    role: Role;
    isActive: boolean;
    createdAt: Date;
  }[];
}) {
  if (users.length === 0) return null;

  return (
    <ul className="prio-newusers">
      {users.map((user) => (
        <li key={user.id} className="prio-newusers__row">
          <Avatar name={user.name} size="md" />
          <span className="prio-newusers__info">
            <span className="prio-newusers__name">
              {user.name}
              <span className="prio-badge prio-badge--pill" data-tone="brand">
                New
              </span>
            </span>
            <span className="prio-newusers__meta">
              {user.email}
              <AccountRoleBadge role={user.role} />
              {!user.isActive ? (
                <span className="prio-team__inactive">Inactive</span>
              ) : null}
            </span>
          </span>
          <span className="prio-newusers__joined">
            {formatRelative(user.createdAt)}
          </span>
          {/* The new-users list is an administrator's section, so handing the
              newcomer something to do belongs in it. */}
          <MemberDetailButton
            memberId={user.id}
            memberName={user.name}
            canAssign
          />
        </li>
      ))}
    </ul>
  );
}
