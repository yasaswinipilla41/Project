import Link from "next/link";
import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  CSSProperties,
  ReactNode,
} from "react";
import { initials } from "@/lib/format";

/**
 * Prio's base primitives. Presentation lives in `src/styles/components.css`;
 * these components exist so that variants stay a typed choice rather than a
 * remembered class string.
 */

/* ---------------------------------------------------------------- button */

export type ButtonVariant =
  | "primary"
  | "brand"
  | "secondary"
  | "ghost"
  | "danger"
  | "danger-outline"
  | "chrome";

export type ButtonSize = "sm" | "md" | "lg";

function buttonClass({
  variant = "secondary",
  size = "md",
  block,
  iconOnly,
  className,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  iconOnly?: boolean;
  className?: string;
}) {
  return [
    "prio-btn",
    `prio-btn--${variant}`,
    size !== "md" ? `prio-btn--${size}` : null,
    block ? "prio-btn--block" : null,
    iconOnly ? "prio-btn--icon" : null,
    className,
  ]
    .filter(Boolean)
    .join(" ");
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  iconOnly?: boolean;
  loading?: boolean;
}

export function Button({
  variant,
  size,
  block,
  iconOnly,
  loading,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={buttonClass({ variant, size, block, iconOnly, className })}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="prio-spinner" aria-hidden /> : null}
      {children}
    </button>
  );
}

export interface ButtonLinkProps
  extends AnchorHTMLAttributes<HTMLAnchorElement> {
  href: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  iconOnly?: boolean;
}

export function ButtonLink({
  href,
  variant,
  size,
  block,
  iconOnly,
  className,
  children,
  ...rest
}: ButtonLinkProps) {
  return (
    <Link
      href={href}
      className={buttonClass({ variant, size, block, iconOnly, className })}
      {...rest}
    >
      {children}
    </Link>
  );
}

/* ---------------------------------------------------------------- avatar */

export type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl";

export interface AvatarProps {
  name: string | null | undefined;
  image?: string | null;
  size?: AvatarSize;
  className?: string;
  /** Renders a dashed placeholder for "no assignee". */
  empty?: boolean;
  title?: string;
}

export function Avatar({
  name,
  image,
  size = "sm",
  className,
  empty,
  title,
}: AvatarProps) {
  const classes = [
    "prio-avatar",
    size !== "sm" ? `prio-avatar--${size}` : null,
    empty ? "prio-avatar--empty" : null,
    className,
  ]
    .filter(Boolean)
    .join(" ");

  if (empty) {
    return (
      <span className={classes} title={title ?? "Unassigned"} aria-hidden>
        —
      </span>
    );
  }

  return (
    <span
      className={classes}
      title={title ?? name ?? undefined}
      style={image ? { background: "none" } : undefined}
    >
      {image ? (
        // Avatars are small, user-provided and may be external — a plain img
        // keeps them out of the optimizer.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={image}
          alt=""
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : (
        initials(name)
      )}
      <span className="prio-visually-hidden">{name ?? "Unassigned"}</span>
    </span>
  );
}

export function AvatarStack({
  people,
  max = 4,
  size = "sm",
}: {
  people: { id: string; name: string; image?: string | null }[];
  max?: number;
  size?: AvatarSize;
}) {
  const shown = people.slice(0, max);
  const overflow = people.length - shown.length;

  return (
    <span className="prio-avatar-stack">
      {shown.map((p) => (
        <Avatar key={p.id} name={p.name} image={p.image} size={size} />
      ))}
      {overflow > 0 ? (
        <span
          className={`prio-avatar${size !== "sm" ? ` prio-avatar--${size}` : ""}`}
          style={{
            background: "var(--prio-neutral-200)",
            color: "var(--prio-text-secondary)",
          }}
          title={`${overflow} more`}
        >
          +{overflow}
        </span>
      ) : null}
    </span>
  );
}

/* ----------------------------------------------------------------- card */

export function Card({
  children,
  className,
  flat,
  interactive,
  style,
}: {
  children: ReactNode;
  className?: string;
  flat?: boolean;
  interactive?: boolean;
  style?: CSSProperties;
}) {
  return (
    <div
      className={[
        "prio-card",
        flat ? "prio-card--flat" : null,
        interactive ? "prio-card--interactive" : null,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      style={style}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  action,
  children,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="prio-card__header">
      {title ? <h3 className="prio-card__title">{title}</h3> : null}
      {children}
      {action}
    </div>
  );
}

export function CardBody({
  children,
  tight,
  className,
}: {
  children: ReactNode;
  tight?: boolean;
  className?: string;
}) {
  return (
    <div
      className={[
        "prio-card__body",
        tight ? "prio-card__body--tight" : null,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </div>
  );
}

/* ----------------------------------------------------------- empty state */

export function EmptyState({
  icon,
  title,
  body,
  actions,
}: {
  icon?: ReactNode;
  title: string;
  body?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="prio-empty">
      {icon ? <span className="prio-empty__icon">{icon}</span> : null}
      <p className="prio-empty__title">{title}</p>
      {body ? <p className="prio-empty__body">{body}</p> : null}
      {actions ? <div className="prio-empty__actions">{actions}</div> : null}
    </div>
  );
}

/* ---------------------------------------------------------------- alert */

export function Alert({
  tone = "info",
  icon,
  children,
}: {
  tone?: "info" | "success" | "warning" | "danger";
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className={`prio-alert prio-alert--${tone}`} role="alert">
      {icon ? <span className="prio-alert__icon">{icon}</span> : null}
      <div>{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------- skeleton */

export function Skeleton({
  variant = "text",
  width,
  height,
  className,
}: {
  variant?: "text" | "title" | "block" | "circle";
  width?: number | string;
  height?: number | string;
  className?: string;
}) {
  return (
    <span
      className={[
        "prio-skeleton",
        `prio-skeleton--${variant}`,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      style={{ width, height, display: "block" }}
      aria-hidden
    />
  );
}

/* ----------------------------------------------------------------- stat */

export function Stat({
  label,
  value,
  hint,
  icon,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  tone?: "default" | "brand" | "danger" | "warning" | "success";
}) {
  return (
    <div className="prio-stat" data-tone={tone ?? "default"}>
      <span className="prio-stat__label">
        {icon}
        {label}
      </span>
      <span className="prio-stat__value">{value}</span>
      {hint ? <span className="prio-stat__hint">{hint}</span> : null}
    </div>
  );
}

/* -------------------------------------------------------------- meta row */

export function MetaRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="prio-meta-row">
      <span className="prio-meta-row__label">{label}</span>
      <span className="prio-meta-row__value">{children}</span>
    </div>
  );
}
