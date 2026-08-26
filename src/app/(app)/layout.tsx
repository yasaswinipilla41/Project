import { cookies } from "next/headers";
import { AppShell } from "@/components/shell/AppShell";
import { SIDEBAR_COOKIE } from "@/components/shell/Sidebar";
import { prisma } from "@/lib/prisma";
import { projectScope } from "@/lib/authz";
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

  const [projectRows, unreadNotifications, pendingNewUserAlerts, pins, favorites, recents] =
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
      prisma.projectPin.findMany({
        where: { userId: user.id },
        select: { projectId: true },
      }),
      prisma.projectFavorite.findMany({
        where: { userId: user.id },
        select: { projectId: true },
      }),
      prisma.projectRecent.findMany({
        where: { userId: user.id },
        select: { projectId: true, lastVisitedAt: true },
      }),
    ]);

  const pinnedIds = new Set(pins.map((p) => p.projectId));
  const favoriteIds = new Set(favorites.map((f) => f.projectId));
  const lastVisitedAt = new Map(
    recents.map((r) => [r.projectId, r.lastVisitedAt.getTime()]),
  );

  /*
   * Pinned projects stay easily reachable at the top of the sidebar list —
   * the whole point of pinning something. Within each group (pinned, then
   * everything else — the sidebar's "Recents"), most-recently-opened sorts
   * first; a project this user has never opened sorts after every one they
   * have, falling back to the query's own alphabetical order so nothing
   * before a first visit is ever unreachable or reordered at random.
   */
  const projects = [...projectRows]
    .sort((a, b) => {
      const pinDiff = Number(pinnedIds.has(b.id)) - Number(pinnedIds.has(a.id));
      if (pinDiff !== 0) return pinDiff;
      return (lastVisitedAt.get(b.id) ?? 0) - (lastVisitedAt.get(a.id) ?? 0);
    })
    .map((project) => ({
      ...project,
      isPinned: pinnedIds.has(project.id),
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
