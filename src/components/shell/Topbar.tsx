"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import { signOut } from "@/lib/auth-client";
import { Avatar } from "@/components/ui/primitives";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "@/components/ui/Menu";
import {
  IconBell,
  IconChevronDown,
  IconHelp,
  IconList,
  IconLogout,
  IconPlus,
  IconProjects,
  IconSearch,
  IconUser,
} from "@/components/ui/Icon";
import { IssueTypeIcon } from "@/components/ui/Indicators";
import { CreateIssueDialog } from "@/components/create/CreateIssueDialog";
import { ThemeSwitcher } from "@/components/theme/ThemeSwitcher";
import { ISSUE_TYPES, ISSUE_TYPE_LABEL, ROLE_LABEL } from "@/lib/domain";
import type { IssueType, Role } from "@prisma/client";

export interface TopbarUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
  role: Role;
}

export interface TopbarProject {
  id: string;
  name: string;
  key: string;
}

/**
 * The shortcut label, which differs by platform: ⌘K on a Mac, Ctrl K elsewhere.
 *
 * Rendered after mount rather than during the server render, because the
 * platform is a property of the browser. Deciding on the server would print one
 * answer for everyone and then change it during hydration.
 */
function ShortcutHint() {
  const label = useSyncExternalStore(
    // The platform never changes, so there is nothing to subscribe to.
    () => () => {},
    () =>
      /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
        ? "⌘ K"
        : "Ctrl K",
    // On the server the platform is unknown; render nothing rather than guess
    // and then visibly correct it on hydration.
    () => "",
  );

  return <>{label}</>;
}

export function Topbar({
  user,
  projects,
  unreadNotifications,
  onOpenMobileNav,
}: {
  user: TopbarUser;
  projects: TopbarProject[];
  unreadNotifications: number;
  onOpenMobileNav: () => void;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createType, setCreateType] = useState<IssueType>("TASK");
  const searchInput = useRef<HTMLInputElement>(null);

  function openCreate(type: IssueType) {
    setCreateType(type);
    setCreateOpen(true);
  }

  /*
   * Ctrl+K / Cmd+K puts the caret in search from anywhere in the application.
   *
   * Bound on the document rather than on the field, because the point of the
   * shortcut is to work when the field is *not* focused. It stands down while
   * the reader is typing into some other input — a comment containing "K"
   * should not be interrupted — and Escape hands focus back to the page.
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable === true;

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        /*
         * Not while someone is writing. Inside a text field Ctrl+K already
         * means something — "kill to end of line" on macOS, "insert link" in
         * most editors — and yanking focus out of a half-written comment to
         * open search would lose their place for a shortcut they did not ask
         * for. The search field itself is exempt: pressing it there is a
         * reasonable way to re-select what is already typed.
         */
        if (typing && target !== searchInput.current) return;

        // Chrome binds Ctrl+K to its own address bar; this claims it first.
        event.preventDefault();
        searchInput.current?.focus();
        searchInput.current?.select();
        return;
      }

      if (event.key === "Escape" && !typing) return;
      if (event.key === "Escape" && target === searchInput.current) {
        searchInput.current?.blur();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  function onSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const q = query.trim();
    if (!q) return;
    router.push(`/search?q=${encodeURIComponent(q)}`);
  }

  async function handleSignOut() {
    setSigningOut(true);
    await signOut();
    router.push("/sign-in");
    router.refresh();
  }

  return (
    <header className="prio-topbar">
      <button
        type="button"
        className="prio-btn prio-btn--ghost prio-btn--icon prio-topbar__mobile-nav"
        onClick={onOpenMobileNav}
        aria-label="Open navigation"
      >
        <IconList />
      </button>

      <form
        onSubmit={onSearch}
        role="search"
        className="prio-topbar__search"
        aria-label="Search Prio"
        aria-keyshortcuts="Control+K Meta+K"
      >
        <div className="prio-search">
          <span className="prio-search__icon">
            <IconSearch />
          </span>
          <input
            ref={searchInput}
            type="search"
            className="prio-input"
            placeholder="Search issues, bugs and projects…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search issues, bugs and projects"
          />
          {/*
            * Decorative: the shortcut is announced through the field's own
            * `aria-keyshortcuts`, so repeating it here would have a screen
            * reader read "K" as part of the label.
            */}
          <kbd className="prio-search__kbd" aria-hidden>
            <ShortcutHint />
          </kbd>
        </div>
      </form>

      <div className="prio-topbar__spacer" />

      <div className="prio-topbar__actions">
        {/* Split control: the button creates a Task, the caret picks the type. */}
        <div className="prio-create">
          <button
            type="button"
            className="prio-btn prio-btn--brand prio-create__main"
            onClick={() => openCreate("TASK")}
          >
            <IconPlus />
            <span className="prio-create__label">Create</span>
          </button>

          <Menu
            align="end"
            width={230}
            label="Choose what to create"
            trigger={(props) => (
              <button
                type="button"
                className="prio-btn prio-btn--brand prio-create__caret"
                aria-label="Choose what to create"
                {...props}
              >
                <IconChevronDown size={12} />
              </button>
            )}
          >
            <MenuLabel>Create</MenuLabel>
            {ISSUE_TYPES.map((type) => (
              <MenuItem
                key={type}
                icon={<IssueTypeIcon type={type} size={18} />}
                onSelect={() => openCreate(type)}
              >
                {ISSUE_TYPE_LABEL[type]}
              </MenuItem>
            ))}
          </Menu>
        </div>

        {/* Mounted only while open so every open starts from a clean form. */}
        {createOpen ? (
          <CreateIssueDialog
            open
            onClose={() => setCreateOpen(false)}
            defaultType={createType}
          />
        ) : null}

        {projects.length > 0 ? (
          <Menu
            align="end"
            width={248}
            label="Switch project"
            trigger={(props) => (
              <button
                type="button"
                className="prio-btn prio-btn--ghost prio-topbar__project-select"
                {...props}
              >
                <IconProjects />
                <span>Projects</span>
                <IconChevronDown size={12} />
              </button>
            )}
          >
            <MenuLabel>Go to project</MenuLabel>
            {projects.map((project) => (
              <MenuItem
                key={project.id}
                href={`/projects/${project.key.toLowerCase()}`}
                icon={
                  <span className="prio-project-chip" aria-hidden>
                    {project.key.slice(0, 2)}
                  </span>
                }
                trailing={<span className="prio-key">{project.key}</span>}
              >
                {project.name}
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuItem href="/projects" icon={<IconList />}>
              All projects
            </MenuItem>
          </Menu>
        ) : null}

        <Link
          href="/notifications"
          className="prio-btn prio-btn--ghost prio-btn--icon prio-topbar__bell"
          aria-label={
            unreadNotifications > 0
              ? `Notifications, ${unreadNotifications} unread`
              : "Notifications"
          }
        >
          <IconBell />
          {unreadNotifications > 0 ? (
            <span className="prio-topbar__bell-dot" aria-hidden />
          ) : null}
        </Link>

        <Menu
          align="end"
          width={264}
          label="Help"
          trigger={(props) => (
            <button
              type="button"
              className="prio-btn prio-btn--ghost prio-btn--icon prio-topbar__help-trigger"
              aria-label="Help"
              {...props}
            >
              <IconHelp />
            </button>
          )}
        >
          <MenuLabel>Prio</MenuLabel>
          <div className="prio-topbar__help">
            <p>
              <strong>Prio</strong> — Internal Project &amp; Issue Management for
              Symbiosys Technologies.
            </p>
            <p>
              Type an issue key such as <span className="prio-key">ENG-1</span>{" "}
              into search to jump straight to it.
            </p>
          </div>
        </Menu>

        <ThemeSwitcher />

        <div className="prio-topbar__divider" aria-hidden />

        <Menu
          align="end"
          width={248}
          label="Account"
          trigger={(props) => (
            <button
              type="button"
              className="prio-btn prio-btn--ghost prio-topbar__account"
              aria-label="Account menu"
              {...props}
            >
              <Avatar name={user.name} image={user.image} size="md" />
              <IconChevronDown size={12} />
            </button>
          )}
        >
          <div className="prio-topbar__account-card">
            <Avatar name={user.name} image={user.image} size="lg" />
            <div style={{ minWidth: 0 }}>
              <p className="prio-topbar__account-name">{user.name}</p>
              <p className="prio-topbar__account-email">{user.email}</p>
              <span className="prio-badge" style={{ marginTop: 4 }}>
                {ROLE_LABEL[user.role]}
              </span>
            </div>
          </div>
          <MenuSeparator />
          <MenuItem href="/profile" icon={<IconUser />}>
            Profile &amp; settings
          </MenuItem>
          <MenuItem href="/my-work" icon={<IconList />}>
            My work
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            danger
            icon={<IconLogout />}
            onSelect={handleSignOut}
            disabled={signingOut}
          >
            {signingOut ? "Signing out…" : "Sign out"}
          </MenuItem>
        </Menu>
      </div>
    </header>
  );
}
