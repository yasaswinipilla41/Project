import type { Metadata } from "next";
import { IconBoard } from "@/components/ui/Icon";
import { FlowBoard } from "@/components/projects/FlowBoard";
import { InsightsPanel } from "@/components/reports/InsightsPanel";
import { projectScope, workRoleOf } from "@/lib/authz";
import {
  BOARD_STATUSES,
  BOARD_VISIBLE_STATUSES,
  boardColumnFor,
} from "@/lib/board";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "Flow Board" };
export const dynamic = "force-dynamic";

/**
 * The Flow Board reached from the sidebar: every project the viewer can see,
 * on one board.
 *
 * Prio has two Flow Board contexts, and they are deliberately two routes
 * rather than one route with a mode:
 *
 *   - **here** — no project chosen. "All Projects" is what the Project
 *     dropdown is set to, the columns hold work from everywhere, and there is
 *     no "Back to …" control, because there is no project to go back to. A
 *     back link on a board that belongs to no project could only ever point
 *     somewhere arbitrary.
 *   - **`/projects/[key]/board`** — one project's board, with "Back to
 *     <project>" above it, reached from that project's own tab strip or from
 *     this board's Project dropdown.
 *
 * Everything below the header is the same `FlowBoard` component in both, fed
 * the same shape. Nothing about the columns, the cards, the drag-and-drop or
 * the filters knows which context it is in — the difference is entirely in
 * what this page hands over and what it draws above it.
 */
export default async function AllProjectsBoardPage() {
  const user = await requireUser();

  const [issues, allProjects, members, labels] = await Promise.all([
    prisma.issue.findMany({
      where: {
        /* The same project scope every other list uses, plus the board's own
           rule that an archived project has no board. */
        project: { ...projectScope(user), isArchived: false },
        status: { in: BOARD_VISIBLE_STATUSES },
      },
      orderBy: { sortIndex: "asc" },
      select: {
        id: true,
        key: true,
        type: true,
        title: true,
        status: true,
        priority: true,
        sortIndex: true,
        reporterId: true,
        assignee: { select: { id: true, name: true, image: true } },
        labels: {
          select: { label: { select: { id: true, name: true, color: true } } },
        },
      },
    }),
    prisma.project.findMany({
      where: { ...projectScope(user), isArchived: false },
      select: { id: true, key: true, name: true },
      orderBy: { name: "asc" },
    }),
    /* Everyone who belongs to a project on this board, once. The Assignee
       filter needs the roster of the board it is filtering, and this board is
       every project the viewer can open. `role` feeds the "Admin" option a
       member sees in place of names. */
    prisma.user.findMany({
      where: {
        isActive: true,
        projectMemberships: {
          some: { project: { ...projectScope(user), isArchived: false } },
        },
      },
      orderBy: { name: "asc" },
      select: { id: true, name: true, image: true, role: true },
    }),
    prisma.label.findMany({
      where: { project: { ...projectScope(user), isArchived: false } },
      orderBy: { name: "asc" },
      select: { id: true, name: true, color: true },
    }),
  ]);

  /* Grouped by the column each issue belongs in rather than by its raw
     status, exactly as the single-project board does. */
  const columns = BOARD_STATUSES.map((status) => ({
    status,
    issues: issues.filter((issue) => boardColumnFor(issue.status) === status),
  }));

  /* Labels are project-scoped, so an all-projects board can hold two labels
     with the same name from two projects. They are folded by name for the
     filter menu — picking "QA" should mean QA wherever it was defined —
     while every id behind that name stays selectable. */
  const labelsByName = new Map<string, { id: string; name: string; color: string }>();
  for (const label of labels) {
    if (!labelsByName.has(label.name.toLowerCase())) {
      labelsByName.set(label.name.toLowerCase(), label);
    }
  }

  return (
    <>
      <div className="prio-page-header">
        <div className="prio-page-header__text">
          {/* No "Back to …" here: this board belongs to no single project, so
              there is nothing for it to point at. The project board keeps its
              own back link, which is the whole distinction between the two. */}
          <h1 className="prio-page-header__title">
            <IconBoard />
            Flow Board
          </h1>
          <p className="prio-page-header__subtitle">
            Issues across all projects, by status.
          </p>
        </div>
      </div>

      <FlowBoard
        project={null}
        allProjects={allProjects}
        members={members.map((m) => ({
          id: m.id,
          name: m.name,
          image: m.image,
          isAdmin: m.role === "ADMIN",
        }))}
        labels={[...labelsByName.values()]}
        columns={columns}
        currentUserId={user.id}
        isAdmin={user.role === "ADMIN"}
        workRole={await workRoleOf(user)}
        insights={<InsightsPanel projectIds={allProjects.map((p) => p.id)} />}
      />
    </>
  );
}
