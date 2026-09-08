import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistic route guard.
 *
 * This only checks for the presence of a session cookie so that unauthenticated
 * visitors are bounced without a database round-trip on every request. It is
 * NOT the authorization boundary — every page and server action independently
 * resolves the real session (`requireUser` / `requireAdmin`) and enforces
 * project access server-side.
 */

const PUBLIC_PATHS = [
  "/sign-in",
  "/sign-up",
  "/invite",
  "/api/auth",
  "/api/health",
];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (isPublic(pathname)) return NextResponse.next();

  const hasSession =
    request.cookies.has("prio.session_token") ||
    request.cookies.has("__Secure-prio.session_token");

  if (!hasSession) {
    /*
     * A programmatic call is answered; a person opening a link is sent to sign
     * in. The distinction matters in both directions, and getting it wrong
     * breaks one caller or the other:
     *
     *  - A `fetch` that is redirected sees a success status and a page of HTML
     *    where it expected JSON, which is why these are answered rather than
     *    bounced.
     *  - Excel does the opposite. Clicking an attachment link in an exported
     *    sheet makes Office fetch the URL itself before handing it anywhere,
     *    with no Prio cookie to send. A 401 with no authentication scheme it
     *    recognises ends the attempt there — "Cannot download the information
     *    you requested" — and the browser, which *does* have the session, is
     *    never opened. A redirect it follows, landing the reader on sign-in
     *    and then, through `next`, on the file they asked for.
     *
     * So only requests that are recognisably programmatic get JSON. Anything
     * else — a browser navigation, Office, a pasted URL — is treated as a
     * person and redirected. `Sec-Fetch-Mode` is what modern browsers say about
     * their own requests; the `Accept` and `X-Requested-With` arms cover the
     * callers that do not send it.
     *
     * Nothing is loosened either way: the request is refused before it reaches
     * the route, and the route re-resolves the real session regardless.
     */
    const accept = request.headers.get("accept") ?? "";
    const fetchMode = request.headers.get("sec-fetch-mode");
    const isProgrammatic =
      fetchMode === "cors" ||
      fetchMode === "same-origin" ||
      request.headers.get("x-requested-with") === "XMLHttpRequest" ||
      (accept.includes("application/json") && !accept.includes("text/html"));

    if (pathname.startsWith("/api/") && isProgrammatic) {
      return NextResponse.json({ error: "Not signed in." }, { status: 401 });
    }

    const url = request.nextUrl.clone();
    url.pathname = "/sign-in";
    url.search = `?next=${encodeURIComponent(`${pathname}${search}`)}`;
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Everything except Next internals and static brand assets.
     */
    "/((?!_next/static|_next/image|favicon.ico|apple-touch-icon.png|manifest.webmanifest|brand/).*)",
  ],
};
