# Prio brand assets

`prio-mark.svg` is the **single source of truth**. Every other file in this
folder — and `public/favicon.ico`, `public/apple-touch-icon.png` — is generated
from it:

```bash
npx tsx scripts/generate-brand-assets.ts
```

Replace the master and re-run, and the whole set follows. Nothing is hand-drawn
twice, so the rasters cannot drift from the vector.

## Files

| File                     | Generated | Purpose                                             |
| ------------------------ | --------- | --------------------------------------------------- |
| `prio-mark.svg`          | **no**    | Master vector. Sidebar, sign-in, splash, favicon.    |
| `prio-mark-32/64.png`    | yes       | Small transparent rasters (email, legacy clients).   |
| `prio-mark-192/512.png`  | yes       | Large transparent rasters, `purpose: any` manifest.  |
| `icon-192/512.png`       | yes       | Opaque, padded. `purpose: maskable` manifest icons.  |
| `../apple-touch-icon.png`| yes       | 180×180 opaque. iOS applies its own mask.            |
| `../favicon.ico`         | yes       | 16/32/48 multi-resolution, PNG payloads.             |

## Light and dark

The mark is **one asset for both grounds**. It carries its own blue→purple
gradient on a transparent field and has no white keyline or background plate, so
it sits correctly on the light content area and on the dark chrome without a
second file and without CSS filters.

Only the *wordmark* changes per surface, and it is live text, not an image:
`PrioLogo` switches `--prio-logo-text` / `--prio-logo-text-on-dark` via its
`tone` prop. The purple dot on the i keeps the brand purple on both.

Opaque icons (`icon-*.png`, `apple-touch-icon.png`) are deliberately **not**
transparent: installers and iOS composite them onto an unknown background, so
they ship on the brand's dark ground.

## Rules

- Do not recreate, recolour, rotate, stretch or add effects to the mark.
- Do not introduce a second logo implementation — everything renders through
  [`PrioLogo`](../../src/components/brand/PrioLogo.tsx).
- Keep clear space around the mark equal to 25 % of its height.
- The tagline **Track · Prioritize · Deliver** belongs only where the brand
  sheet shows it. It is not chrome.

## Current state

`prio-mark.svg` is **hand-traced from the supplied reference images** as true
vector geometry — the reference arrived as raster PNGs and as an SVG that
wrapped an embedded base64 PNG, neither of which is scalable.

If a vector master exists (`.ai`, `.svg` with real paths, Figma export), drop it
in as `prio-mark.svg` and re-run the generator; it is a drop-in replacement and
no code changes are needed.
