# Prio landing page — backup

A complete, self-contained copy of the Prio marketing site as it stood before it
was removed from the running application on **2026-08-21**.

Nothing in this folder is imported by the application. It is inert: edit it,
move it, or delete it without affecting Prio.

## What is here

| Path | What it is |
| --- | --- |
| `src/app/(marketing)/layout.tsx` | Marketing shell: theme provider, pre-paint theme script, custom cursor |
| `src/app/(marketing)/landing/page.tsx` | The page itself, composing every section in order |
| `src/components/marketing/` | 11 components — nav, theme switcher, hero, background, product mockup, sections, showcase, closing, motion primitives, UI atoms |
| `src/styles/marketing/` | `tokens.css` (light/dark theme), `site.css` (shell, nav, hero, motion), `sections.css` (sections and mockups) |
| `src/lib/marketing-content.ts` | All copy and sample data, separate from the components |
| `tests/e2e/landing.spec.ts` | 31 Playwright tests covering theme, navigation, mockups, responsive and reduced motion |
| `src/components/PrioLogo.tsx` | Copy for reference — **the live app still uses its own at `src/components/brand/PrioLogo.tsx`** |
| `public/` | Brand assets as they were: master SVG, generated rasters, favicon, Apple touch icon, manifest |

## Restoring it

The landing page was removed by deleting files and closing one route. Putting it
back is the reverse:

```bash
# 1. Restore the source (run from the project root)
cp -r "landing page/src/app/(marketing)"      "src/app/(marketing)"
cp -r "landing page/src/components/marketing" "src/components/marketing"
cp -r "landing page/src/styles/marketing"     "src/styles/marketing"
cp    "landing page/src/lib/marketing-content.ts" src/lib/
cp    "landing page/tests/e2e/landing.spec.ts"    tests/e2e/
```

```ts
// 2. Re-open the route in src/proxy.ts — add "/landing" back to PUBLIC_PATHS:
const PUBLIC_PATHS = [
  "/landing",
  "/sign-in",
  "/invite",
  "/api/auth",
  "/api/health",
];
```

```bash
# 3. Rebuild
npm run build && docker compose up -d --build app
```

The page returns at `/landing`. Nothing else needs changing — it never touched
the application's routes, session, database or layout.

### Do not restore `PrioLogo.tsx`

The copy here is for reference only. The live application has its own at
`src/components/brand/PrioLogo.tsx`, which has moved on since. Overwriting it
would drag the app's branding backwards.

### If you want it at `/` instead of `/landing`

The application's root is the authenticated dashboard, and anonymous visitors are
redirected to sign-in. To make the landing page the public front door you would
also need to move the dashboard to its own route (e.g. `/home`) and let `/`
render the landing page for signed-out visitors. That is a routing change, not a
restore, and the E2E test asserting anonymous `/` redirects to sign-in would need
updating to match.

## Verification

`MANIFEST.txt` lists every backed-up file with its SHA-256 and byte count as
taken at backup time. To confirm the backup is intact:

```bash
cd "landing page" && sha256sum -c MANIFEST.sha256
```
