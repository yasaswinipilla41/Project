import type { Metadata } from "next";
import { UserAdmin } from "@/components/admin/UserAdmin";
import { BackLink } from "@/components/shell/BackLink";
import { IconUsers } from "@/components/ui/Icon";
import { OPEN_STATUSES } from "@/lib/domain";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/session";

export const metadata: Metadata = { title: "People" };
export const dynamic = "force-dynamic";

/**
 * People — the Users block of Administration, on its own route.
 *
 * It used to be a section further down `/admin`, reached by an anchor. The
 * four blocks at the top of that page each open what they count now, and an
 * anchor into the page you are already on is not an opening — so this is where
 * Users goes, alongside Projects, Issues and Bugs, each with the same way back.
 *
 * `UserAdmin` is the same component it always was, rendered here instead of
 * there: nothing about managing people changed, only which page holds it.
 * `requireAdmin` gates the route, and every action it invokes re-checks the
 * caller for itself.
 */
export default async function AdminUsersPage() {
  const admin = await requireAdmin();

  const [users, projects] = await Promise.all([
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
      select: { id: true, key: true, name: true },
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

  return (
    <>
      <BackLink href="/admin" label="Back to Administration" />

      <div className="prio-page-header">
        <div className="prio-page-header__text">
          <h1 className="prio-page-header__title">
            <IconUsers />
            People
          </h1>
          <p className="prio-page-header__subtitle">
            Everybody with an account, what they can open, and what they are
            carrying.
          </p>
        </div>
      </div>

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
          projects={projects}
          currentUserId={admin.id}
        />
      </div>
    </>
  );
}
