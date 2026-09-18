"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export type ProjectTab =
  | "summary"
  | "list"
  | "board"
  | "sprints"
  | "calendar"
  | "timeline"
  | "activity";

/**
 * The views of one project.
 *
 * Rendered once, by the project layout, so every view shares the same strip
 * rather than each page drawing its own. That is what makes moving between
 * them a change of content rather than a change of page: the layout is not
 * re-rendered on a soft navigation, so the header and this strip stay put and
 * only what sits below them is replaced.
 *
 * Every destination is a route under the project, including List and Activity.
 * They used to point at `/issues?project=` and `/activity?project=` — the
 * global pages with a filter applied — which meant following a tab left the
 * project shell entirely and landed on a page with a different header and no
 * way back to the project's other views.
 *
 * The active tab comes from the current path rather than a prop, because the
 * layout that renders this cannot know which of its children is showing.
 */
export function ProjectNav({
  projectKey,
  showSprints = true,
}: {
  projectKey: string;
  /**
   * Whether this reader gets the Sprints tab.
   *
   * Resolved on the server by the project layout and passed down, because a
   * client component cannot ask who is signed in. Defaults to true: every
   * working role — Admin, Developer, Tester and Full Stack Developer — reads
   * and plans sprints, so there is currently nobody this is withheld from.
   *
   * Showing it decides nothing about access. Every write in `sprints.ts`
   * asserts its own rule independently, whatever this prop says.
   */
  showSprints?: boolean;
}) {
  const pathname = usePathname();
  const base = `/projects/${projectKey.toLowerCase()}`;

  /*
   * The board shows the strip like every other view.
   *
   * It used to be the exception and returned null here, which left the one
   * project view with no way on to Summary, List, Sprints, Calendar, Timeline
   * or Activity — the board's URL never left the project, but the workspace
   * around it did. Where the strip is drawn is the layout's business and the
   * board is no longer special to it; what the board still withholds is the
   * shell's *header*, because it draws its own. See `ProjectShellChrome`.
   */

  const tabs: { id: ProjectTab; label: string; href: string }[] = [
    { id: "summary", label: "Summary", href: `${base}/summary` },
    { id: "list", label: "List", href: `${base}/list` },
    { id: "board", label: "Flow Board", href: `${base}/board` },
    ...(showSprints
      ? [{ id: "sprints" as const, label: "Sprints", href: `${base}/sprints` }]
      : []),
    { id: "calendar", label: "Calendar", href: `${base}/calendar` },
    { id: "timeline", label: "Timeline", href: `${base}/timeline` },
    { id: "activity", label: "Activity", href: `${base}/activity` },
  ];

  /*
   * The longest matching href wins.
   *
   * Summary is a named route of its own now -- `/summary` rather than the
   * project's base path -- so no tab's href is a prefix of another's and the
   * rule has nothing left to disambiguate. It is kept because it is what makes
   * that true rather than incidental: a view added later under an existing one
   * still picks the deeper tab.
   */
  const active = tabs.reduce<ProjectTab | null>((best, tab) => {
    const matches = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
    if (!matches) return best;
    const bestHref = tabs.find((t) => t.id === best)?.href ?? "";
    return tab.href.length >= bestHref.length ? tab.id : best;
  }, null);

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
