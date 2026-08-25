import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

/**
 * Rasterises the Prio brand assets from the master SVG.
 *
 *   npx tsx scripts/generate-brand-assets.ts
 *
 * Everything here is derived, never hand-drawn: replace
 * `public/brand/prio-mark.svg` with the official master and re-run to
 * regenerate every PNG, the Apple touch icon and favicon.ico. That keeps a
 * single source of truth and stops the raster copies drifting from the vector.
 */

const ROOT = process.cwd();
const BRAND = path.join(ROOT, "public", "brand");
const PUBLIC = path.join(ROOT, "public");

/** Ground for icons that may not be composited on a background by the OS. */
const ICON_BG = "#131c2b";

interface RasterTarget {
  file: string;
  size: number;
  /** Solid background, or null for transparency. */
  background: string | null;
  /** Fraction of the canvas the mark occupies (iOS expects padding). */
  inset: number;
  radius: number;
}

const TARGETS: RasterTarget[] = [
  // Maskable / PWA icons: opaque, with the safe-area padding installers expect.
  { file: "icon-192.png", size: 192, background: ICON_BG, inset: 0.18, radius: 0 },
  { file: "icon-512.png", size: 512, background: ICON_BG, inset: 0.18, radius: 0 },
  // iOS applies its own mask, so ship it square and opaque.
  {
    file: "apple-touch-icon.png",
    size: 180,
    background: ICON_BG,
    inset: 0.16,
    radius: 0,
  },
  // Transparent PNGs for email clients and anywhere SVG is rejected.
  { file: "prio-mark-32.png", size: 32, background: null, inset: 0, radius: 0 },
  { file: "prio-mark-64.png", size: 64, background: null, inset: 0, radius: 0 },
  { file: "prio-mark-192.png", size: 192, background: null, inset: 0, radius: 0 },
  { file: "prio-mark-512.png", size: 512, background: null, inset: 0, radius: 0 },
];

/** Sizes packed into favicon.ico for browsers that ignore favicon.svg. */
const ICO_SIZES = [16, 32, 48];

async function rasterise(
  svg: string,
  size: number,
  background: string | null,
  inset: number,
): Promise<Buffer> {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });

    const pad = Math.round(size * inset);
    await page.setContent(
      `<!doctype html><html><body style="margin:0;width:${size}px;height:${size}px;
         background:${background ?? "transparent"};display:flex;
         align-items:center;justify-content:center">
         <div style="width:${size - pad * 2}px;height:${size - pad * 2}px">${svg}</div>
       </body></html>`,
    );

    return await page.screenshot({
      omitBackground: background === null,
      type: "png",
    });
  } finally {
    await browser.close();
  }
}

/**
 * Builds a real multi-resolution .ico containing PNG payloads.
 *
 * The ICO container is a 6-byte header, one 16-byte directory entry per image,
 * then the image data. PNG-in-ICO is understood by every browser Prio targets,
 * and avoids shipping a BMP encoder just for a favicon.
 */
function buildIco(images: { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const entries: Buffer[] = [];
  let offset = 6 + images.length * 16;

  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    // 256px is encoded as 0 in this field; Prio never ships that size.
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // width
    entry.writeUInt8(size >= 256 ? 0 : size, 1); // height
    entry.writeUInt8(0, 2); // palette colours
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += png.length;
  }

  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

async function main() {
  const svg = await fs.readFile(path.join(BRAND, "prio-mark.svg"), "utf8");

  if (svg.includes("data:image/")) {
    console.warn(
      "! prio-mark.svg embeds a raster image. Rasters do not scale; replace it\n" +
        "  with true vector geometry before shipping.",
    );
  }

  console.log("Generating brand rasters from public/brand/prio-mark.svg\n");

  for (const target of TARGETS) {
    const png = await rasterise(svg, target.size, target.background, target.inset);
    const destination =
      target.file === "apple-touch-icon.png"
        ? path.join(PUBLIC, target.file)
        : path.join(BRAND, target.file);
    await fs.writeFile(destination, png);
    console.log(
      `  ${path.relative(ROOT, destination).padEnd(38)} ${target.size}px  ${
        (png.length / 1024).toFixed(1)
      } kB`,
    );
  }

  const icoImages = [];
  for (const size of ICO_SIZES) {
    icoImages.push({ size, png: await rasterise(svg, size, null, 0) });
  }
  const ico = buildIco(icoImages);
  await fs.writeFile(path.join(PUBLIC, "favicon.ico"), ico);
  console.log(
    `  ${"public/favicon.ico".padEnd(38)} ${ICO_SIZES.join("/")}px  ${
      (ico.length / 1024).toFixed(1)
    } kB`,
  );

  console.log("\nDone.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
