import Link from "next/link";

export type ProjectTab =
  | "summary"
  | "list"
  | "board"
  | "calendar"
  | "activity";

/**
 * The views of one project.
 *
 * Every destination here carries the project with it — the list and activity
 * feeds are the shared pages filtered to this project, not the global ones, so
 * following a tab from Project A never lands on Project B's work or on an
 * unscoped view of everything.
 *
 * Rendered below the page header rather than inside
 * `.prio-page-header__actions`, which is left exactly as it was.
 */
export function ProjectNav({
  projectKey,
  projectId,
  active,
}: {
  projectKey: string;
  projectId: string;
  active: ProjectTab;
}) {
  const base = `/projects/${projectKey.toLowerCase()}`;

  const tabs: { id: ProjectTab; label: string; href: string }[] = [
    { id: "summary", label: "Summary", href: base },
    { id: "list", label: "List", href: `/issues?project=${projectId}` },
    { id: "board", label: "Flow Board", href: `${base}/board` },
    { id: "calendar", label: "Calendar", href: `${base}/calendar` },
    { id: "activity", label: "Activity", href: `/activity?project=${projectId}` },
  ];

  return (
    <nav className="prio-projectnav" aria-label="Project views">
      {tabs.map((tab) => (
        <Link
          key={tab.id}
          href={tab.href}
          className="prio-projectnav__tab"
          data-active={tab.id === active || undefined}
          aria-current={tab.id === active ? "page" : undefined}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
