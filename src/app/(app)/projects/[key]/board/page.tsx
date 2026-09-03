import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BoardHeaderActions } from "@/components/projects/BoardHeaderActions";
import { IconBoard } from "@/components/ui/Icon";
import { BackLink } from "@/components/shell/BackLink";
import { FlowBoard } from "@/components/projects/FlowBoard";
import { InsightsPanel } from "@/components/reports/InsightsPanel";
import { canManageProject, projectScope } from "@/lib/authz";
import {
  BOARD_STATUSES,
  BOARD_VISIBLE_STATUSES,
  boardColumnFor,
} from "@/lib/board";
import { prisma } from "@/lib/prisma";
import { recordProjectVisit } from "@/lib/recents";
import { requireUser, type CurrentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * The project's Flow Board — a Kanban view of one project's issues, styled
 * and laid out to match the approved Flow Board design (breadcrumb, toolbar,
 * five status columns). Dragging a card between columns changes its status
 * through the same `updateIssue` action the issue detail page's own status
 * field uses; nothing here writes to the database on its own.
 *
 * The columns are `BOARD_STATUSES`, Backlog included: the query below asks the
 * database for those statuses, so which issues reach the board is decided
 * server-side. Nothing is filtered back out in the browser, which matters for
 * unassigned work -- it holds Backlog far more often than anything else, and a
 * client-side exclusion would have left it loaded but unshown.
 */

async function loadProject(rawKey: string, user: CurrentUser) {
  return prisma.project.findFirst({
    where: { key: rawKey.toUpperCase(), ...projectScope(user) },
    select: {
      id: true,
      key: true,
      name: true,
      description: true,
      createdById: true,
      labels: { select: { id: true, name: true, color: true } },
      members: {
        orderBy: { createdAt: "asc" },
        select: {
          user: { select: { id: true, name: true, image: true } },
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
  if (!project) notFound();
  return { title: `${project.name} · Flow Board` };
}

export default async function ProjectBoardPage({
  params,
}: {
  params: Promise<{ key: string }>;
}) {
  const { key } = await params;
  const user = await requireUser();

  const project = await loadProject(key, user);
  if (!project) notFound();

  recordProjectVisit(user.id, project.id);

  const [issues, allProjects, issueCount, favorite] = await Promise.all([
    prisma.issue.findMany({
      where: { projectId: project.id, status: { in: BOARD_VISIBLE_STATUSES } },
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
    prisma.issue.count({ where: { projectId: project.id } }),
    prisma.projectFavorite.findUnique({
      where: { projectId_userId: { projectId: project.id, userId: user.id } },
      select: { projectId: true },
    }),
  ]);

  /* Grouped by the column each issue belongs in rather than by its status,
     so Reopened lands in New and Rejected in Done without either becoming a
     column of its own. */
  const columns = BOARD_STATUSES.map((status) => ({
    status,
    issues: issues.filter((issue) => boardColumnFor(issue.status) === status),
  }));

  return (
    <>
      {/*
       * The page's own header, in the shape every other main navigation page
       * uses: `.prio-page-header` with the section's name as its `h1` and the
       * same icon the sidebar entry carries.
       *
       * The board reached this state by losing the project shell's header --
       * which was right, that header was the project's summary with its
       * Settings and actions on it, and did not belong above a board. But
       * nothing replaced it, so Flow Board became the one navigation
       * destination in Prio that never says what it is. This says it, the way
       * Issues, Notifications and Reports say it.
       *
       * There is only one Flow Board page: the sidebar entry and the project's
       * own tab both resolve to this route, so this single header serves both
       * and cannot be duplicated.
       */}
      <div className="prio-page-header">
        <div className="prio-page-header__text">
          {/*
           * The way back to the project this board belongs to. The destination
           * comes from the project the page already loaded, so it always leads
           * back to the project the reader came from rather than to a fixed
           * one or to a global board.
           */}
          <BackLink
            href={`/projects/${project.key.toLowerCase()}`}
            label={`Back to ${project.name}`}
          />
          <h1 className="prio-page-header__title">
            <IconBoard />
            Flow Board
          </h1>
          <p className="prio-page-header__subtitle">
            Issues in {project.name}, by status.
          </p>
        </div>

        {/* The board's own controls -- favouriting this project, and its
            edit/archive/delete menu -- in the slot every other page puts its
            actions in. */}
        <div className="prio-page-header__actions">
          <BoardHeaderActions
            project={{
              id: project.id,
              key: project.key,
              name: project.name,
              description: project.description,
            }}
            issueCount={issueCount}
            initialFavorite={favorite !== null}
            canManage={canManageProject(user, project)}
            isAdmin={user.role === "ADMIN"}
          />
        </div>
      </div>

      <FlowBoard
        project={{ id: project.id, key: project.key, name: project.name }}
        allProjects={allProjects}
        members={project.members.map((m) => m.user)}
        labels={project.labels}
        columns={columns}
        currentUserId={user.id}
        isAdmin={user.role === "ADMIN"}
        /* Scoped to this project alone, so the figures describe the board
           being looked at rather than the whole organisation. Rendered here
           on the server and handed over, so opening Insights needs no
           navigation and no second request. */
        insights={<InsightsPanel projectIds={[project.id]} />}
      />
    </>
  );
}
