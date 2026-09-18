import type { Metadata } from "next";
import Link from "next/link";
import { BackLink } from "@/components/shell/BackLink";
import { ProjectsHeaderActions } from "@/components/projects/ProjectsHeaderActions";
import { SectionHead } from "@/components/dashboard/DashboardParts";
import {
  AvatarStack,
  Card,
  CardBody,
  EmptyState,
} from "@/components/ui/primitives";
import { IconBug, IconEmptyBox, IconIssues, IconStar, IconUsers } from "@/components/ui/Icon";
import { projectScope } from "@/lib/authz";
import { CLOSED_STATUSES, OPEN_STATUSES } from "@/lib/domain";
import { percent } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "Projects" };
export const dynamic = "force-dynamic";

/**
 * Project directory (§19). Admins see every project and can create one;
 * members see only the projects they belong to.
 */
export default async function ProjectsPage({
  searchParams,
}: {
  /* Only ever read for `from`, which Administration sets so this page knows to
     offer the way back. The list itself takes no parameters. */
  searchParams: Promise<{ from?: string }>;
}) {
  const params = await searchParams;
  const user = await requireUser();
  const isAdmin = user.role === "ADMIN";

  const [projects, archived, users] = await Promise.all([
    prisma.project.findMany({
      where: { ...projectScope(user), isArchived: false },
      orderBy: { name: "asc" },
      select: {
        id: true,
        key: true,
        name: true,
        description: true,
        members: {
          take: 8,
          orderBy: { createdAt: "asc" },
          select: {
            user: { select: { id: true, name: true, image: true } },
          },
        },
        _count: { select: { members: true, issues: true } },
      },
    }),
    /* Archived projects, for an administrator to find again. Archiving hides
       a project from every list in Prio, which left the only way back a
       remembered URL; this is that way back, and nothing else reads it. */
    isAdmin
      ? prisma.project.findMany({
          where: { isArchived: true },
          orderBy: { name: "asc" },
          select: {
            id: true,
            key: true,
            name: true,
            _count: { select: { issues: true, members: true } },
          },
        })
      : Promise.resolve([]),
    isAdmin
      ? prisma.user.findMany({
          where: { isActive: true },
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
            jobTitle: true,
          },
          orderBy: { name: "asc" },
        })
      : Promise.resolve([]),
  ]);

  // One grouped query rather than a count per project per status.
  const [stats, favorites] = await Promise.all([
    prisma.issue.groupBy({
      by: ["projectId", "type", "status"],
      where: { projectId: { in: projects.map((p) => p.id) } },
      _count: { _all: true },
    }),
    prisma.projectFavorite.findMany({
      where: { userId: user.id, projectId: { in: projects.map((p) => p.id) } },
      select: { projectId: true },
    }),
  ]);

  const favoriteIds = new Set(favorites.map((f) => f.projectId));

  const summary = new Map<
    string,
    { open: number; done: number; bugs: number; openBugs: number; total: number }
  >();

  for (const project of projects) {
    summary.set(project.id, {
      open: 0,
      done: 0,
      bugs: 0,
      openBugs: 0,
      total: 0,
    });
  }

  for (const row of stats) {
    const entry = summary.get(row.projectId);
    if (!entry) continue;
    const count = row._count._all;
    entry.total += count;
    if ((OPEN_STATUSES as readonly string[]).includes(row.status)) entry.open += count;
    if ((CLOSED_STATUSES as readonly string[]).includes(row.status)) entry.done += count;
    if (row.type === "BUG") {
      entry.bugs += count;
      if ((OPEN_STATUSES as readonly string[]).includes(row.status)) {
        entry.openBugs += count;
      }
    }
  }

  return (
    <>
      {/* Reached from Administration's Users/Projects/Issues/Bugs blocks,
          which say so in the query string. Shown only then: this page is
          reached from the sidebar too, where there is no Administration to go
          back to and a control claiming otherwise would be a lie. */}
      {params.from === "admin" ? (
        <BackLink href="/admin" label="Back to Administration" />
      ) : null}

      <div className="prio-page-header">
        <div className="prio-page-header__text">
          <h1 className="prio-page-header__title">Projects</h1>
          <p className="prio-page-header__subtitle">
            {isAdmin
              ? "Every project in the organization."
              : "Projects you are a member of."}
          </p>
        </div>
        {isAdmin ? (
          <div className="prio-page-header__actions">
            <ProjectsHeaderActions users={users} currentUserId={user.id} />
          </div>
        ) : null}
      </div>

      {projects.length === 0 ? (
        <Card>
          <EmptyState
            icon={<IconEmptyBox />}
            title="No projects yet"
            body={
              isAdmin
                ? "Create your first project to start tracking work in Prio."
                : "Ask an administrator to create your first project."
            }
          />
        </Card>
      ) : (
        <div className="row g-4">
          {projects.map((project) => {
            const s = summary.get(project.id)!;
            const progress = percent(s.done, s.total);

            return (
              <div key={project.id} className="col-12 col-lg-6 col-xxl-4">
                <Card interactive className="prio-projectcard">
                  <CardBody>
                    <div className="prio-projectcard__head">
                      <span className="prio-projectcard__badge" aria-hidden>
                        {project.key.slice(0, 2)}
                      </span>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <h2 className="prio-projectcard__name">
                          {/* Picking a project out of the directory is
                              exactly the choice the Welcome page introduces,
                              so that is where it leads -- not straight into
                              Summary. */}
                          <Link
                            href={`/projects/${project.key.toLowerCase()}/welcome`}
                          >
                            {project.name}
                          </Link>
                        </h2>
                        <span className="prio-key">{project.key}</span>
                      </div>
                      {favoriteIds.has(project.id) ? (
                        <span
                          className="prio-projectcard__fav"
                          title="Favorited"
                          aria-label="Favorited"
                        >
                          <IconStar size={14} fill="currentColor" />
                        </span>
                      ) : null}
                    </div>

                    <p className="prio-projectcard__description prio-clamp-2">
                      {project.description ?? "No description yet."}
                    </p>

                    <div className="prio-projectcard__stats">
                      <span title="Open issues">
                        <IconIssues size={13} />
                        {s.open} open
                      </span>
                      <span
                        title="Open bugs"
                        data-tone={s.openBugs > 0 ? "danger" : undefined}
                      >
                        <IconBug size={13} />
                        {s.openBugs} bugs
                      </span>
                      <span title="Members">
                        <IconUsers size={13} />
                        {project._count.members}
                      </span>
                    </div>

                    <div className="prio-projectcard__progress">
                      <div className="prio-progress" aria-hidden>
                        <div
                          className="prio-progress__bar"
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                      <span className="prio-projectcard__progress-label">
                        {s.total === 0
                          ? "No issues yet"
                          : `${progress}% complete · ${s.done} of ${s.total}`}
                      </span>
                    </div>

                    <div className="prio-projectcard__members">
                      <AvatarStack
                        people={project.members.map((m) => m.user)}
                        max={5}
                      />
                    </div>
                  </CardBody>
                </Card>
              </div>
            );
          })}
        </div>
      )}

      {/*
        * Archived projects.
        *
        * Archiving is reversible and destroys nothing — the issues, members
        * and settings all stay — but it takes the project out of every list,
        * which used to leave no way back except remembering the key. This is
        * the way back, and it is an administrator's: `updateProject` already
        * refuses everybody else, and unarchiving stays where it was, on the
        * project's own settings page.
        */}
      {isAdmin && archived.length > 0 ? (
        <section style={{ marginTop: "var(--prio-space-6)" }}>
          <SectionHead title="Archived projects" count={archived.length} />
          <Card>
            <CardBody>
              <ul className="prio-archivedlist">
                {archived.map((project) => (
                  <li key={project.id} className="prio-memberrow">
                    <span className="prio-projectcard__badge" aria-hidden>
                      {project.key.slice(0, 2)}
                    </span>
                    <span className="prio-memberpicker__text">
                      <span className="prio-memberpicker__name">
                        {project.name}
                      </span>
                      <span className="prio-memberpicker__meta">
                        {project.key} · {project._count.issues} issues ·{" "}
                        {project._count.members} members
                      </span>
                    </span>
                    <Link
                      href={`/projects/${project.key.toLowerCase()}/summary`}
                      className="prio-btn prio-btn--ghost prio-btn--sm"
                    >
                      Open
                    </Link>
                    <Link
                      href={`/projects/${project.key.toLowerCase()}/settings`}
                      className="prio-btn prio-btn--secondary prio-btn--sm"
                    >
                      Restore
                    </Link>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
        </section>
      ) : null}
    </>
  );
}
