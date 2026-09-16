/**
 * What this page offers as navigation, read from the page itself.
 *
 * The Snip Tool used to carry a hard-coded list of Prio's five main pages. It
 * was wrong in both directions the moment anything moved: a page added to the
 * sidebar never appeared, a page removed from it still did, and a project's own
 * tab strip — Summary, Board, Timeline — was invisible because nobody had typed
 * it in here. A list of somewhere else's routes, kept by hand, is a list that is
 * out of date.
 *
 * So nothing is listed. The page is asked what it has, through the markup that
 * already says so:
 *
 *   - `<nav>` and `role="navigation"` — the landmark whose whole job is to
 *     announce "this is navigation", which is exactly the question;
 *   - `role="tablist"` and `role="menubar"` — navigation that is a strip of
 *     tabs or a bar of menus rather than a list of links;
 *   - `aria-label` / `aria-labelledby` on those landmarks, which is what names
 *     them for a screen reader and therefore names them here.
 *
 * Deliberately *not* a CSS class. `.prio-sidebar` would work today and break on
 * the day somebody renames it, and it would find nothing at all in a page that
 * was built differently — the detection would be Prio-specific in the one place
 * that is supposed to stop being Prio-specific. Landmarks and ARIA roles are a
 * contract with assistive technology that already exists, is already correct
 * here, and is already maintained for its own reasons.
 *
 * Equally deliberately not *every* link. An issue's key in a table is a link,
 * and a hundred of them are not a hundred modules. Only links inside a
 * navigation landmark count, which is the difference between navigation and
 * content, and it is a distinction the markup already draws.
 *
 * Nothing here navigates, reads across origins, or touches another tab. It
 * inspects the document it is running in and returns a description of it.
 */

export interface NavItem {
  /** Where it goes, as an in-app path. */
  href: string;
  label: string;
  /** Sub-navigation beneath it, nested by route. */
  children: NavItem[];
}

export type NavKind = "sidebar" | "header" | "tabs" | "other";

export interface NavGroup {
  /** Stable within one scan, for React keys. */
  id: string;
  /** What the landmark calls itself, or what it evidently is. */
  label: string;
  kind: NavKind;
  items: NavItem[];
}

/**
 * The landmarks worth reading. Each of these is a claim the page makes about
 * itself rather than a guess this module makes about the page.
 */
const LANDMARKS = 'nav, [role="navigation"], [role="tablist"], [role="menubar"]';

/** Longer than this is a sentence, not a navigation label. */
const MAX_LABEL = 40;

/**
 * Marks a subtree as the Snip Tool's own.
 *
 * The window floats over the page and contains links of its own — "Open
 * ENG-4", for one — and offering the person the Snip Tool as a place to
 * navigate to would be both useless and a small infinite regress.
 */
export const SNIP_TOOL_MARKER = "data-prio-snip-tool";

/** Is this element actually rendered? Cheap, and covers display and hidden. */
function isVisible(element: Element): boolean {
  if (element.closest(`[${SNIP_TOOL_MARKER}]`)) return false;
  if (element.closest('[hidden], [aria-hidden="true"]')) return false;
  return element.getClientRects().length > 0;
}

/**
 * The in-app path a link leads to, or null when it is not somewhere this tab
 * can simply go.
 *
 * Another origin is somebody else's site; a `_blank` target is another tab,
 * which is what the browser's own picker is for; an anchor stays on this page;
 * and `/api/...` is not a page at all. The query string is dropped on purpose —
 * `/issues?status=DONE` and `/issues` are one module with a filter on it, and
 * keeping both would list the same place twice.
 */
function inAppPath(link: HTMLAnchorElement): string | null {
  const raw = link.getAttribute("href");
  if (!raw || raw.startsWith("#") || raw.startsWith("mailto:")) return null;
  if (link.target && link.target !== "_self") return null;

  let url: URL;
  try {
    url = new URL(link.href, window.location.origin);
  } catch {
    return null;
  }

  if (url.origin !== window.location.origin) return null;
  if (url.pathname.startsWith("/api/")) return null;
  return url.pathname;
}

/**
 * The text a link actually shows, with its parts kept apart.
 *
 * `textContent` runs the children together — a sidebar entry with a count
 * badge comes back as "Notifications3", and a project row as "WEWebsite" — so
 * each direct child is trimmed and joined with a space instead.
 *
 * Deliberately not `innerText`, which reflects layout. A collapsed sidebar
 * hides its labels in CSS, and reading it that way would leave every entry
 * nameless exactly when the icons have made the names most necessary.
 */
function visibleText(element: Element): string {
  const parts: string[] = [];
  for (const child of element.childNodes) {
    const text = renderedText(child);
    if (text) parts.push(text);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Text that is actually drawn, skipping two things that are not.
 *
 * An `<svg>` carries a `<title>` for assistive technology, and `textContent`
 * returns it happily — a logo whose wordmark is *also* drawn as live text then
 * comes back as "PrioPrio". And an element marked `aria-hidden` is decoration
 * by its own admission: the two-letter chip on a project row is not part of
 * that project's name.
 */
function renderedText(node: ChildNode): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent?.replace(/\s+/g, " ").trim() ?? "";
  }
  if (!(node instanceof Element)) return "";
  if (node.tagName.toLowerCase() === "svg") return "";
  if (node.getAttribute("aria-hidden") === "true") return "";

  let out = "";
  for (const child of node.childNodes) {
    const text = renderedText(child);
    if (text) out += out ? ` ${text}` : text;
  }
  return out;
}

/**
 * How many links share this one's parent.
 *
 * Used only to choose between two names for the same destination, never to
 * decide what is offered. Navigation entries come in groups — a list of peers —
 * while a logo linking home sits on its own, and both point at `/`. Preferring
 * the one among peers is what makes that destination read as "Home" rather than
 * as the product's name.
 */
function peerLinks(link: HTMLAnchorElement): number {
  const parent = link.parentElement;
  if (!parent) return 1;
  return parent.querySelectorAll(":scope > a[href]").length;
}

/** What is known about one link's suitability as a name for its destination. */
interface Named {
  label: string;
  /** The name came from what the link says, not from an `aria-label`. */
  fromText: boolean;
  peers: number;
}

/** Is `next` a better name for a destination than the one already stored? */
function isBetterName(next: Named, current: Named): boolean {
  if (next.fromText !== current.fromText) return next.fromText;
  return next.peers > current.peers;
}

/**
 * What to call a link, and whether that name came from what it says.
 *
 * Its own text first, falling back to `aria-label` for a link that shows only
 * an icon. That order is the opposite of the accessible-name calculation, and
 * on purpose: the question here is what to put on a list of destinations, and
 * two links routinely lead to the same one. A logo and a "Home" entry both
 * point at `/`, and "Home" is the better name for it — `fromText` is what lets
 * the caller prefer it.
 */
function nameOfLink(link: HTMLAnchorElement): Named | null {
  const text = visibleText(link);
  const aria = link.getAttribute("aria-label")?.trim();
  const title = link.getAttribute("title")?.trim();

  /* One character is a monogram or a chevron, not a name. */
  const fromText = text.length >= 2;
  const label = fromText ? text : aria || title || text;
  if (!label) return null;

  return {
    label:
      label.length > MAX_LABEL ? `${label.slice(0, MAX_LABEL - 1)}…` : label,
    fromText,
    peers: peerLinks(link),
  };
}

/**
 * What kind of navigation this landmark is.
 *
 * The role answers it outright where there is one. Otherwise it is settled by
 * shape and position, which is a description of what the person is looking at
 * rather than a guess about how it was built — a tall strip down one side is a
 * sidebar whatever it is called, and a wide strip across the top is a header.
 * Used only to caption the group; the items themselves come from the markup.
 */
function kindOf(element: HTMLElement): NavKind {
  const role = element.getAttribute("role");
  if (role === "tablist" || role === "menubar") return "tabs";

  const box = element.getBoundingClientRect();
  if (box.width === 0 || box.height === 0) return "other";

  const tall = box.height > box.width;
  if (tall) {
    const nearLeft = box.left <= window.innerWidth * 0.25;
    const nearRight = box.right >= window.innerWidth * 0.75;
    if (nearLeft || nearRight) return "sidebar";
  } else if (box.top <= window.innerHeight * 0.3) {
    return "header";
  }
  return "other";
}

const KIND_LABEL: Record<NavKind, string> = {
  sidebar: "Sidebar",
  header: "Header",
  tabs: "Tabs",
  other: "Navigation",
};

/** What the landmark calls itself, or what it evidently is. */
function labelOfLandmark(element: HTMLElement, kind: NavKind): string {
  const aria = element.getAttribute("aria-label")?.trim();
  if (aria) return aria;

  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
      .filter(Boolean)
      .join(" ");
    if (text) return text.slice(0, MAX_LABEL);
  }

  return KIND_LABEL[kind];
}

/**
 * Nests items by route, so a tab strip under a section reads as being under it.
 *
 * `/projects` is the parent of `/projects/eng/board` because the path says so —
 * no configuration, and it works for routes this module has never heard of.
 * `/` is excluded from ever being a parent: it prefixes everything and explains
 * nothing, so Home would otherwise swallow the entire list.
 */
function nestByPath(items: NavItem[]): NavItem[] {
  const shortestFirst = [...items].sort((a, b) => a.href.length - b.href.length);
  const roots: NavItem[] = [];

  const findParent = (candidates: NavItem[], href: string): NavItem | null => {
    for (const candidate of candidates) {
      if (candidate.href !== "/" && href.startsWith(`${candidate.href}/`)) {
        return findParent(candidate.children, href) ?? candidate;
      }
    }
    return null;
  };

  for (const item of shortestFirst) {
    const parent = findParent(roots, item.href);
    if (parent) parent.children.push(item);
    else roots.push(item);
  }
  return roots;
}

/**
 * Every navigation landmark on the page, and what each one leads to.
 *
 * A landmark inside another landmark is collected as part of its parent rather
 * than as a group of its own, so a tab strip nested in the main navigation does
 * not appear twice. Paths are deduplicated across the whole scan for the same
 * reason: the sidebar and the header often lead to the same places, and one
 * module listed twice is a worse answer than one listed once.
 */
export function detectNavigation(): NavGroup[] {
  if (typeof document === "undefined") return [];

  const landmarks = Array.from(
    document.querySelectorAll<HTMLElement>(LANDMARKS),
  ).filter(isVisible);

  const outermost = landmarks.filter(
    (landmark) =>
      !landmarks.some(
        (other) => other !== landmark && other.contains(landmark),
      ),
  );

  /* Kept across landmarks, because a sidebar and a breadcrumb often lead to the
     same place and one destination listed twice is a worse answer than one
     listed once. The entry is held rather than only the path, so a later link
     with a better name can improve it. */
  const seen = new Map<string, { item: NavItem; named: Named }>();
  const groups: NavGroup[] = [];

  for (const [index, landmark] of outermost.entries()) {
    const items: NavItem[] = [];

    for (const link of landmark.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      if (!isVisible(link)) continue;

      const href = inAppPath(link);
      if (!href) continue;

      const named = nameOfLink(link);
      if (!named) continue;

      const existing = seen.get(href);
      if (existing) {
        /* The same destination, named better this time: the logo claimed "/"
           before the Home entry was reached. The item is shared by reference,
           so the group already holding it improves with it. */
        if (isBetterName(named, existing.named)) {
          existing.item.label = named.label;
          existing.named = named;
        }
        continue;
      }

      const item: NavItem = { href, label: named.label, children: [] };
      seen.set(href, { item, named });
      items.push(item);
    }

    if (items.length === 0) continue;

    const kind = kindOf(landmark);
    groups.push({
      id: `${kind}-${index}`,
      label: labelOfLandmark(landmark, kind),
      kind,
      items: nestByPath(items),
    });
  }

  return groups;
}

/**
 * A comparable summary of a scan.
 *
 * The detection re-runs whenever the page changes, and the page changes
 * whenever anything renders — including this. Storing a fresh array every time
 * would re-render the window, mutate the DOM, trigger the observer and start
 * again: a slow loop rather than a fast one, but a loop. Comparing this and
 * keeping the previous value when nothing has moved is what settles it, because
 * an unchanged reference is a render React skips.
 */
export function navigationSignature(groups: NavGroup[]): string {
  return JSON.stringify(groups);
}
