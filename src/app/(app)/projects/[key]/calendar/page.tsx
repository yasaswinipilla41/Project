import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardBody, EmptyState } from "@/components/ui/primitives";
import { IconCalendar, IconEmptyBox } from "@/components/ui/Icon";
import { IssueKey, IssueTypeIcon, StatusPill } from "@/components/ui/Indicators";
import { ProjectNav } from "@/components/projects/ProjectNav";
import { projectScope } from "@/lib/authz";
import { isClosedStatus } from "@/lib/domain";
import { prisma } from "@/lib/prisma";
import { recordProjectVisit } from "@/lib/recents";
import { requireUser, type CurrentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * One project's work laid out by due date.
 *
 * The calendar answers a question the board and the list cannot: what lands
 * *when*. Only issues with a due date can appear — an issue with no deadline
 * has no place on a calendar, and inventing one (created date, say) would put
 * work on days nobody agreed to.
 *
 * Scoped to the project in the URL and to what the viewer may see, like every
 * other project view. Navigating months is a plain link, so a particular month
 * is a URL you can share.
 */

async function loadProject(rawKey: string, user: CurrentUser) {
  return prisma.project.findFirst({
    where: { key: rawKey.toUpperCase(), ...projectScope(user) },
    select: { id: true, key: true, name: true },
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
  if (!project) notFound();
  return { title: `${project.name} · Calendar` };
}

/** `2026-08` → that month; anything else → the current month. */
function resolveMonth(raw: string | undefined): { year: number; month: number } {
  const now = new Date();
  const match = /^(\d{4})-(\d{2})$/.exec(raw ?? "");
  if (!match) return { year: now.getFullYear(), month: now.getMonth() };

  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  if (month < 0 || month > 11) {
    return { year: now.getFullYear(), month: now.getMonth() };
  }
  return { year, month };
}

const monthParam = (year: number, month: number) =>
  `${year}-${String(month + 1).padStart(2, "0")}`;

export default async function ProjectCalendarPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<{ month?: string }>;
}) {
  const [{ key }, query] = await Promise.all([params, searchParams]);
  const user = await requireUser();

  const project = await loadProject(key, user);
  if (!project) notFound();

  recordProjectVisit(user.id, project.id);

  const { year, month } = resolveMonth(query.month);
  const start = new Date(year, month, 1);
  const end = new Date(year, month + 1, 1);

  const issues = await prisma.issue.findMany({
    where: {
      projectId: project.id,
      dueDate: { gte: start, lt: end },
    },
    orderBy: [{ dueDate: "asc" }, { priority: "asc" }],
    select: {
      id: true,
      key: true,
      title: true,
      type: true,
      status: true,
      dueDate: true,
    },
  });

  /* Bucketed by day-of-month once, rather than filtering the list inside every
     one of the ~35 cells below. */
  const byDay = new Map<number, typeof issues>();
  for (const issue of issues) {
    if (!issue.dueDate) continue;
    const day = issue.dueDate.getDate();
    const bucket = byDay.get(day);
    if (bucket) bucket.push(issue);
    else byDay.set(day, [issue]);
  }

  const monthLabel = new Intl.DateTimeFormat("en-GB", {
    month: "long",
    year: "numeric",
  }).format(start);

  /* Monday-first, matching the rest of Prio's date formatting. `getDay()` is
     Sunday-first, so Sunday becomes the 7th column rather than the 1st. */
  const leading = (start.getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = [
    ...Array.from({ length: leading }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const today = new Date();
  const isCurrentMonth =
    today.getFullYear() === year && today.getMonth() === month;

  const base = `/projects/${project.key.toLowerCase()}/calendar`;
  const prev = new Date(year, month - 1, 1);
  const next = new Date(year, month + 1, 1);

  return (
    <>
      <div className="prio-page-header">
        <div className="prio-page-header__text">
          <div className="prio-breadcrumb">
            <Link href="/projects">Projects</Link>
            <span aria-hidden>/</span>
            <Link href={`/projects/${project.key.toLowerCase()}`}>
              {project.name}
            </Link>
          </div>
          <h1 className="prio-page-header__title">
            <IconCalendar />
            Calendar
          </h1>
          <p className="prio-page-header__subtitle">
            {issues.length === 0
              ? `Nothing due in ${monthLabel}.`
              : `${issues.length} item${issues.length === 1 ? "" : "s"} due in ${monthLabel}.`}
          </p>
        </div>
      </div>

      <ProjectNav
        projectKey={project.key}
        projectId={project.id}
        active="calendar"
      />

      <Card>
        <CardBody>
          <div className="prio-calendar__head">
            <Link
              href={`${base}?month=${monthParam(prev.getFullYear(), prev.getMonth())}`}
              className="prio-btn prio-btn--secondary prio-btn--sm"
            >
              Previous
            </Link>
            <h2 className="prio-calendar__month">{monthLabel}</h2>
            <Link
              href={`${base}?month=${monthParam(next.getFullYear(), next.getMonth())}`}
              className="prio-btn prio-btn--secondary prio-btn--sm"
            >
              Next
            </Link>
          </div>

          {issues.length === 0 ? (
            <EmptyState
              icon={<IconEmptyBox />}
              title={`Nothing due in ${monthLabel}`}
              body="Issues appear here on the day they are due. Give an issue a due date and it will show up."
            />
          ) : null}

          <div className="prio-calendar" role="grid" aria-label={monthLabel}>
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => (
              <div key={day} className="prio-calendar__weekday" role="columnheader">
                {day}
              </div>
            ))}

            {cells.map((day, index) => (
              <div
                key={day ?? `pad-${index}`}
                className="prio-calendar__cell"
                data-empty={day === null || undefined}
                data-today={
                  (isCurrentMonth && day === today.getDate()) || undefined
                }
                role="gridcell"
              >
                {day === null ? null : (
                  <>
                    <span className="prio-calendar__day">{day}</span>
                    {(byDay.get(day) ?? []).map((issue) => (
                      <Link
                        key={issue.id}
                        href={`/issues/${issue.key.toLowerCase()}`}
                        className="prio-calendar__issue"
                        data-done={isClosedStatus(issue.status) || undefined}
                        title={`${issue.key} — ${issue.title}`}
                      >
                        <IssueTypeIcon type={issue.type} size={12} />
                        <IssueKey issueKey={issue.key} />
                        <span className="prio-truncate">{issue.title}</span>
                        <StatusPill status={issue.status} />
                      </Link>
                    ))}
                  </>
                )}
              </div>
            ))}
          </div>
        </CardBody>
      </Card>
    </>
  );
}
