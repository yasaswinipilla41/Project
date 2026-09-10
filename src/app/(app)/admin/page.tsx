import type { Metadata } from "next";
import { TeamAdmin } from "@/components/admin/TeamAdmin";
import { UserAdmin } from "@/components/admin/UserAdmin";
import { NewUsers, SectionHead } from "@/components/dashboard/DashboardParts";
import { loadNewUsers } from "@/server/queries/dashboard";
import { Card, CardBody } from "@/components/ui/primitives";
import { Stat } from "@/components/ui/primitives";
import { IconAdmin, IconBug, IconIssues, IconUsers } from "@/components/ui/Icon";
import { CLOSED_STATUSES, OPEN_STATUSES } from "@/lib/domain";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session";

export const metadata: Metadata = { title: "Administration" };
export const dynamic = "force-dynamic";

/**
 * Administration (§23).
 *
 * `requireAdmin` gates the whole route server-side, and every action invoked
 * from here re-checks the caller's role — the page being unreachable is not
 * what makes it safe.
 */
export default async function AdminPage() {
  // Gates the route; the sections below re-check for themselves.
  const admin = await requireAdmin();

  const [
    users,
    projects,
    newUsers,
    teams,
    totalIssues,
    openIssues,
    completedIssues,
    totalBugs,
    openBugs,
    overdue,
  ] = await Promise.all([
    prisma.user.findMany({
      orderBy: [{ isActive: "desc" }, { name: "asc" }],
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
        jobTitle: true,
        role: true,
        isActive: true,
        createdAt: true,
        _count: { select: { projectMemberships: true } },
      },
    }),
    prisma.project.findMany({
      where: { isArchived: false },
      orderBy: { name: "asc" },
      select: {
        id: true,
        key: true,
        name: true,
        createdAt: true,
        createdBy: { select: { name: true } },
        _count: { select: { members: true, issues: true } },
      },
    }),
    loadNewUsers(),
    prisma.team.findMany({
      orderBy: { name: "asc" },
      select: {
        id: true,
        slug: true,
        name: true,
        description: true,
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
      },
    }),
    prisma.issue.count(),
    prisma.issue.count({ where: { status: { in: [...OPEN_STATUSES] } } }),
    prisma.issue.count({ where: { status: "DONE" } }),
    prisma.issue.count({ where: { type: "BUG" } }),
    prisma.issue.count({
      where: { type: "BUG", status: { in: [...OPEN_STATUSES] } },
    }),
    prisma.issue.count({
      where: {
        dueDate: { lt: new Date() },
        status: { notIn: [...CLOSED_STATUSES] },
      },
    }),
  ]);

  /* Open work per person, in one grouped query rather than one per user —
     the same figure `/admin/users` computes, for the same block. */
  const openByAssignee = await prisma.issue.groupBy({
    by: ["assigneeId"],
    where: { status: { in: [...OPEN_STATUSES] } },
    _count: { _all: true },
  });
  const openCount = new Map(
    openByAssignee
      .filter((row) => row.assigneeId !== null)
      .map((row) => [row.assigneeId as string, row._count._all]),
  );

  const activeUsers = users.filter((u) => u.isActive).length;
  const admins = users.filter((u) => u.role === "ADMIN" && u.isActive).length;

  return (
    <>
      <div className="prio-page-header">
        <div className="prio-page-header__text">
          <h1 className="prio-page-header__title">
            <IconAdmin />
            Administration
          </h1>
          <p className="prio-page-header__subtitle">
            Users, projects and organization-wide statistics for Symbiosys
            Technologies.
          </p>
        </div>
      </div>

      <div className="row g-3" style={{ marginBottom: "var(--prio-space-6)" }}>
        {/*
          * Each tile opens what it counts.
          *
          * `Stat` has taken an `href` since the dashboard's KPI cards were
          * built, so this is the affordance being used rather than a new one:
          * the markup, tone and hint are untouched and a linked tile looks
          * exactly like the plain one it replaces.
          *
          * Projects, Issues and Bugs each open a page of their own, and
          * `from=admin` is what those shared pages read to decide whether to
          * offer a way back — they are reached from the sidebar as well, where
          * a "Back to Administration" control would be a lie.
          *
          * Users is the exception, and now behaves like the heading it is:
          * People is rendered further down this page, so the tile scrolls to
          * it rather than leaving Administration to show it. Sending somebody
          * to another page for a block that is already here made managing
          * people a detour from the page that manages everything else.
          * `/admin/users` still exists and still renders the same component
          * for anyone who goes there directly.
          */}
        <div className="col-6 col-xl-3">
          <Stat
            label="Users"
            value={users.length}
            icon={<IconUsers size={13} />}
            hint={`${activeUsers} active · ${admins} admin`}
            href="#people"
          />
        </div>
        <div className="col-6 col-xl-3">
          <Stat
            label="Projects"
            value={projects.length}
            hint={`${projects.reduce((s, p) => s + p._count.issues, 0)} issues total`}
            href="/projects?from=admin"
          />
        </div>
        <div className="col-6 col-xl-3">
          <Stat
            label="Issues"
            value={totalIssues}
            icon={<IconIssues size={13} />}
            tone="brand"
            hint={`${openIssues} open · ${completedIssues} done`}
            href="/issues?from=admin"
          />
        </div>
        <div className="col-6 col-xl-3">
          <Stat
            label="Bugs"
            value={totalBugs}
            icon={<IconBug size={13} />}
            tone={openBugs > 0 ? "danger" : "default"}
            hint={`${openBugs} open · ${overdue} overdue overall`}
            href="/bugs?from=admin"
          />
        </div>
      </div>

      {/*
        * Who joined recently.
        *
        * This used to sit at the top of Home, where it was the one piece of
        * people administration on a page everybody else uses to see their own
        * work. It belongs here, with the rest of people management, and Home
        * is left to answer what is happening rather than who to onboard.
        * Nothing about it changed but where it is rendered.
        */}
      {newUsers.length > 0 ? (
        <div style={{ marginBottom: "var(--prio-space-6)" }}>
          <SectionHead title="New members" count={newUsers.length} />
          <Card>
            <CardBody>
              <NewUsers users={newUsers} />
            </CardBody>
          </Card>
        </div>
      ) : null}

      <div style={{ marginBottom: "var(--prio-space-6)" }}>
        <TeamAdmin
          teams={teams.map((team) => ({
            id: team.id,
            slug: team.slug,
            name: team.name,
            description: team.description,
            members: team.members.map(({ user: member }) => member),
          }))}
          everyone={users
            .filter((u) => u.isActive)
            .map((u) => ({
              id: u.id,
              name: u.name,
              email: u.email,
              image: u.image,
              jobTitle: u.jobTitle,
              /* Carried so the dialog's Role field can narrow the Members
                 list to the people that role can name. */
              role: u.role,
            }))}
          /* The same live projects the rest of this page counts, so the
             dialog's list can never name one that has been archived. */
          projects={projects.map((p) => ({
            id: p.id,
            key: p.key,
            name: p.name,
          }))}
        />
      </div>

      {/*
        * People, under Development and Testing.
        *
        * The same `UserAdmin` that `/admin/users` renders — the component, its
        * props, its actions and its permissions are untouched; only where it
        * is drawn changed. Administration now reads as the three rosters it
        * administers, in the order they were asked for: who builds, who
        * checks, and everybody with an account.
        *
        * The `#people` id is what the Users tile above scrolls to, and it is
        * the id that block has always carried on its own page. No heading is
        * added around it: `UserAdmin` draws its own, and a second one here
        * would put the word People on the page twice.
        */}
      <div id="people">
        <UserAdmin
          users={users.map((u) => ({
            id: u.id,
            name: u.name,
            email: u.email,
            image: u.image,
            jobTitle: u.jobTitle,
            role: u.role,
            isActive: u.isActive,
            createdAt: u.createdAt,
            projectCount: u._count.projectMemberships,
            assignedOpen: openCount.get(u.id) ?? 0,
          }))}
          projects={projects.map((p) => ({
            id: p.id,
            key: p.key,
            name: p.name,
          }))}
          currentUserId={admin.id}
        />
      </div>
    </>
  );
}
