import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardBody, EmptyState } from "@/components/ui/primitives";
import { IconEmptyBox } from "@/components/ui/Icon";
import {
  ProjectCalendarGrid,
  type CalendarIssue,
} from "@/components/projects/ProjectCalendarGrid";
import { projectScope, workRoleOf } from "@/lib/authz";
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
 *
 * **A day is a date, not an instant.** Everything below works in UTC —
 * the month's bounds, the day an issue is bucketed into, the leading blank
 * cells and which cell is today. A due date arrives from an
 * `<input type="date">` as `YYYY-MM-DD`, which `new Date()` reads as UTC
 * midnight, so reading it back with `getUTCDate()` returns the day that was
 * typed on any server, in any timezone. Mixing the two — storing UTC midnight
 * and bucketing by the server's local date — is what puts an issue on the day
 * before or after, and it is the one bug this view cannot afford.
 */

async function loadProject(rawKey: string, user: CurrentUser) {
  return prisma.project.findFirst({
    where: { key: rawKey.toUpperCase(), ...projectScope(user) },
    select: {
      id: true,
      key: true,
      name: true,
      /* Who the composer may assign work to. The same rule `createIssue`
         enforces server-side — an assignee must be a member of the project —
         so the control cannot offer somebody the write would refuse. */
      members: {
        orderBy: { user: { name: "asc" } },
        select: { user: { select: { id: true, name: true } } },
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
  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 1));

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

  /* Each issue's day, resolved once here in UTC and handed to the grid
     already decided — so the client never re-derives a date and the two can
     never disagree about which cell an issue belongs in. */
  const calendarIssues: CalendarIssue[] = issues.flatMap((issue) =>
    issue.dueDate
      ? [
          {
            id: issue.id,
            key: issue.key,
            title: issue.title,
            type: issue.type,
            status: issue.status,
            day: issue.dueDate.getUTCDate(),
          },
        ]
      : [],
  );

  const monthLabel = new Intl.DateTimeFormat("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(start);

  /* Monday-first, matching the rest of Prio's date formatting. `getUTCDay()`
     is Sunday-first, so Sunday becomes the 7th column rather than the 1st. */
  const leading = (start.getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const cells: (number | null)[] = [
    ...Array.from({ length: leading }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const today = new Date();
  const isCurrentMonth =
    today.getUTCFullYear() === year && today.getUTCMonth() === month;
  const todayDay = isCurrentMonth ? today.getUTCDate() : null;

  const base = `/projects/${project.key.toLowerCase()}/calendar`;
  const prev = new Date(year, month - 1, 1);
  const next = new Date(year, month + 1, 1);

  return (
    <>

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

          <ProjectCalendarGrid
        canCreate={(await workRoleOf(user)) !== "DEVELOPER"}
            projectId={project.id}
            monthLabel={monthLabel}
            year={year}
            month={month}
            cells={cells}
            issues={calendarIssues}
            members={project.members.map(({ user: member }) => member)}
            todayDay={todayDay}
          />
        </CardBody>
      </Card>
    </>
  );
}
