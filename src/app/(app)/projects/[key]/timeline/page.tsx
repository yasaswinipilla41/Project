import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { IssueStatus, IssueType } from "@prisma/client";
import { Card, CardBody, EmptyState } from "@/components/ui/primitives";
import { IssueKey, IssueTypeIcon, StatusPill } from "@/components/ui/Indicators";
import { IconEmptyBox } from "@/components/ui/Icon";
import { projectScope } from "@/lib/authz";
import { CLOSED_STATUSES, STATUS_LABEL } from "@/lib/domain";
import { formatDate } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * When this project's work is scheduled for.
 *
 * The other four views answer different questions — List asks what there is,
 * the Flow Board asks what state it is in, the Calendar asks what falls on a
 * given day, Summary asks how much of it there is. None of them shows a span:
 * how long a piece of work has been open, when it is due relative to the work
 * beside it, and whether a sprint covers it.
 *
 * Only work that is actually scheduled appears. An issue with no due date has
 * no span to draw, and inventing one — "assume a week", "run it to today" —
 * would put a bar on the page that no row in the database supports. They are
 * counted at the foot of the page instead, and reachable in one click, so
 * nothing is hidden by being unplaceable.
 *
 * Every bar's geometry is a percentage of one window computed here on the
 * server from this project's own dates, so the rows cannot be scaled against
 * different windows. The window is padded to whole months, and always
 * contains today, so "now" is on the chart even for a project whose work is
 * all in the past or all ahead of it.
 */

const DAY = 24 * 60 * 60 * 1000;

interface Band {
  key: string;
  label: string;
  offset: number;
  width: number;
}

/** Whole months spanning `from`..`to`, as the axis's own columns. */
function monthBands(from: Date, to: Date, span: number): Band[] {
  const bands: Band[] = [];
  const cursor = new Date(from.getFullYear(), from.getMonth(), 1);

  while (cursor.getTime() < to.getTime()) {
    const next = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
    const start = Math.max(cursor.getTime(), from.getTime());
    const end = Math.min(next.getTime(), to.getTime());
    bands.push({
      key: `${cursor.getFullYear()}-${cursor.getMonth()}`,
      label: cursor.toLocaleDateString("en-GB", {
        month: "short",
        year: "numeric",
      }),
      offset: ((start - from.getTime()) / span) * 100,
      width: ((end - start) / span) * 100,
    });
    cursor.setMonth(cursor.getMonth() + 1);
  }

  return bands;
}

/** Where a span sits in the window, as left/width percentages. */
function place(start: number, end: number, from: number, span: number) {
  const left = ((Math.max(start, from) - from) / span) * 100;
  const right = ((Math.min(end, from + span) - from) / span) * 100;
  return {
    left: Math.max(0, Math.min(100, left)),
    /* A single-day span would otherwise be a zero-width bar — invisible, and
       indistinguishable from work that is not there at all. */
    width: Math.max(1.2, Math.min(100 - left, right - left)),
  };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ key: string }>;
}): Promise<Metadata> {
  const { key } = await params;
  const user = await requireUser();
  const project = await prisma.project.findFirst({
    where: { key: key.toUpperCase(), ...projectScope(user) },
    select: { name: true },
  });
  if (!project) notFound();

  return { title: `${project.name} timeline` };
}

export default async function ProjectTimelinePage({
  params,
}: {
  params: Promise<{ key: string }>;
}) {
  const { key } = await params;
  const user = await requireUser();

  const project = await prisma.project.findFirst({
    where: { key: key.toUpperCase(), ...projectScope(user) },
    select: { id: true, key: true, name: true },
  });
  if (!project) notFound();

  const base = `/projects/${project.key.toLowerCase()}`;

  const [scheduled, unscheduled, sprints] = await Promise.all([
    prisma.issue.findMany({
      where: { projectId: project.id, dueDate: { not: null } },
      orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
      /* A ceiling rather than every issue, so a project with thousands of
         dated issues does not render thousands of rows. What is left out is
         reported below the chart rather than silently dropped. */
      take: 120,
      select: {
        id: true,
        key: true,
        title: true,
        type: true,
        status: true,
        createdAt: true,
        dueDate: true,
        completedAt: true,
        assignee: { select: { name: true } },
        parent: { select: { key: true, title: true, type: true } },
      },
    }),
    prisma.issue.count({ where: { projectId: project.id, dueDate: null } }),
    prisma.sprint.findMany({
      where: { projectId: project.id },
      orderBy: { startDate: "asc" },
      select: {
        id: true,
        name: true,
        status: true,
        startDate: true,
        endDate: true,
      },
    }),
  ]);

  const scheduledTotal = await prisma.issue.count({
    where: { projectId: project.id, dueDate: { not: null } },
  });

  if (scheduled.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<IconEmptyBox />}
          title="Nothing is scheduled yet"
          body={
            unscheduled === 0
              ? "The timeline draws work that has a due date. Give an issue one and it appears here."
              : `${unscheduled} ${
                  unscheduled === 1 ? "issue has" : "issues have"
                } no due date, so there is no span to draw. Set one and it appears here.`
          }
          actions={
            <Link href={`${base}/list`} className="prio-btn prio-btn--secondary">
              Open the list
            </Link>
          }
        />
      </Card>
    );
  }

  /* The window: every span this page will draw, padded out to whole months
     and widened to include today whichever side of the work it falls on. */
  const now = new Date();
  const stamps = [
    now.getTime(),
    ...scheduled.flatMap((issue) => [
      issue.createdAt.getTime(),
      issue.dueDate!.getTime(),
    ]),
    ...sprints.flatMap((sprint) => [
      sprint.startDate.getTime(),
      sprint.endDate.getTime(),
    ]),
  ];
  const rawFrom = new Date(Math.min(...stamps));
  const rawTo = new Date(Math.max(...stamps));
  const from = new Date(rawFrom.getFullYear(), rawFrom.getMonth(), 1);
  const to = new Date(rawTo.getFullYear(), rawTo.getMonth() + 1, 1);
  const span = Math.max(to.getTime() - from.getTime(), DAY);
  const months = monthBands(from, to, span);
  const today = place(now.getTime(), now.getTime(), from.getTime(), span);

  /*
   * Rows grouped under the epic they belong to.
   *
   * `parentId` is Prio's one level of hierarchy, so an issue's epic is its
   * parent when that parent is one. Everything else is grouped together
   * afterwards rather than being hidden, because unparented work is still
   * scheduled work.
   */
  const groups = new Map<
    string,
    {
      label: string;
      issueKey: string | null;
      rows: typeof scheduled;
    }
  >();

  for (const issue of scheduled) {
    const epic = issue.parent?.type === "EPIC" ? issue.parent : null;
    const id = epic ? epic.key : "￿";
    const group = groups.get(id);
    if (group) group.rows.push(issue);
    else {
      groups.set(id, {
        label: epic ? epic.title : "Not in an epic",
        issueKey: epic ? epic.key : null,
        rows: [issue],
      });
    }
  }

  /* Epics first, in key order, with the unparented group last — its id is the
     highest code point there is, so one sort puts it there. */
  const ordered = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));

  return (
    <>
      <Card className="prio-issue__section">
        <CardBody>
          <div className="prio-timeline__head">
            <h2 className="prio-issue__section-title">
              Scheduled work
              <span className="prio-timeline__count">
                {scheduled.length}
                {scheduledTotal > scheduled.length
                  ? ` of ${scheduledTotal}`
                  : ""}
              </span>
            </h2>
            <p className="prio-timeline__range">
              {formatDate(from)} — {formatDate(new Date(to.getTime() - DAY))}
            </p>
          </div>

          {/* The chart scrolls inside itself rather than widening the page:
              a long project must never be what makes the document scroll
              sideways. */}
          <div className="prio-timeline__scroll">
            <div className="prio-timeline">
              <div className="prio-timeline__axis" aria-hidden>
                <span className="prio-timeline__axislabel" />
                <div className="prio-timeline__track">
                  {months.map((month) => (
                    <span
                      key={month.key}
                      className="prio-timeline__month"
                      style={{
                        left: `${month.offset}%`,
                        width: `${month.width}%`,
                      }}
                    >
                      {month.label}
                    </span>
                  ))}
                  <span
                    className="prio-timeline__today"
                    style={{ left: `${today.left}%` }}
                  />
                </div>
              </div>

              {sprints.length > 0 ? (
                <section className="prio-timeline__group">
                  <h3 className="prio-timeline__grouptitle">Sprints</h3>
                  {sprints.map((sprint) => {
                    const bar = place(
                      sprint.startDate.getTime(),
                      sprint.endDate.getTime(),
                      from.getTime(),
                      span,
                    );
                    return (
                      <div key={sprint.id} className="prio-timeline__row">
                        <span className="prio-timeline__label prio-truncate">
                          {sprint.name}
                        </span>
                        <div className="prio-timeline__track">
                          <span
                            className="prio-timeline__bar prio-timeline__bar--sprint"
                            data-sprint={sprint.status}
                            style={{
                              left: `${bar.left}%`,
                              width: `${bar.width}%`,
                            }}
                          >
                            <span className="prio-visually-hidden">
                              {sprint.name}: {formatDate(sprint.startDate)} to{" "}
                              {formatDate(sprint.endDate)}
                            </span>
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </section>
              ) : null}

              {ordered.map(([id, group]) => (
                <section key={id} className="prio-timeline__group">
                  <h3 className="prio-timeline__grouptitle">
                    {group.issueKey ? (
                      <Link href={`/issues/${group.issueKey.toLowerCase()}`}>
                        {group.label}
                      </Link>
                    ) : (
                      group.label
                    )}
                    <span className="prio-timeline__count">
                      {group.rows.length}
                    </span>
                  </h3>

                  {group.rows.map((issue) => (
                    <TimelineRow
                      key={issue.id}
                      issue={issue}
                      from={from.getTime()}
                      span={span}
                      now={now.getTime()}
                    />
                  ))}
                </section>
              ))}
            </div>
          </div>

          {/* The legend carries the same status vocabulary the bars are
              coloured by, so colour is never the only thing saying what a bar
              is. */}
          <ul className="prio-timeline__legend">
            {(["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"] as IssueStatus[]).map(
              (status) => (
                <li key={status} className="prio-timeline__legenditem">
                  <span
                    className="prio-timeline__swatch"
                    data-status={status}
                    aria-hidden
                  />
                  {STATUS_LABEL[status]}
                </li>
              ),
            )}
            <li className="prio-timeline__legenditem">
              <span className="prio-timeline__swatch" data-overdue aria-hidden />
              Overdue
            </li>
          </ul>
        </CardBody>
      </Card>

      {unscheduled > 0 ? (
        <Card className="prio-issue__section">
          <CardBody>
            <p className="prio-text-muted" style={{ margin: 0 }}>
              {unscheduled} {unscheduled === 1 ? "issue has" : "issues have"} no
              due date and so cannot be placed on a timeline.{" "}
              <Link href={`${base}/list`}>Open the list</Link> to give them one.
            </p>
          </CardBody>
        </Card>
      ) : null}
    </>
  );
}

function TimelineRow({
  issue,
  from,
  span,
  now,
}: {
  issue: {
    key: string;
    title: string;
    type: IssueType;
    status: IssueStatus;
    createdAt: Date;
    dueDate: Date | null;
    completedAt: Date | null;
    assignee: { name: string } | null;
  };
  from: number;
  span: number;
  /* The clock the whole page was drawn against, passed in rather than read
     here: one reading for every row means the "today" line and every overdue
     mark agree about when now is, and the render stays a pure function of its
     arguments. */
  now: number;
}) {
  const due = issue.dueDate!;
  /* Finished work ends when it was finished, not when it was due — a bar that
     ran to a due date already met would say the work was still running. */
  const end = issue.completedAt ?? due;
  const bar = place(issue.createdAt.getTime(), end.getTime(), from, span);

  const closed = (CLOSED_STATUSES as readonly string[]).includes(issue.status);
  const overdue = !closed && due.getTime() < now;

  return (
    <div className="prio-timeline__row">
      <Link
        href={`/issues/${issue.key.toLowerCase()}`}
        className="prio-timeline__label"
      >
        <IssueTypeIcon type={issue.type} size={14} />
        <IssueKey issueKey={issue.key} />
        <span className="prio-truncate">{issue.title}</span>
      </Link>

      <div className="prio-timeline__track">
        <Link
          href={`/issues/${issue.key.toLowerCase()}`}
          className="prio-timeline__bar"
          data-status={issue.status}
          data-overdue={overdue || undefined}
          style={{ left: `${bar.left}%`, width: `${bar.width}%` }}
          /* The bar is a graphic, so everything it shows by position and
             colour is said here in words as well. */
          aria-label={`${issue.key} ${issue.title}: ${
            STATUS_LABEL[issue.status]
          }, opened ${formatDate(issue.createdAt)}, due ${formatDate(due)}${
            issue.completedAt
              ? `, completed ${formatDate(issue.completedAt)}`
              : overdue
                ? ", overdue"
                : ""
          }${issue.assignee ? `, assigned to ${issue.assignee.name}` : ""}`}
        >
          <span className="prio-timeline__barlabel">
            {formatDate(due)}
          </span>
        </Link>
      </div>

      <span className="prio-timeline__status">
        <StatusPill status={issue.status} />
      </span>
    </div>
  );
}
