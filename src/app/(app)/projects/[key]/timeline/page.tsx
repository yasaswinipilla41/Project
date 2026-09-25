import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { IssueStatus, IssueType } from "@prisma/client";
import { Card, CardBody, EmptyState } from "@/components/ui/primitives";
import { IssueKey, IssueTypeIcon, StatusPill } from "@/components/ui/Indicators";
import { IconEmptyBox } from "@/components/ui/Icon";
import { projectScope } from "@/lib/authz";
import { CLOSED_STATUSES, STATUS_LABEL } from "@/lib/domain";
import { formatDate, formatDateRange, formatDayMonthYear } from "@/lib/format";
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

/*
 * How much of the track one date needs beside a bar.
 *
 * A percentage, because that is what the bar's position is in — but derived
 * from the three lengths it actually depends on rather than written down as
 * a number, so that changing any of them moves it and none of them is a
 * secret. Each is a constant of the layout, not a measurement: reading the
 * real width would mean measuring in the browser after paint, which is a
 * layout read, a hydration mismatch and a resize listener for the sake of one
 * spacing decision that only matters at the two extreme edges.
 *
 * If the date's font size or the timeline's minimum width changes, this
 * follows. The edge cases it governs are pinned by tests rather than by
 * trusting the arithmetic — see `sprint-timeline-total-move.spec.ts`.
 */

/** `.prio-timeline` never draws narrower than this; below it, the page scrolls. */
const MIN_TIMELINE_PX = 640;
/** The name column beside the track at that width — the 767.98px rule. */
const LABEL_COLUMN_PX = 150;
/** "01 Sep 2026" at `--prio-text-2xs`, tabular figures. */
const DATE_LABEL_PX = 70;

const EDGE_ROOM = (DATE_LABEL_PX / (MIN_TIMELINE_PX - LABEL_COLUMN_PX)) * 100;

/**
 * A date beside a bar, on the track rather than on the bar.
 *
 * Every date this page shows — a sprint's two ends and an issue's due date —
 * is drawn here, outside the coloured bar it belongs to: a bar is a filled
 * shape a few characters wide at the sizes this timeline uses, so a date
 * written inside it is white-on-colour and clipped, and on a short bar there
 * is no room for it at all. Outside it reads against the page, at the edge of
 * the bar it describes, whatever the bar's width.
 *
 * `edge` says which end of the bar the date belongs to, and `inside` is the
 * last resort for a bar with no track left on that side — it begins at the
 * very start of the timeline, or runs to its very end. Then the date sits
 * over the bar and takes a small background so it stays legible over either
 * surface.
 */
function TimelineDate({
  edge,
  at,
  inside,
  text,
  kind,
  href,
  label,
}: {
  edge: "start" | "end";
  /** Where this end of the bar sits, as a percentage of the track. */
  at: number;
  inside: boolean;
  text: string;
  /** Which sort of date it is, for the tests and for anything that wants to
      style the two differently later. The placement is identical. */
  kind: "sprint" | "due";
  /**
   * Where clicking the date goes, when it goes anywhere.
   *
   * An issue's due date leads to that issue — the same place its bar leads,
   * because the date is a fact about that one issue and a reader who has just
   * read it is pointing at the thing they want to open. A sprint's dates have
   * no `href`: they describe a bar that is not a link either.
   */
  href?: string;
  /** What the link is called, for a reader who cannot see which row it is
      in. */
  label?: string;
}) {
  /* Anchored by the edge it belongs to, so the date tracks the bar rather
     than being positioned from the opposite side and drifting with width. */
  const anchorLeft = edge === "start" ? inside : !inside;

  const className = `prio-timeline__date prio-timeline__${
    kind === "sprint" ? "sprintdate" : "duedate"
  }${href ? " prio-timeline__date--link" : ""}`;
  const placement = anchorLeft ? { left: `${at}%` } : { right: `${100 - at}%` };

  /* A link says what it opens; a plain date is decoration beside a bar whose
     own label already reads the date out, so it stays hidden from a reader
     rather than repeating it. */
  if (href) {
    return (
      <Link
        href={href}
        className={className}
        data-edge={edge}
        data-inside={inside || undefined}
        style={placement}
        aria-label={label}
      >
        {text}
      </Link>
    );
  }

  return (
    <span
      className={className}
      data-edge={edge}
      data-inside={inside || undefined}
      style={placement}
      aria-hidden
    >
      {text}
    </span>
  );
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

  /*
   * Nothing to draw at all — no dated work *and* no sprints.
   *
   * A sprint is scheduled by its own start and end dates, which owe nothing
   * to whether anybody has given an issue a due date. This page used to stand
   * down whenever no issue was dated, which took the sprint bars with it: a
   * project running a fortnight's sprint was told "nothing is scheduled yet"
   * while a sprint was in progress. The bars are drawn whenever there are
   * sprints, and the missing issue rows are explained where they would have
   * been rather than by replacing the whole page.
   */
  if (scheduled.length === 0 && sprints.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<IconEmptyBox />}
          title="Nothing is scheduled yet"
          body={
            unscheduled === 0
              ? "The timeline draws work that has a due date, and sprints by their own dates. Give an issue a due date — or plan a sprint — and it appears here."
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
                        {/*
                         * The name here, the period on the bar beside it.
                         *
                         * Every surface that *lists* sprints prints the
                         * bracketed range next to the name; this one does
                         * not, and deliberately. The label column is 220px,
                         * and "(01 Sep 2026 - 07 Sep 2026)" is most of that
                         * on its own — printing it here would truncate away
                         * the one thing that tells two rows apart, to say
                         * something the bar's position and width already
                         * say. It is on the title and in the row's
                         * accessible text instead, in the same format.
                         */}
                        <span
                          className="prio-timeline__label prio-truncate"
                          title={`${sprint.name} (${formatDateRange(sprint.startDate, sprint.endDate)})`}
                        >
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
                            /* The dates are beside the bar, not on it; the
                               tooltip says them too, whatever the bar's
                               width, as the hidden text below does for a
                               screen reader. */
                            title={`${sprint.name}: ${formatDate(
                              sprint.startDate,
                            )} to ${formatDate(sprint.endDate)}`}
                          >
                            <span className="prio-visually-hidden">
                              {sprint.name} (
                              {formatDateRange(
                                sprint.startDate,
                                sprint.endDate,
                              )}
                              )
                            </span>
                          </span>

                          {/*
                           * When the sprint begins and ends, in words, at the
                           * two ends of its bar.
                           *
                           * Beside the bar rather than inside it, because
                           * inside there is no room: a fortnight's sprint on
                           * a timeline spanning a few months is about 100px
                           * wide at a desktop width and half that on a
                           * phone, against roughly 70px for one date. Put
                           * inside, both dates would be clipped at every
                           * screen size — which is the behaviour the issue
                           * bars' own label already documents for short
                           * bars, and is not good enough for a date somebody
                           * is meant to read.
                           *
                           * Siblings of the bar, so the bar's `overflow:
                           * hidden` cannot clip them, and `aria-hidden`
                           * because the bar above already says the whole
                           * range in words.
                           */}
                          <TimelineDate
                            kind="sprint"
                            edge="start"
                            at={bar.left}
                            inside={bar.left < EDGE_ROOM}
                            text={formatDayMonthYear(sprint.startDate)}
                          />
                          <TimelineDate
                            kind="sprint"
                            edge="end"
                            at={bar.left + bar.width}
                            inside={bar.left + bar.width > 100 - EDGE_ROOM}
                            text={formatDayMonthYear(sprint.endDate)}
                          />
                        </div>
                      </div>
                    );
                  })}
                </section>
              ) : null}

              {/*
               * Why there are no issue rows, said where they would be.
               *
               * Only ever reached with sprints on screen above it — with
               * neither, the page stood down entirely further up. So this is
               * not "nothing is scheduled": it is the sprints being
               * scheduled and the work in them not being, which is a
               * different thing and a fixable one.
               */}
              {scheduled.length === 0 ? (
                <p className="prio-timeline__empty">
                  No work item has a due date yet, so the sprints above have no
                  issue rows beneath them.{" "}
                  <Link href={`${base}/list`}>Open the list</Link> to give one a
                  due date.
                </p>
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
                      /* Under "Not in an epic" the date opens its issue.
                         There is no epic heading above these rows to click
                         through, and `issueKey` being null is what says so —
                         the same test that named the group. */
                      linkDate={group.issueKey === null}
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
            {(
              ["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"] as IssueStatus[]
            ).map((status) => (
              <li key={status} className="prio-timeline__legenditem">
                <span
                  className="prio-timeline__swatch"
                  data-status={status}
                  aria-hidden
                />
                {STATUS_LABEL[status]}
              </li>
            ))}
            <li className="prio-timeline__legenditem">
              <span
                className="prio-timeline__swatch"
                data-overdue
                aria-hidden
              />
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
  linkDate = false,
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
  /**
   * Whether the due date opens the issue as well as the bar does.
   *
   * Asked of the caller rather than decided here, because it is the grouping
   * that wanted it: the rows under "Not in an epic" are where a reader meets
   * a date with no epic heading above it to click through instead. Rows under
   * an epic are the same component and one argument away from the same
   * behaviour.
   */
  linkDate?: boolean;
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
        />

        {/*
         * When the work is due, beside its bar.
         *
         * The same date as before, from the same `dueDate` — only its
         * position has changed. It used to be written inside the bar, which
         * put a date in white on a status colour and clipped it on any bar
         * shorter than the date: a "Ready for QA" bar and an overdue red one
         * both swallowed it. Out here it reads against the page at the edge
         * of the bar, and cannot be clipped by the bar's own `overflow`.
         *
         * After the bar's end where the track allows it, before its start
         * where it does not — the same flip the sprint dates make — and only
         * over the bar itself when the bar runs the whole width of the
         * window and there is nowhere outside it to stand.
         */}
        {(() => {
          const ends = bar.left + bar.width;
          const roomAfter = ends <= 100 - EDGE_ROOM;
          const roomBefore = bar.left >= EDGE_ROOM;
          return (
            <TimelineDate
              kind="due"
              edge={roomAfter || !roomBefore ? "end" : "start"}
              at={roomAfter || !roomBefore ? ends : bar.left}
              inside={!roomAfter && !roomBefore}
              text={formatDate(due)}
              /* The date opens the issue it is the due date of — the same
                 place the bar goes, by the same key and the same route. */
              href={linkDate ? `/issues/${issue.key.toLowerCase()}` : undefined}
              label={
                linkDate
                  ? `${issue.key} ${issue.title}: due ${formatDate(due)}`
                  : undefined
              }
            />
          );
        })()}
      </div>

      <span className="prio-timeline__status">
        <StatusPill status={issue.status} />
      </span>
    </div>
  );
}
