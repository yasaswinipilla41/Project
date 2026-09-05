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
     * An API request is answered, not redirected.
     *
     * Bouncing `/api/...` to the sign-in page sends back 307 and then a page of
     * HTML, which is useless to every caller that asks for one of these: a
     * `fetch` sees a success status and HTML where it expected JSON, and a
     * `<video src="/api/attachments/...">` follows the redirect, is handed
     * `text/html`, and fails to load with nothing to explain why. The route
     * behind this already answers 401 for exactly this case — this makes the
     * guard in front of it say the same thing instead of contradicting it.
     *
     * Nothing is loosened: the request is still refused before it reaches the
     * route, and the route re-checks the real session regardless.
     */
    if (pathname.startsWith("/api/")) {
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
