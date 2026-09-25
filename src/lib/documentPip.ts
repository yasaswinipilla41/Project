/**
 * A small always-on-top window the page can put its own controls in.
 *
 * Document Picture-in-Picture is Chrome's (116+) way for a page to open a
 * floating window that stays above every tab and every other window, and that
 * the page renders into like any other document. It is what lets a recording
 * be paused or stopped from whatever tab is being demonstrated, without going
 * back to Prio for it.
 *
 * It is not a way into other sites: the window is Prio's own document, opened
 * by Prio, and nothing is added to the tab being recorded. Where it sits and
 * that it stays on top are the browser's decisions, not the page's.
 *
 * Everything here is optional. A browser without the API, or one that refuses
 * the window — it needs a recent click on the page, and allows one at a time —
 * gets `null`, and the caller keeps its controls on the page as before.
 */

interface DocumentPictureInPicture {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
  readonly window: Window | null;
}

function api(): DocumentPictureInPicture | null {
  if (typeof window === "undefined") return null;
  return (
    (window as { documentPictureInPicture?: DocumentPictureInPicture })
      .documentPictureInPicture ?? null
  );
}

/** Can this browser open a floating window of the page's own at all? */
export function canFloatWindow(): boolean {
  return api() !== null;
}

/**
 * Opens a floating window styled like the page, or `null` if it cannot.
 *
 * The new document starts empty, so the page's stylesheets are carried over —
 * copied rule by rule where they can be read, linked by address where they
 * cannot — along with the theme attribute the colour tokens hang off. Without
 * them the controls would arrive unstyled, which would be a different control
 * rather than the same one somewhere else.
 */
export async function openFloatingWindow(size: {
  width: number;
  height: number;
}): Promise<Window | null> {
  const pip = api();
  /* One at a time: another floating window is already open (Prio's own or
     otherwise), and asking again would close it. */
  if (!pip || pip.window) return null;

  let floating: Window;
  try {
    floating = await pip.requestWindow(size);
  } catch {
    /* Usually no recent click to open it on. Not a fault: the controls stay
       on the page. */
    return null;
  }

  const target = floating.document;
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const style = target.createElement("style");
      style.textContent = Array.from(sheet.cssRules)
        .map((rule) => rule.cssText)
        .join("\n");
      target.head.appendChild(style);
    } catch {
      /* A stylesheet from another origin cannot be read, only linked. */
      if (!sheet.href) continue;
      const link = target.createElement("link");
      link.rel = "stylesheet";
      link.href = sheet.href;
      target.head.appendChild(link);
    }
  }

  const theme = document.documentElement.getAttribute("data-theme");
  if (theme) target.documentElement.setAttribute("data-theme", theme);
  target.documentElement.lang = document.documentElement.lang;
  target.title = document.title;
  target.body.style.margin = "0";

  return floating;
}
