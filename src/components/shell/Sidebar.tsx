"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { PrioLogo } from "@/components/brand/PrioLogo";
import { useToast } from "@/components/ui/Toast";
import {
  IconAdmin,
  IconBell,
  IconBoard,
  IconChevronLeft,
  IconChevronRight,
  IconHome,
  IconIssues,
  IconMyWork,
  IconProjects,
  IconReports,
  IconSearch,
  IconStar,
} from "@/components/ui/Icon";
import type { IconProps } from "@/components/ui/Icon";
import { toggleProjectFavorite } from "@/server/projects";

export interface SidebarProject {
  id: string;
  name: string;
  key: string;
  isFavorite: boolean;
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

  async function handleFavorite(project: SidebarProject) {
    const result = await toggleProjectFavorite({ projectId: project.id });
    if (!result.ok) {
      toast(result.error, "error");
      return;
    }
    router.refresh();
  }

  const entries: NavEntry[] = [
    { href: "/", label: "Home", Icon: IconHome },
    /*
     * The sidebar's Flow Board is the all-projects board, always.
     *
     * It used to resolve to whichever project you happened to be inside,
     * which made one navigation item mean two different boards depending on
     * where you clicked it — and put a "Back to <project>" control above a
     * board you had not reached from that project. The two contexts are now
     * two routes: this one, and the project's own board reached from its tab
     * strip or from the board's Project dropdown. Both light this entry up,
     * because both are the Flow Board.
     */
    {
      href: "/board",
      label: "Flow Board",
      Icon: IconBoard,
      activeTest: (p) =>
        p === "/board" ||
        p.startsWith("/board/") ||
        /^\/projects\/[^/]+\/board(\/|$)/.test(p),
    },
    {
      href: "/projects",
      label: "Projects",
      Icon: IconProjects,
      prefix: true,
      excludeSuffix: "/board",
    },
    { href: "/issues", label: "Issues", Icon: IconIssues, prefix: true },
    /* My Work is a personal queue, and an administrator's sidebar is not the
       place for one — the same reasoning that took My assigned tasks off
       Admin Home. The route, the page and the data are untouched: an admin
       who opens /my-work directly still gets it, and every member still has
       the link. */
    ...(isAdmin
      ? []
      : [
          {
            href: "/my-work",
            label: "My Work",
            Icon: IconMyWork,
            prefix: true,
          } satisfies NavEntry,
        ]),
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
    const base = `/projects/${project.key.toLowerCase()}`;
    /* The sidebar is a project picker, so its rows lead to the Welcome page --
       the step that says which project has been chosen -- rather than dropping
       straight into that project's Summary. */
    const href = `${base}/welcome`;
    // Same rule as the top-level Projects nav item: the project's own
    // Overview/Settings pages count as "on this project", but its Flow Board
    // route belongs to the Flow Board nav item instead. Tested against the
    // project's base path, not the link, so every view under it marks the row.
    const active =
      (pathname === base || pathname.startsWith(`${base}/`)) &&
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

        {!collapsed ? (
          /*
           * Name -> Favourite.
           *
           * Pinning is gone, and with it the Pin button and the empty slot
           * that reserved its width so two sections could line up -- there is
           * one section now. The "..." menu went earlier; Favorite is the one
           * control left, and it does its job in a single click.
           */
          <div className="prio-sidebar__project-actions">
            {/*
             * One star, doing both jobs. Favourited, it stays lit whether or
             * not the row is hovered -- that is the badge beside the project
             * name that a Flow Board favourite has to show up as, and it
             * reads from the same `isFavorite` the board writes, so the two
             * cannot disagree. Not favourited, it appears on hover like every
             * other action here. A separate badge *and* a separate toggle
             * would put two stars on the same row.
             */}
            <button
              type="button"
              className="prio-sidebar__project-menu-trigger prio-sidebar__project-fav"
              data-on={project.isFavorite || undefined}
              aria-pressed={project.isFavorite}
              aria-label={
                project.isFavorite
                  ? `Remove ${project.name} from favorites`
                  : `Add ${project.name} to favorites`
              }
              title={project.isFavorite ? "Favorited" : "Favorite"}
              onClick={() => handleFavorite(project)}
            >
              <IconStar size={13} fill={project.isFavorite ? "currentColor" : "none"} />
            </button>

          </div>
        ) : null}
      </div>
    );
  }

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

          {/*
           * One list, named Projects.
           *
           * There were two sections, Pinned above Recents, and pinning is
           * gone -- so is the split it existed to create. The rows themselves
           * are unchanged: same order (the layout still sorts by most
           * recently opened), same names, same icons, same navigation.
           */}
          {projects.length > 0 ? (
            <div className="prio-sidebar__section">
              <p className="prio-sidebar__section-label">Projects</p>
              {projects.map(renderProjectRow)}
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
