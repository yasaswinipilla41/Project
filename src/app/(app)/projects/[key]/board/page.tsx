import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BoardHeaderActions } from "@/components/projects/BoardHeaderActions";
import { FlowBoard } from "@/components/projects/FlowBoard";
import { ProjectNav } from "@/components/projects/ProjectNav";
import { canManageProject, projectScope } from "@/lib/authz";
import { BOARD_STATUSES } from "@/lib/board";
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
      where: { projectId: project.id, status: { in: BOARD_STATUSES } },
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

  const columns = BOARD_STATUSES.map((status) => ({
    status,
    issues: issues.filter((issue) => issue.status === status),
  }));

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
          <h1 className="prio-page-header__title">Flow Board</h1>
          <p className="prio-page-header__subtitle">
            Manage issues and track progress for the {project.name} project.
          </p>
        </div>

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

      <ProjectNav
        projectKey={project.key}
        projectId={project.id}
        active="board"
      />

      <FlowBoard
        project={{ id: project.id, key: project.key, name: project.name }}
        allProjects={allProjects}
        members={project.members.map((m) => m.user)}
        labels={project.labels}
        columns={columns}
        currentUserId={user.id}
        isAdmin={user.role === "ADMIN"}
      />
    </>
  );
}
