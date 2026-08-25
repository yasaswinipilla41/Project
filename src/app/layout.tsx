import type { Metadata, Viewport } from "next";
import { THEME_SCRIPT } from "@/components/theme/theme";
import "./globals.css";

/**
 * Icons are declared explicitly rather than relying on file-convention
 * discovery, so the whole set — SVG, .ico fallback, Apple touch icon and the
 * manifest — is visible in one place and stays in step with
 * `scripts/generate-brand-assets.ts`.
 */
export const metadata: Metadata = {
  metadataBase: new URL(process.env.BASE_URL ?? "http://localhost:3000"),
  title: {
    default: "Prio",
    template: "%s · Prio",
  },
  description:
    "Prio — internal project and issue management for Symbiosys Technologies. Track, prioritize, deliver.",
  applicationName: "Prio",
  icons: {
    icon: [
      // Modern browsers prefer the vector; the .ico covers the rest.
      { url: "/brand/prio-mark.svg", type: "image/svg+xml" },
      { url: "/favicon.ico", sizes: "16x16 32x32 48x48" },
      { url: "/brand/prio-mark-192.png", type: "image/png", sizes: "192x192" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
    shortcut: [{ url: "/favicon.ico" }],
  },
  manifest: "/manifest.webmanifest",
  // Internal tool: never index it.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  /*
   * Mobile browser chrome follows the OS scheme rather than being forced dark:
   * the app surface is light, so a light UI bar blends with it, while a dark
   * scheme matches Prio's dark navigation chrome.
   */
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#FFFFFF" },
    { media: "(prefers-color-scheme: dark)", color: "#131C2B" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/*
         * Applies the stored theme before the first paint. It has to run here,
         * ahead of hydration: if React applied the attribute, everyone using
         * dark mode would see a white flash on every full document load.
         *
         * The script is a constant built at module scope from a fixed string —
         * no request data reaches it — so there is nothing here to inject.
         * `suppressHydrationWarning` on <html> is required because this script
         * legitimately changes the element before React sees it.
         */}
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
