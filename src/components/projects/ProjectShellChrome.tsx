"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/**
 * The project shell's own header and tab strip, and the places each is not
 * wanted.
 *
 * Project settings is a page in its own right: it brings its own breadcrumb
 * ("Projects / <name> / Settings"), its own title and its own subtitle, and it
 * did so long before the shell existed. Once the shell began wrapping every
 * route under the project, settings inherited a second header above its own
 * and a tab strip that marked **Summary** as the current view — because
 * Summary's href is the project's base path, which is a prefix of every route
 * beneath it, `/settings` included. Opening settings therefore looked like
 * landing back on Summary with a settings form attached to it.
 *
 * The Welcome page is the second, and for the opposite reason to settings: it
 * is not a view of the project but the doorway to it. Its whole job is to say
 * which project has just been chosen and offer one step onward, and a tab
 * strip above it would offer five ways past that step -- and a second project
 * header would say the project's name twice, immediately above a card whose
 * first line is the project's name.
 *
 * **The Flow Board is neither, and this is why the parts are asked separately.**
 *
 * The board draws its own header — a way back to the project, the board's name,
 * and the board's own controls including favouriting — so the shell's header
 * above it would be a second header with a second actions menu. That much of
 * the original decision was right and stands.
 *
 * What did not follow is the tab strip. Hiding it too made the board the one
 * project view you could not leave by the same route you arrived on: Summary,
 * List, Sprints, Calendar, Timeline and Activity were all suddenly gone, and
 * the board stopped reading as part of the project workspace at all even
 * though its URL never left it. The strip is therefore shown on the board like
 * every other view, with Flow Board as the current tab, and only the header is
 * withheld.
 *
 * The children are still rendered on the server and handed over — this decides
 * whether they are shown, which is the only thing that needs the path.
 */
export function ProjectShellChrome({
  projectKey,
  /**
   * Which piece of the shell this is wrapping.
   *
   * Asked per part rather than for the chrome as a whole because the board
   * wants one and not the other, and a single answer cannot say that.
   */
  part,
  children,
}: {
  projectKey: string;
  part: "header" | "nav";
  children: ReactNode;
}) {
  const pathname = usePathname();
  const base = `/projects/${projectKey.toLowerCase()}`;

  const on = (view: string) =>
    pathname === `${base}/${view}` || pathname.startsWith(`${base}/${view}/`);

  /* Settings and Welcome bring their own everything. */
  if (on("settings") || on("welcome")) return null;

  /* The board brings its own header, and wants the strip. */
  if (part === "header" && on("board")) return null;

  return <>{children}</>;
}
