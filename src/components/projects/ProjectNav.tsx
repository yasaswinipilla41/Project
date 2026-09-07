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
}: {
  projectKey: string;
}) {
  const pathname = usePathname();
  const base = `/projects/${projectKey.toLowerCase()}`;

  /*
   * The Flow Board shows no tab strip.
   *
   * The strip lives in the project layout, so every view under it gets one --
   * which is what keeps there being exactly one. The board is the exception:
   * it is asked to carry no project navigation at all. Deciding that here,
   * from the path, rather than in the layout is what keeps the rule in one
   * place: the layout still renders this for every view, and this is the only
   * thing that knows which view is showing.
   *
   * Nothing is removed by returning null -- the board is still reached from
   * the strip on the other four views, and its route is unchanged.
   */
  if (pathname === `${base}/board` || pathname.startsWith(`${base}/board/`)) {
    return null;
  }

  const tabs: { id: ProjectTab; label: string; href: string }[] = [
    { id: "summary", label: "Summary", href: `${base}/summary` },
    { id: "list", label: "List", href: `${base}/list` },
    { id: "board", label: "Flow Board", href: `${base}/board` },
    { id: "sprints", label: "Sprints", href: `${base}/sprints` },
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
