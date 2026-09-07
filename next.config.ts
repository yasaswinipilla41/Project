import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  reactStrictMode: true,
  serverExternalPackages: [
    "@prisma/client",
    "bullmq",
    "ioredis",
    "nodemailer",
    "exceljs",
  ],

  /**
   * A project's base path is not a page; its workspace landing view is
   * `/projects/:key/summary`.
   *
   * This lives here rather than in a route because a `redirect()` raised from a
   * Server Component can only become an HTTP redirect while the response is
   * still uncommitted — and by then the project layout above it has already
   * run its session check and its query and begun streaming. Next therefore
   * answered `/projects/eng` with 200 and a *client-side* navigation: a real
   * render of a page that exists only to leave, a visible flash of it, and a
   * URL that is briefly the old one. Anything interacting with the page in
   * that window raced the navigation.
   *
   * Matched at the routing layer, before any of that, it is an ordinary 307 —
   * no render, no flash, no race. `:key` matches exactly one segment, so
   * `/projects` and every view beneath a project (`/list`, `/board`, …) are
   * untouched, and the proxy still runs first, so an unauthenticated request
   * is still bounced to sign-in rather than redirected into the app.
   *
   * Temporary (307) rather than permanent: browsers cache a 308 indefinitely,
   * which would outlive any later decision to give the base path a page again.
   */
  async redirects() {
    return [
      {
        source: "/projects/:key",
        destination: "/projects/:key/summary",
        permanent: false,
      },
    ];
  },
};

export default nextConfig;
