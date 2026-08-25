"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { PrioLogo } from "@/components/brand/PrioLogo";
import {
  IconAdmin,
  IconBell,
  IconBug,
  IconChevronLeft,
  IconChevronRight,
  IconHome,
  IconIssues,
  IconMyWork,
  IconProjects,
  IconReports,
  IconSearch,
} from "@/components/ui/Icon";
import type { IconProps } from "@/components/ui/Icon";

export interface SidebarProject {
  id: string;
  name: string;
  key: string;
}

export interface SidebarProps {
  isAdmin: boolean;
  projects: SidebarProject[];
  unreadNotifications: number;
  collapsed: boolean;
  mobileOpen: boolean;
  onToggleCollapsed: () => void;
  onCloseMobile: () => void;
}

interface NavEntry {
  href: string;
  label: string;
  Icon: (props: IconProps) => React.JSX.Element;
  count?: number;
  countTone?: "brand";
  adminOnly?: boolean;
  /** Match sub-routes as well as the exact path. */
  prefix?: boolean;
}

export function Sidebar({
  isAdmin,
  projects,
  unreadNotifications,
  collapsed,
  mobileOpen,
  onToggleCollapsed,
  onCloseMobile,
}: SidebarProps) {
  const pathname = usePathname();

  const entries: NavEntry[] = [
    { href: "/", label: "Home", Icon: IconHome },
    { href: "/projects", label: "Projects", Icon: IconProjects, prefix: true },
    { href: "/issues", label: "Issues", Icon: IconIssues, prefix: true },
    { href: "/bugs", label: "Bugs", Icon: IconBug, prefix: true },
    { href: "/my-work", label: "My Work", Icon: IconMyWork, prefix: true },
    {
      href: "/notifications",
      label: "Notifications",
      Icon: IconBell,
      count: unreadNotifications,
      countTone: "brand",
      prefix: true,
    },
    { href: "/search", label: "Search", Icon: IconSearch, prefix: true },
    { href: "/reports", label: "Reports", Icon: IconReports, prefix: true },
  ];

  const isActive = (entry: NavEntry) =>
    entry.prefix
      ? pathname === entry.href || pathname.startsWith(`${entry.href}/`)
      : pathname === entry.href;

  return (
    <>
      {mobileOpen ? (
        <div
          className="prio-sidebar__scrim"
          onClick={onCloseMobile}
          aria-hidden
        />
      ) : null}

      <nav
        className="prio-sidebar"
        data-collapsed={collapsed}
        data-mobile-open={mobileOpen}
        aria-label="Primary"
      >
        <div className="prio-sidebar__brand">
          <Link
            href="/"
            aria-label="Prio home"
            style={{ display: "inline-flex", minWidth: 0 }}
            onClick={onCloseMobile}
          >
            <PrioLogo
              variant={collapsed ? "mark" : "lockup"}
              size="sm"
              tone="nav"
              decorative
            />
          </Link>
        </div>

        <div className="prio-sidebar__nav prio-scroll">
          <div className="prio-sidebar__section">
            {entries.map((entry) => (
              <Link
                key={entry.href}
                href={entry.href}
                className="prio-navitem"
                aria-current={isActive(entry) ? "page" : undefined}
                title={collapsed ? entry.label : undefined}
                onClick={onCloseMobile}
              >
                <span className="prio-navitem__icon">
                  <entry.Icon />
                </span>
                <span className="prio-navitem__label">{entry.label}</span>
                {entry.count && entry.count > 0 ? (
                  <span
                    className="prio-navitem__count"
                    data-tone={entry.countTone}
                  >
                    {entry.count > 99 ? "99+" : entry.count}
                  </span>
                ) : null}
              </Link>
            ))}
          </div>

          {projects.length > 0 ? (
            <div className="prio-sidebar__section">
              <p className="prio-sidebar__section-label">Projects</p>
              {projects.map((project) => {
                const href = `/projects/${project.key.toLowerCase()}`;
                const active = pathname.startsWith(href);
                return (
                  <Link
                    key={project.id}
                    href={href}
                    className="prio-navitem"
                    data-active={active}
                    title={collapsed ? project.name : undefined}
                    onClick={onCloseMobile}
                  >
                    <span className="prio-project-chip" aria-hidden>
                      {project.key.slice(0, 2)}
                    </span>
                    <span className="prio-navitem__label">{project.name}</span>
                  </Link>
                );
              })}
            </div>
          ) : null}

          {isAdmin ? (
            <div className="prio-sidebar__section">
              <p className="prio-sidebar__section-label">Organization</p>
              <Link
                href="/admin"
                className="prio-navitem"
                data-active={pathname.startsWith("/admin")}
                title={collapsed ? "Administration" : undefined}
                onClick={onCloseMobile}
              >
                <span className="prio-navitem__icon">
                  <IconAdmin />
                </span>
                <span className="prio-navitem__label">Administration</span>
              </Link>
            </div>
          ) : null}
        </div>

        <div className="prio-sidebar__footer">
          <button
            type="button"
            className="prio-sidebar__collapse"
            onClick={onToggleCollapsed}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {collapsed ? <IconChevronRight /> : <IconChevronLeft />}
          </button>
        </div>
      </nav>
    </>
  );
}

export const SIDEBAR_COOKIE = "prio.sidebar.collapsed";

/**
 * The collapsed preference is stored in a cookie rather than localStorage so
 * the server already knows it on first render — the sidebar never paints
 * expanded and then snaps closed.
 */
export function useSidebarState(initialCollapsed: boolean) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      // One year, same-site; the value is a UI preference, nothing sensitive.
      document.cookie = `${SIDEBAR_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
      return next;
    });
  };

  return {
    collapsed,
    mobileOpen,
    toggleCollapsed,
    openMobile: () => setMobileOpen(true),
    closeMobile: () => setMobileOpen(false),
  };
}
