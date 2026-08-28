import type { Metadata } from "next";
import { UserAdmin } from "@/components/admin/UserAdmin";
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
  const admin = await requireAdmin();

  const [
    users,
    projects,
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

  // Open work per person, in one grouped query rather than one per user.
  const openByAssignee = await prisma.issue.groupBy({
    by: ["assigneeId"],
    where: { status: { in: [...OPEN_STATUSES] } },
    _count: { _all: true },
  });
  const openCount = new Map(
    openByAssignee
      .filter((r) => r.assigneeId !== null)
      .map((r) => [r.assigneeId as string, r._count._all]),
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
        <div className="col-6 col-xl-3">
          <Stat
            label="Users"
            value={users.length}
            icon={<IconUsers size={13} />}
            hint={`${activeUsers} active · ${admins} admin`}
          />
        </div>
        <div className="col-6 col-xl-3">
          <Stat
            label="Projects"
            value={projects.length}
            hint={`${projects.reduce((s, p) => s + p._count.issues, 0)} issues total`}
          />
        </div>
        <div className="col-6 col-xl-3">
          <Stat
            label="Issues"
            value={totalIssues}
            icon={<IconIssues size={13} />}
            tone="brand"
            hint={`${openIssues} open · ${completedIssues} done`}
          />
        </div>
        <div className="col-6 col-xl-3">
          <Stat
            label="Bugs"
            value={totalBugs}
            icon={<IconBug size={13} />}
            tone={openBugs > 0 ? "danger" : "default"}
            hint={`${openBugs} open · ${overdue} overdue overall`}
          />
        </div>
      </div>

      <div style={{ marginBottom: "var(--prio-space-6)" }}>
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
          projects={projects.map((p) => ({ id: p.id, key: p.key, name: p.name }))}
          currentUserId={admin.id}
        />
      </div>

    </>
  );
}
