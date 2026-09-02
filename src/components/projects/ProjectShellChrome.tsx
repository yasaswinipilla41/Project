"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/**
 * The project shell's own header and tab strip, and the one place they are
 * not wanted.
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
 * Hiding the chrome here rather than moving the route keeps the fix to what is
 * actually wrong. The route, the page and its content are untouched; settings
 * simply stops being dressed as another project view.
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

  if (pathname === `${base}/settings` || pathname.startsWith(`${base}/settings/`)) {
    return null;
  }

  return <>{children}</>;
}
