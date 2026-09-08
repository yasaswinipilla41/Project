"use client";

import { useEffect } from "react";

/**
 * Remembers where the reader had scrolled a list to, and puts them back there.
 *
 * Opening an issue and coming back should return to the list as it was. The
 * filters, the search, the sort, the page and the page size all survive that
 * trip already because they live in the query string — the scroll position is
 * the one piece of "where I was" that does not, so it is kept here, against
 * that same URL.
 *
 * Keyed by the list's full URL, so a differently filtered or paged list has
 * its own position and never inherits another's. Session storage, so it is per
 * tab and goes away with the tab; a browser that refuses it simply gets the
 * behaviour this had before, since every access is guarded.
 *
 * **The position is taken at the moment of the click**, not on the way out.
 * Two earlier attempts got this wrong in the same way: the router scrolls the
 * window to the top *before* React unmounts anything, and it does so by
 * scrolling — so saving on unmount stored 0, and saving on every scroll event
 * stored 0 too, the reset overwriting the real position a frame before the
 * list went away. Reading it when the reader commits to leaving is the one
 * moment the number is still theirs.
 *
 * The restore is deferred by two frames for the mirror-image reason: the
 * router's scroll-to-top runs after mount, and a restore scheduled any earlier
 * is simply undone by it.
 */
export function ListScrollMemory({ url }: { url: string }) {
  useEffect(() => {
    const key = `prio.list-scroll:${url}`;

    const save = () => {
      try {
        sessionStorage.setItem(key, String(Math.round(window.scrollY)));
      } catch {
        // Storage unavailable (private window, blocked cookies).
      }
    };

    try {
      const saved = Number(sessionStorage.getItem(key));
      if (Number.isFinite(saved) && saved > 0) {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => window.scrollTo(0, saved)),
        );
      }
    } catch {
      // As above.
    }

    /*
     * Capture phase, on the document: the links are rendered by a server
     * component, so there is no handler to hang this off, and capture means
     * the position is read before anything else can act on the click.
     */
    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest('a[href^="/issues/"]')) save();
    };

    document.addEventListener("click", onClick, true);
    window.addEventListener("pagehide", save);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("pagehide", save);
    };
  }, [url]);

  return null;
}
