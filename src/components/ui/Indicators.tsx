import type { IssueStatus, IssueType, Priority } from "@prisma/client";
import {
  ISSUE_TYPE_LABEL,
  PRIORITY_LABEL,
  STATUS_LABEL,
} from "@/lib/domain";
import {
  IconBug,
  IconParent,
  IconStar,
  IconStory,
  IconTask,
} from "@/components/ui/Icon";

/**
 * Status, priority and issue-type indicators.
 *
 * Every surface in Prio renders these components rather than its own markup,
 * so a bug looks like a bug — and an Urgent priority reads as Urgent —
 * whether it appears on a board card, a table row or the detail header.
 */

/* ---------------------------------------------------------------- status */

export function StatusPill({
  status,
  className,
}: {
  status: IssueStatus;
  className?: string;
}) {
  return (
    <span
      className={`prio-status${className ? ` ${className}` : ""}`}
      data-status={status}
    >
      <span className="prio-status__dot" aria-hidden />
      {STATUS_LABEL[status]}
    </span>
  );
}

/* -------------------------------------------------------------- priority */

/**
 * Priority reads as a four-bar meter: filled bars grow with urgency, so the
 * level is legible before the label is read. Urgent additionally reverses to a
 * solid block so it stands out in a dense list.
 */
export function PriorityIndicator({
  priority,
  showLabel = true,
  className,
}: {
  priority: Priority;
  showLabel?: boolean;
  className?: string;
}) {
  const filled: Record<Priority, number> = {
    URGENT: 4,
    HIGH: 3,
    MEDIUM: 2,
    LOW: 1,
    NONE: 0,
  };
  const level = filled[priority];

  return (
    <span
      className={`prio-priority${className ? ` ${className}` : ""}`}
      data-priority={priority}
      title={`Priority: ${PRIORITY_LABEL[priority]}`}
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 12 12"
        aria-hidden
        focusable="false"
        style={{ flexShrink: 0 }}
      >
        {[0, 1, 2, 3].map((i) => (
          <rect
            key={i}
            x={0.5 + i * 3}
            y={9.5 - i * 2.4}
            width="2"
            height={1.6 + i * 2.4}
            rx="0.8"
            fill="currentColor"
            opacity={i < level ? 1 : 0.22}
          />
        ))}
      </svg>
      {showLabel ? PRIORITY_LABEL[priority] : null}
      {showLabel ? null : (
        <span className="prio-visually-hidden">
          Priority {PRIORITY_LABEL[priority]}
        </span>
      )}
    </span>
  );
}

/* ------------------------------------------------------------ issue type */

export function IssueTypeIcon({
  type,
  size = 18,
  className,
}: {
  type: IssueType;
  size?: number;
  className?: string;
}) {
  const Glyph =
    type === "BUG"
      ? IconBug
      : type === "STORY"
        ? IconStory
        : type === "EPIC"
          ? IconParent
          : type === "FEATURE"
            ? IconStar
            : IconTask;

  return (
    <span
      className={`prio-type${className ? ` ${className}` : ""}`}
      data-type={type}
      style={{ width: size, height: size }}
      title={ISSUE_TYPE_LABEL[type]}
    >
      <Glyph size={Math.round(size * 0.72)} />
      <span className="prio-visually-hidden">{ISSUE_TYPE_LABEL[type]}</span>
    </span>
  );
}

/* ------------------------------------------------------------- issue key */

export function IssueKey({
  issueKey,
  className,
}: {
  issueKey: string;
  className?: string;
}) {
  return (
    <span className={`prio-key${className ? ` ${className}` : ""}`}>
      {issueKey}
    </span>
  );
}

/* ----------------------------------------------------------- label chip */

export function LabelChip({
  name,
  color,
  className,
}: {
  name: string;
  color: string;
  className?: string;
}) {
  return (
    <span className={`prio-label-chip${className ? ` ${className}` : ""}`}>
      <span
        className="prio-label-chip__swatch"
        style={{ background: color }}
        aria-hidden
      />
      {name}
    </span>
  );
}
