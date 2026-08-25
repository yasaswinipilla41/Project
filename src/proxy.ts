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
