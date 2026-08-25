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

  const [projects, unreadNotifications, pendingNewUserAlerts] =
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
    ]);

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
