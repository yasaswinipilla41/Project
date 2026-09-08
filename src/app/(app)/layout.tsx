import { cookies } from "next/headers";
import { AppShell } from "@/components/shell/AppShell";
import { SIDEBAR_COOKIE } from "@/components/shell/Sidebar";
import { prisma } from "@/lib/prisma";
import { projectScope, workRoleOf } from "@/lib/authz";
import { requireUser } from "@/lib/session";

/**
 * Authenticated application layout. Resolves the session server-side and loads
 * the chrome's data (project shortcuts, unread count) in one place.
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();

  const cookieStore = await cookies();
  const initialCollapsed = cookieStore.get(SIDEBAR_COOKIE)?.value === "true";

  const isAdmin = user.role === "ADMIN";
  /* Resolved once, here, and handed to the chrome — so every surface offers
     the same things to the same person rather than each deciding again. */
  const workRole = await workRoleOf(user);

  const [projectRows, unreadNotifications, pendingNewUserAlerts, favorites, recents] =
    await Promise.all([
      prisma.project.findMany({
        where: { ...projectScope(user), isArchived: false },
        select: { id: true, name: true, key: true },
        orderBy: { name: "asc" },
        take: 12,
      }),
      prisma.notification.count({
        where: { userId: user.id, readAt: null },
      }),
      // Admin-only: the toast that announces a new teammate's first sign-in.
      isAdmin
        ? prisma.notification.findMany({
            where: { userId: user.id, type: "USER_JOINED", readAt: null },
            select: { id: true, message: true, actor: { select: { name: true } } },
            orderBy: { createdAt: "asc" },
            take: 5,
          })
        : Promise.resolve([]),
      prisma.projectFavorite.findMany({
        where: { userId: user.id },
        select: { projectId: true },
      }),
      prisma.projectRecent.findMany({
        where: { userId: user.id },
        select: { projectId: true, lastVisitedAt: true },
      }),
    ]);

  const favoriteIds = new Set(favorites.map((f) => f.projectId));
  const lastVisitedAt = new Map(
    recents.map((r) => [r.projectId, r.lastVisitedAt.getTime()]),
  );

  /*
   * Most-recently-opened first, which is the order the sidebar's project list
   * has always used within a section. A project this user has never opened
   * sorts after every one they have, falling back to the query's own
   * alphabetical order so nothing before a first visit is unreachable or
   * reordered at random.
   *
   * There is no pinned group to lift above it any more — the sidebar has one
   * list, so the tie-break that put pinned projects first has nothing left to
   * separate.
   */
  const projects = [...projectRows]
    .sort(
      (a, b) => (lastVisitedAt.get(b.id) ?? 0) - (lastVisitedAt.get(a.id) ?? 0),
    )
    .map((project) => ({
      ...project,
      isFavorite: favoriteIds.has(project.id),
    }));

  return (
    <AppShell
      user={{
        id: user.id,
        name: user.name,
        email: user.email,
        image: user.image,
        role: user.role,
      }}
      workRole={workRole}
      projects={projects}
      unreadNotifications={unreadNotifications}
      newUserAlerts={pendingNewUserAlerts.map((n) => ({
        id: n.id,
        message: `${n.actor?.name ?? "A new teammate"} ${n.message}`,
      }))}
      initialCollapsed={initialCollapsed}
    >
      {children}
    </AppShell>
  );
}
