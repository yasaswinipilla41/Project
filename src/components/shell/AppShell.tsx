"use client";

import type { ReactNode } from "react";
import {
  NewUserAlerts,
  type NewUserAlert,
} from "@/components/notifications/NewUserAlerts";
import { ToastProvider } from "@/components/ui/Toast";
import { Sidebar, useSidebarState, type SidebarProject } from "./Sidebar";
import { Topbar, type TopbarUser } from "./Topbar";

/**
 * The Prio application frame. Server components render inside `children`; only
 * the chrome (collapse state, menus, search box) is client-side.
 */
export function AppShell({
  user,
  projects,
  unreadNotifications,
  newUserAlerts = [],
  initialCollapsed,
  children,
}: {
  user: TopbarUser;
  projects: SidebarProject[];
  unreadNotifications: number;
  /** Admin-only; always empty for a Member. */
  newUserAlerts?: NewUserAlert[];
  initialCollapsed: boolean;
  children: ReactNode;
}) {
  const { collapsed, mobileOpen, toggleCollapsed, openMobile, closeMobile } =
    useSidebarState(initialCollapsed);

  return (
    <ToastProvider>
      <NewUserAlerts alerts={newUserAlerts} />
      <div className="prio-shell">
        <a className="prio-skip-link" href="#prio-main-content">
          Skip to main content
        </a>

        <Sidebar
          isAdmin={user.role === "ADMIN"}
          projects={projects}
          unreadNotifications={unreadNotifications}
          collapsed={collapsed}
          mobileOpen={mobileOpen}
          onToggleCollapsed={toggleCollapsed}
          onCloseMobile={closeMobile}
        />

        <div className="prio-main" data-collapsed={collapsed}>
          <Topbar
            user={user}
            projects={projects}
            unreadNotifications={unreadNotifications}
            onOpenMobileNav={openMobile}
          />
          <main id="prio-main-content" className="prio-content">
            <div className="prio-content__inner">{children}</div>
          </main>
        </div>
      </div>
    </ToastProvider>
  );
}
