import Image from "next/image";

/**
 * The single place the Prio brand enters the application.
 *
 * The mark is an SVG in `/public/brand/`, never drawn inline, so replacing that
 * one file restyles the sidebar, sign-in, splash, error pages and every icon at
 * once. The wordmark is set as live text rather than a second image: it stays
 * crisp at any size, inherits the surface's colour token, is selectable, and is
 * read once by assistive technology instead of twice.
 *
 * See `public/brand/README.md` for the asset contract.
 */

export type PrioLogoVariant = "lockup" | "mark" | "wordmark";
export type PrioLogoTone = "light" | "dark";

/**
 * `full` and `horizontal` are accepted as aliases of `lockup` so existing call
 * sites and the brand guidelines can use whichever word they prefer.
 */
export type PrioLogoVariantInput = PrioLogoVariant | "full" | "horizontal";

const MARK_SIZES = {
  xs: 18,
  sm: 22,
  md: 28,
  lg: 40,
  xl: 56,
} as const;

export type PrioLogoSize = keyof typeof MARK_SIZES;

const WORDMARK_SIZE: Record<PrioLogoSize, string> = {
  xs: "var(--prio-text-base)",
  sm: "var(--prio-text-md)",
  md: "var(--prio-text-lg)",
  lg: "var(--prio-text-2xl)",
  xl: "var(--prio-text-3xl)",
};

export interface PrioLogoProps {
  /** `lockup` (alias `full`/`horizontal`) renders mark + wordmark. */
  variant?: PrioLogoVariantInput;
  size?: PrioLogoSize;
  /** `dark` = placed on dark chrome (sidebar, splash, sign-in brand panel). */
  tone?: PrioLogoTone;
  /** Rendered under the wordmark. Use only where the brand sheet shows it. */
  tagline?: string;
  className?: string;
  /**
   * Set when an adjacent element already names the product, so screen readers
   * do not announce "Prio" twice.
   */
  decorative?: boolean;
}

function normalise(variant: PrioLogoVariantInput): PrioLogoVariant {
  if (variant === "full" || variant === "horizontal") return "lockup";
  return variant;
}

/**
 * "Prio" with the purple dot on the i, as in the brand sheet.
 *
 * The dot is a styled element rather than a glyph so it keeps the exact brand
 * purple regardless of the rendering font, and scales with the type.
 */
function Wordmark({
  size,
  tone,
}: {
  size: PrioLogoSize;
  tone: PrioLogoTone;
}) {
  return (
    <span
      className="prio-wordmark"
      data-tone={tone}
      style={{ fontSize: WORDMARK_SIZE[size] }}
      aria-hidden
    >
      Pr
      <span className="prio-wordmark__i">
        <span className="prio-wordmark__dot" />
        <span className="prio-wordmark__stem">i</span>
      </span>
      o
    </span>
  );
}

export function PrioLogo({
  variant = "lockup",
  size = "sm",
  tone = "light",
  tagline,
  className,
  decorative = false,
}: PrioLogoProps) {
  const resolved = normalise(variant);
  const px = MARK_SIZES[size];

  const mark = (
    <Image
      src="/brand/prio-mark.svg"
      // The wordmark beside it already carries the name; an alt here would
      // make assistive technology announce the product twice.
      alt={decorative || resolved === "lockup" ? "" : "Prio"}
      width={px}
      height={px}
      priority
      className="prio-logo__mark"
      style={{ width: px, height: px }}
    />
  );

  if (resolved === "mark") {
    return (
      <span className={`prio-logo${className ? ` ${className}` : ""}`}>
        {mark}
        {decorative ? null : <span className="prio-visually-hidden">Prio</span>}
      </span>
    );
  }

  if (resolved === "wordmark") {
    return (
      <span className={`prio-logo${className ? ` ${className}` : ""}`}>
        <Wordmark size={size} tone={tone} />
        <span className="prio-visually-hidden">Prio</span>
      </span>
    );
  }

  return (
    <span className={`prio-logo prio-logo--lockup${className ? ` ${className}` : ""}`}>
      {mark}
      <span className="prio-logo__text">
        <Wordmark size={size} tone={tone} />
        {tagline ? (
          <span className="prio-logo__tagline" data-tone={tone} aria-hidden>
            {tagline}
          </span>
        ) : null}
      </span>
      {/* One accessible name for the whole lockup. */}
      <span className="prio-visually-hidden">
        {tagline ? `Prio — ${tagline}` : "Prio"}
      </span>
    </span>
  );
}

/** Product descriptor used beside the logo on auth and splash surfaces. */
export const PRIO_TAGLINE = "Internal Project & Issue Management";

/** The brand-sheet tagline. Use only where the brand sheet shows it. */
export const PRIO_BRAND_TAGLINE = "Track · Prioritize · Deliver";
