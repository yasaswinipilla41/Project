"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
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
import type { WorkRole } from "@/lib/authz";
import {
  IconBell,
  IconChevronDown,
  IconHelp,
  IconList,
  IconLogout,
  IconClose,
  IconPlus,
  IconProjects,
  IconTimeline,
  IconSearch,
  IconUser,
} from "@/components/ui/Icon";
import { IssueTypeIcon } from "@/components/ui/Indicators";
import { CreateIssueDialog } from "@/components/create/CreateIssueDialog";
import { SprintFormDialog } from "@/components/sprints/SprintFormDialog";
import { ThemeSwitcher } from "@/components/theme/ThemeSwitcher";
import {
  ISSUE_TYPES,
  ISSUE_TYPE_LABEL,
  ROLE_LABEL,
  doesQaWork,
} from "@/lib/domain";
import type { IssueType, Role } from "@prisma/client";

/** The results page. Named once so the field, the submit and the clear agree. */
const SEARCH_PATH = "/search";

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
  workRole,
  projects,
  unreadNotifications,
  onOpenMobileNav,
}: {
  /** Decides what the bar offers; `createIssue` re-checks for itself. */
  workRole: WorkRole;
  user: TopbarUser;
  projects: TopbarProject[];
  unreadNotifications: number;
  onOpenMobileNav: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  /*
   * The field mirrors the search that is actually running.
   *
   * Away from the results page there is no active search, so it shows nothing.
   * On the results page it shows the query those results came from -- which is
   * what makes clearing possible at all: the box used to start empty no matter
   * what was on screen, so there was never anything to clear, and the results
   * and the `?q=` behind them stayed put.
   */
  const activeQuery = pathname === SEARCH_PATH ? (params.get("q") ?? "") : "";
  const [query, setQuery] = useState(activeQuery);
  const [syncedQuery, setSyncedQuery] = useState(activeQuery);
  if (syncedQuery !== activeQuery) {
    /* Adjusting state during render, which React restarts immediately: the
       field never paints the stale query, and no effect is needed. The
       previous value is held in state rather than a ref because a ref read
       during render is exactly what would make this miss an update. */
    setSyncedQuery(activeQuery);
    setQuery(activeQuery);
  }

  /*
   * Creating while inside a project files into that project.
   *
   * The Issues page used to carry its own Create Issue button, which passed
   * the project the list was filtered to so a tester did not have to pick it
   * again. That button is gone, and with it the only thing that ever supplied
   * a default -- the capability stayed in `CreateIssueDialog`, simply with
   * nothing left to reach it. Reading the project from the path restores it
   * without putting a second Create control back on the page: the project
   * being looked at is context the top bar already has, since `projects`
   * carries the key-to-id mapping this needs.
   */
  const projectInPath = /^\/projects\/([^/]+)/.exec(pathname)?.[1];
  const currentProject = projectInPath
    ? projects.find((p) => p.key.toLowerCase() === projectInPath.toLowerCase())
    : undefined;

  const [signingOut, setSigningOut] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createType, setCreateType] = useState<IssueType>("TASK");
  const [sprintOpen, setSprintOpen] = useState(false);
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
    // Projects only. The Search page in the sidebar still searches
    // everything; this entry point deliberately narrows it.
    router.push(`${SEARCH_PATH}?q=${encodeURIComponent(q)}&scope=projects`);
  }

  /**
   * Clears the search, not just the box.
   *
   * Emptying the input on its own would leave the results and the `?q=` that
   * produced them exactly where they were, which is the state this used to get
   * stuck in. So when the results page is what is on screen, this also
   * navigates back to it with no parameters at all -- the query, the results
   * and the scope go together. Focus stays in the field, because clearing is
   * almost always the start of the next search rather than the end of one.
   */
  function clearSearch() {
    setQuery("");
    if (pathname === SEARCH_PATH) router.push(SEARCH_PATH);
    searchInput.current?.focus();
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
            placeholder="Search projects…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search projects"
          />
          {/*
            * A real control rather than the browser's own X, which only ever
            * empties the box: this one is the app's, so it can take the
            * results and the URL with it. The native decoration is turned off
            * in CSS so there are not two of them.
            */}
          {query ? (
            <button
              type="button"
              className="prio-search__clear"
              onClick={clearSearch}
              aria-label="Clear search"
              title="Clear search"
            >
              <IconClose size={13} />
            </button>
          ) : null}
          {/*
            * Decorative: the shortcut is announced through the field's own
            * `aria-keyshortcuts`, so repeating it here would have a screen
            * reader read "K" as part of the label.
            */}
          {query ? null : (
            <kbd className="prio-search__kbd" aria-hidden>
              <ShortcutHint />
            </kbd>
          )}
        </div>
      </form>

      <div className="prio-topbar__spacer" />

      <div className="prio-topbar__actions">
        {/*
          * Split control: the button creates a Task, the caret picks the type.
          *
          * Absent for a pure developer, who does not file work — it is raised
          * for them, and a control that always answered "you may not" would be
          * worse than no control. A full stack developer keeps it: they are on
          * Testing, and raising work is that half of their job. `createIssue` refuses the call regardless,
          * so this is the offer and not the rule.
          */}
        {doesQaWork(workRole) ? (
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

            {/*
              * Below the issue types, because a sprint is not one: it is a
              * period of work that issues go into. The dialog it opens fixes
              * the sprint to the project being looked at when there is one,
              * and otherwise asks which project it belongs to.
              */}
            {/* A sprint commits everybody's fortnight, so creating one is an
                administrator's act; `createSprint` asserts it too. */}
            {user.role === "ADMIN" ? (
              <>
                <MenuSeparator />
                <MenuItem
                  icon={<IconTimeline size={16} />}
                  onSelect={() => setSprintOpen(true)}
                >
                  Sprint
                </MenuItem>
              </>
            ) : null}
          </Menu>
        </div>
        ) : null}

        {/* Mounted only while open so every open starts from a clean form. */}
        {createOpen ? (
          <CreateIssueDialog
            open
            workRole={workRole}
            onClose={() => setCreateOpen(false)}
            defaultType={createType}
            showTypeSelector
            defaultProjectId={currentProject?.id ?? null}
          />
        ) : null}

        {sprintOpen ? (
          <SprintFormDialog
            /* Inside a project, that project; otherwise the person picks one
               from the projects they can already see. `createSprint` then
               checks they may manage whichever arrives. */
            projectId={currentProject?.id}
            projects={currentProject ? undefined : projects}
            onClose={() => setSprintOpen(false)}
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
                /* "Go to project" is the switcher -- choosing a project,
                   which is what the Welcome page introduces. */
                href={`/projects/${project.key.toLowerCase()}/welcome`}
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
          /* Icon-only controls say nothing on hover without this. `title` is
             the tooltip the rest of Prio uses — the sidebar's collapsed
             entries and the team row's count already rely on it. */
          title={
            unreadNotifications > 0
              ? `Notifications — ${unreadNotifications} unread`
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
              aria-label="About Prio"
              title="About Prio"
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
              title="Account"
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
