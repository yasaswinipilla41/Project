import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { ProjectSettings } from "@/components/projects/ProjectSettings";
import { IconSettings } from "@/components/ui/Icon";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session";

export const metadata: Metadata = { title: "Project settings" };
export const dynamic = "force-dynamic";

/**
 * Project settings (§36). Admin-only: `requireAdmin` runs before anything is
 * read, and each action re-checks on the server.
 */
export default async function ProjectSettingsPage({
  params,
}: {
  params: Promise<{ key: string }>;
}) {
  await requireAdmin();
  const { key } = await params;

  const project = await prisma.project.findUnique({
    where: { key: key.toUpperCase() },
    select: {
      id: true,
      key: true,
      name: true,
      description: true,
      isDefaultProject: true,
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
      labels: {
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          color: true,
          _count: { select: { issues: true } },
        },
      },
    },
  });

  if (!project) notFound();

  const memberIds = project.members.map((m) => m.user.id);

  const candidates = await prisma.user.findMany({
    where: { isActive: true, id: { notIn: memberIds } },
    select: { id: true, name: true, email: true, image: true, jobTitle: true },
    orderBy: { name: "asc" },
  });

  return (
    <>
      <div className="prio-page-header">
        <div className="prio-page-header__text">
          <nav aria-label="Breadcrumb" className="prio-issue__crumbs">
            <Link href="/projects">Projects</Link>
            <span aria-hidden>/</span>
            <Link href={`/projects/${project.key.toLowerCase()}`}>
              {project.name}
            </Link>
            <span aria-hidden>/</span>
            <span>Settings</span>
          </nav>
          <h1 className="prio-page-header__title">
            <IconSettings />
            Project settings
          </h1>
          <p className="prio-page-header__subtitle">
            Details, membership and labels for {project.name}.
          </p>
        </div>
      </div>

      <ProjectSettings
        project={{
          id: project.id,
          key: project.key,
          name: project.name,
          description: project.description,
          isDefaultProject: project.isDefaultProject,
        }}
        members={project.members.map((m) => m.user)}
        candidates={candidates}
        labels={project.labels.map((l) => ({
          id: l.id,
          name: l.name,
          color: l.color,
          issueCount: l._count.issues,
        }))}
      />
    </>
  );
}
