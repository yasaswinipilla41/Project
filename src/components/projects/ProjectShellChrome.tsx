"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/**
 * The project shell's own header and tab strip, and the places they are not
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
 * The Flow Board is the other. It is asked to carry none of this chrome: no
 * tab strip, no Settings, no actions dropdown, and no project summary header
 * above the board. The board brings its own controls -- favourite and its own
 * actions menu -- and its columns start at the top of the page.
 *
 * Hiding the chrome here rather than moving the routes keeps the fix to what
 * is actually wrong. The routes, the pages and their content are untouched;
 * these two simply stop being dressed as ordinary project views.
 *
 * The children are still rendered on the server and handed over — this decides
 * whether they are shown, which is the only thing that needs the path.
 */
export function ProjectShellChrome({
  projectKey,
  children,
}: {
  projectKey: string;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const base = `/projects/${projectKey.toLowerCase()}`;

  const hidden = ["settings", "board"].some(
    (view) =>
      pathname === `${base}/${view}` || pathname.startsWith(`${base}/${view}/`),
  );
  if (hidden) return null;

  return <>{children}</>;
}
