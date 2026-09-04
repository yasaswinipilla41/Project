import Link from "next/link";
import { notFound } from "next/navigation";
import { BackLink } from "@/components/shell/BackLink";
import { ProjectActions } from "@/components/projects/ProjectActions";
import { ProjectNav } from "@/components/projects/ProjectNav";
import { ProjectShellChrome } from "@/components/projects/ProjectShellChrome";
import { IconSettings } from "@/components/ui/Icon";
import { canManageProject, projectScope } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * The shell every view of a project sits inside.
 *
 * Summary, List, Flow Board, Calendar and Activity used to be separate pages
 * that each drew their own header and their own copy of the tab strip — and
 * two of the tabs did not lead to a project page at all, but to the global
 * issue list and activity feed with a filter applied. Following one of those
 * left the project behind: different header, no tabs, no way back except the
 * browser.
 *
 * Holding the header and the strip here makes them the shell rather than part
 * of the content. React does not re-render a layout across a soft navigation
 * between its own children, so moving between the five views replaces only
 * what sits below this — the header does not flash, the tab strip does not
 * move, and there is exactly one of it.
 *
 * The project is loaded here rather than in each child because the header
 * needs it; the children load their own data for the view they render.
 */
export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ key: string }>;
}) {
  const { key } = await params;
  const user = await requireUser();

  const project = await prisma.project.findFirst({
    where: { key: key.toUpperCase(), ...projectScope(user) },
    select: {
      id: true,
      key: true,
      name: true,
      description: true,
      createdById: true,
      _count: { select: { issues: true } },
    },
  });
  if (!project) notFound();

  return (
    <>
      <ProjectShellChrome projectKey={project.key}>
      <div className="prio-page-header">
        <div className="prio-page-header__text">
          <BackLink href="/projects" label="All projects" />
          <div className="prio-projecthead">
            <span className="prio-projectcard__badge" aria-hidden>
              {project.key.slice(0, 2)}
            </span>
            <div style={{ minWidth: 0 }}>
              <h1 className="prio-page-header__title">
                {project.name}
                <span className="prio-key">{project.key}</span>
              </h1>
              <p className="prio-page-header__subtitle">
                {project.description ?? "No description yet."}
              </p>
            </div>
          </div>
        </div>

        <div className="prio-page-header__actions">
          {user.role === "ADMIN" ? (
            <Link
              href={`/projects/${project.key.toLowerCase()}/settings`}
              className="prio-btn prio-btn--secondary"
            >
              <IconSettings />
              Settings
            </Link>
          ) : null}

          {/*
           * The menu itself is for everyone who can open the project, because
           * Clone is theirs: copying work you can already read is not an
           * administrator's privilege, and `duplicateProject` checks project
           * access on the server.
           *
           * Edit and Delete inside it stay with an administrator or the person
           * who created this project — never another member of it. The server
           * enforces that same rule inside `updateProject` and `deleteProject`,
           * so `canManage` only decides what is worth showing.
           */}
          <ProjectActions
            project={{
              id: project.id,
              key: project.key,
              name: project.name,
              description: project.description,
            }}
            issueCount={project._count.issues}
            canManage={canManageProject(user, project)}
          />
        </div>
      </div>

      <ProjectNav projectKey={project.key} />
      </ProjectShellChrome>

      {children}
    </>
  );
}
