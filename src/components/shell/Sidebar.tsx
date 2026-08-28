"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { PrioLogo } from "@/components/brand/PrioLogo";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "@/components/ui/Menu";
import { useToast } from "@/components/ui/Toast";
import {
  IconAdmin,
  IconBell,
  IconActivity,
  IconBoard,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconExternal,
  IconHome,
  IconIssues,
  IconMore,
  IconMyWork,
  IconPin,
  IconProjects,
  IconReports,
  IconSearch,
  IconStar,
} from "@/components/ui/Icon";
import type { IconProps } from "@/components/ui/Icon";
import { toggleProjectFavorite, toggleProjectPin } from "@/server/projects";

export interface SidebarProject {
  id: string;
  name: string;
  key: string;
  isFavorite: boolean;
  isPinned: boolean;
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
  /**
   * Sub-routes ending in this suffix belong to another nav item and must not
   * also light up this one — e.g. `/projects/[key]/board` is Flow Board's
   * route, even though it sits under Projects' own `/projects/[key]` prefix.
   */
  excludeSuffix?: string;
  /**
   * Decides active state directly from the pathname instead of comparing
   * against `href`. Flow Board needs this: with no projects to link to, its
   * `href` falls back to `/projects` — identical to the Projects entry's own
   * href — so a plain `pathname === href` check would light both up together
   * on that page. This keeps Flow Board active only on an actual board route,
   * regardless of what its href currently resolves to.
   */
  activeTest?: (pathname: string) => boolean;
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
  const router = useRouter();
  const { toast } = useToast();
  const [pinnedExpanded, setPinnedExpanded] = useState(true);

  async function handleFavorite(project: SidebarProject) {
    const result = await toggleProjectFavorite({ projectId: project.id });
    if (!result.ok) {
      toast(result.error, "error");
      return;
    }
    router.refresh();
  }

  async function handlePin(project: SidebarProject) {
    const result = await toggleProjectPin({ projectId: project.id });
    if (!result.ok) {
      toast(result.error, "error");
      return;
    }
    router.refresh();
  }

  async function handleShare(project: SidebarProject) {
    const url = `${window.location.origin}/projects/${project.key.toLowerCase()}/board`;
    try {
      await navigator.clipboard.writeText(url);
      toast("Board link copied to clipboard");
    } catch {
      toast("Couldn't copy the link — copy it from the address bar instead.", "error");
    }
  }

  const entries: NavEntry[] = [
    { href: "/", label: "Home", Icon: IconHome },
    {
      href: flowBoardHref(pathname, projects),
      label: "Flow Board",
      Icon: IconBoard,
      activeTest: (p) => /^\/projects\/[^/]+\/board(\/|$)/.test(p),
    },
    {
      href: "/projects",
      label: "Projects",
      Icon: IconProjects,
      prefix: true,
      excludeSuffix: "/board",
    },
    { href: "/issues", label: "Issues", Icon: IconIssues, prefix: true },
    { href: "/my-work", label: "My Work", Icon: IconMyWork, prefix: true },
    // §19 — the audit trail already lives at /activity; it simply had no way in.
    { href: "/activity", label: "Activity", Icon: IconActivity, prefix: true },
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

  const isActive = (entry: NavEntry) => {
    if (entry.activeTest) return entry.activeTest(pathname);
    if (!entry.prefix) return pathname === entry.href;
    const withinPrefix =
      pathname === entry.href || pathname.startsWith(`${entry.href}/`);
    if (!withinPrefix) return false;
    if (entry.excludeSuffix && pathname.endsWith(entry.excludeSuffix)) {
      return false;
    }
    return true;
  };

  function renderProjectRow(project: SidebarProject) {
    const href = `/projects/${project.key.toLowerCase()}`;
    // Same rule as the top-level Projects nav item: the project's own
    // Overview/Settings pages count as "on this project", but its Flow Board
    // route belongs to the Flow Board nav item instead.
    const active =
      (pathname === href || pathname.startsWith(`${href}/`)) &&
      !pathname.endsWith("/board");
    return (
      <div
        key={project.id}
        className="prio-navitem prio-sidebar__project-row"
        data-active={active}
      >
        <Link
          href={href}
          className="prio-sidebar__project-link"
          title={collapsed ? project.name : undefined}
          onClick={onCloseMobile}
        >
          <span className="prio-project-chip" aria-hidden>
            {project.key.slice(0, 2)}
          </span>
          <span className="prio-navitem__label">{project.name}</span>
        </Link>

        {!collapsed && project.isFavorite ? (
          <span
            className="prio-sidebar__project-fav"
            title="Favorited"
            aria-label="Favorited"
          >
            <IconStar size={12} fill="currentColor" />
          </span>
        ) : null}

        {!collapsed ? (
          <div className="prio-sidebar__project-actions">
            {/* Already pinned is exactly what the Pinned section itself
               says — a persistent pin icon there would just repeat it.
               Unpinning still works, from the "..." menu below. */}
            {!project.isPinned ? (
              <button
                type="button"
                className="prio-sidebar__project-menu-trigger"
                aria-label={`Pin ${project.name}`}
                title="Pin"
                onClick={() => handlePin(project)}
              >
                <IconPin size={13} fill="none" />
              </button>
            ) : null}

            <Menu
              align="end"
              width={200}
              label={`More actions for ${project.name}`}
              trigger={(props) => (
                <button
                  type="button"
                  className="prio-sidebar__project-menu-trigger"
                  aria-label={`More actions for ${project.name}`}
                  {...props}
                >
                  <IconMore size={14} />
                </button>
              )}
            >
              <MenuLabel>{project.name}</MenuLabel>
              <MenuSeparator />
              <MenuItem
                icon={<IconStar fill={project.isFavorite ? "currentColor" : "none"} />}
                onSelect={() => handleFavorite(project)}
              >
                {project.isFavorite ? "Remove from Favorites" : "Add to Favorites"}
              </MenuItem>
              <MenuItem
                icon={<IconPin fill={project.isPinned ? "currentColor" : "none"} />}
                onSelect={() => handlePin(project)}
              >
                {project.isPinned ? "Unpin" : "Pin"}
              </MenuItem>
              <MenuItem icon={<IconExternal />} onSelect={() => handleShare(project)}>
                Share
              </MenuItem>
            </Menu>
          </div>
        ) : null}
      </div>
    );
  }

  const pinnedProjects = projects.filter((p) => p.isPinned);
  const recentProjects = projects.filter((p) => !p.isPinned);

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
                key={entry.label}
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
              <button
                type="button"
                className="prio-sidebar__section-label prio-sidebar__section-label--toggle"
                onClick={() => setPinnedExpanded((v) => !v)}
                aria-expanded={pinnedExpanded}
                title={collapsed ? "Pinned" : undefined}
              >
                {!collapsed ? (
                  <IconChevronDown
                    size={12}
                    className="prio-sidebar__section-chevron"
                    style={{ transform: pinnedExpanded ? undefined : "rotate(-90deg)" }}
                  />
                ) : null}
                <span>Pinned</span>
              </button>

              {pinnedExpanded ? (
                pinnedProjects.length > 0 ? (
                  pinnedProjects.map(renderProjectRow)
                ) : !collapsed ? (
                  <p className="prio-sidebar__empty">
                    Pin a project to keep it here.
                  </p>
                ) : null
              ) : null}
            </div>
          ) : null}

          {recentProjects.length > 0 ? (
            <div className="prio-sidebar__section">
              <p className="prio-sidebar__section-label">Recents</p>
              {recentProjects.map(renderProjectRow)}
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

/**
 * Where the sidebar's single "Flow Board" link goes.
 *
 * The route is always project-scoped (`/projects/[key]/board`), but the item
 * itself is a plain link — no picker, no submenu. If the caller is already
 * inside a project's pages, its board is what "Flow Board" means right now;
 * otherwise it falls back to the first project the sidebar already lists.
 */
function flowBoardHref(pathname: string, projects: SidebarProject[]): string {
  const [firstProject] = projects;
  if (!firstProject) return "/projects";

  const current = projects.find((project) => {
    const projectHref = `/projects/${project.key.toLowerCase()}`;
    return pathname === projectHref || pathname.startsWith(`${projectHref}/`);
  });

  return `/projects/${(current ?? firstProject).key.toLowerCase()}/board`;
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
