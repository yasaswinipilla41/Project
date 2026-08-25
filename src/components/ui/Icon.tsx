import type { SVGProps } from "react";

/**
 * The Prio icon set — drawn for Prio, not imported from a library.
 *
 * House rules that keep the set coherent:
 *   - 16×16 grid, 1.5 stroke, round caps and joins, geometry on half-pixels
 *   - stroke-first (fills only where a glyph reads better solid)
 *   - `currentColor` throughout so tokens drive the colour
 */

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  size?: number;
  /** Supply when the icon carries meaning on its own. */
  title?: string;
}

function Svg({ size = 16, title, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      focusable="false"
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

/* ------------------------------------------------------------ navigation */

export const IconHome = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 6.8 8 2.5l5.5 4.3v6a1 1 0 0 1-1 1h-2.6V9.6H6.1v4.2H3.5a1 1 0 0 1-1-1v-6Z" />
  </Svg>
);

export const IconProjects = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.3" y="2.3" width="5" height="5" rx="1.3" />
    <rect x="8.7" y="2.3" width="5" height="5" rx="1.3" />
    <rect x="2.3" y="8.7" width="5" height="5" rx="1.3" />
    <rect x="8.7" y="8.7" width="5" height="5" rx="1.3" />
  </Svg>
);

export const IconIssues = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.3" y="2.5" width="11.4" height="4" rx="1.3" />
    <rect x="2.3" y="9.5" width="11.4" height="4" rx="1.3" />
  </Svg>
);

export const IconMyWork = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 5.5a1.3 1.3 0 0 1 1.3-1.3h8.4a1.3 1.3 0 0 1 1.3 1.3v6.4a1.3 1.3 0 0 1-1.3 1.3H3.8a1.3 1.3 0 0 1-1.3-1.3V5.5Z" />
    <path d="M6 4.2V3.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v.7" />
    <path d="M2.5 8.2h11" />
  </Svg>
);

export const IconBell = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 6.8a4 4 0 1 1 8 0v2.4l1 1.8H3l1-1.8V6.8Z" />
    <path d="M6.5 11.8a1.6 1.6 0 0 0 3 0" />
  </Svg>
);

export const IconSearch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="7.2" cy="7.2" r="4.2" />
    <path d="m10.4 10.4 3 3" />
  </Svg>
);

export const IconReports = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 13.5h11" />
    <path d="M4.6 13.5V8.4" />
    <path d="M8 13.5V3.8" />
    <path d="M11.4 13.5v-3.6" />
  </Svg>
);

export const IconAdmin = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 2.2 3.4 4v3.7c0 2.7 1.9 5.2 4.6 6.1 2.7-.9 4.6-3.4 4.6-6.1V4L8 2.2Z" />
    <path d="m6.2 7.9 1.3 1.3 2.4-2.5" />
  </Svg>
);

export const IconBoard = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.3" y="2.5" width="3.4" height="11" rx="1.1" />
    <rect x="6.9" y="2.5" width="3.4" height="7.5" rx="1.1" />
    <rect x="11.5" y="2.5" width="2.2" height="9.5" rx="1.1" />
  </Svg>
);

export const IconList = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5.6 4h8M5.6 8h8M5.6 12h8" />
    <path d="M2.7 4h.01M2.7 8h.01M2.7 12h.01" strokeWidth={2} />
  </Svg>
);

export const IconBacklog = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.4" y="3" width="11.2" height="3.2" rx="1.1" />
    <rect x="2.4" y="9.8" width="11.2" height="3.2" rx="1.1" />
    <path d="M8 6.4v3" strokeDasharray="1 1.6" />
  </Svg>
);

export const IconTimeline = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.4" y="3.2" width="7" height="2.6" rx="1.3" />
    <rect x="5.2" y="6.7" width="8.4" height="2.6" rx="1.3" />
    <rect x="3.6" y="10.2" width="6" height="2.6" rx="1.3" />
  </Svg>
);

export const IconOverview = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 8V3.6" />
    <path d="M8 8l3.4 2.4" />
  </Svg>
);

/* ------------------------------------------------------------ issue types */

/** Task — a checkable square. */
export const IconTask = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.6" y="2.6" width="10.8" height="10.8" rx="2.4" />
    <path d="m5.6 8.1 1.7 1.7 3.3-3.5" />
  </Svg>
);

/** Bug — a rounded body with legs and antennae, unmistakable at 16 px. */
export const IconBug = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5.1 6.2a2.9 2.9 0 0 1 5.8 0v2.6a2.9 2.9 0 0 1-5.8 0V6.2Z" />
    <path d="M6.2 4.4 5.3 3.1M9.8 4.4l.9-1.3" />
    <path d="M5.1 7.5H2.8M13.2 7.5h-2.3" />
    <path d="M5.3 10.1 3.4 11.5M10.7 10.1l1.9 1.4" />
    <path d="M5.3 5.2 3.5 4M10.7 5.2 12.5 4" />
  </Svg>
);

/** Story — a bookmarked page. */
export const IconStory = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.4 3.6a1.2 1.2 0 0 1 1.2-1.2h6.8a1.2 1.2 0 0 1 1.2 1.2v10l-3-2.1-3 2.1v-10Z" />
    <path d="M6.2 5.6h3.6" />
  </Svg>
);

/* ---------------------------------------------------------------- actions */

export const IconPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 3.4v9.2M3.4 8h9.2" />
  </Svg>
);

export const IconClose = (p: IconProps) => (
  <Svg {...p}>
    <path d="m4.2 4.2 7.6 7.6M11.8 4.2l-7.6 7.6" />
  </Svg>
);

export const IconCheck = (p: IconProps) => (
  <Svg {...p}>
    <path d="m3.5 8.4 3 3 6-6.8" />
  </Svg>
);

export const IconMore = (p: IconProps) => (
  <Svg {...p} strokeWidth={2}>
    <path d="M4 8h.01M8 8h.01M12 8h.01" />
  </Svg>
);

export const IconFilter = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.6 3.9h10.8L9.6 8.4v4l-3.2 1.5v-5.5L2.6 3.9Z" />
  </Svg>
);

export const IconSort = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.4 2.9v10.2M2.4 11.1l2 2 2-2" />
    <path d="M8.8 4.4h4.8M8.8 8h3.2M8.8 11.6h1.6" />
  </Svg>
);

export const IconChevronDown = (p: IconProps) => (
  <Svg {...p}>
    <path d="m4 6.2 4 4 4-4" />
  </Svg>
);

export const IconChevronRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="m6.2 4 4 4-4 4" />
  </Svg>
);

export const IconChevronLeft = (p: IconProps) => (
  <Svg {...p}>
    <path d="m9.8 4-4 4 4 4" />
  </Svg>
);

export const IconChevronUp = (p: IconProps) => (
  <Svg {...p}>
    <path d="m4 9.8 4-4 4 4" />
  </Svg>
);

export const IconSidebarCollapse = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.4" y="3" width="11.2" height="10" rx="1.8" />
    <path d="M6.6 3v10" />
  </Svg>
);

export const IconDrag = (p: IconProps) => (
  <Svg {...p} strokeWidth={2}>
    <path d="M6 4h.01M10 4h.01M6 8h.01M10 8h.01M6 12h.01M10 12h.01" />
  </Svg>
);

export const IconEdit = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.6 3.4 12.6 6.4 6 13H3v-3l6.6-6.6Z" />
  </Svg>
);

export const IconTrash = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 4.4h10" />
    <path d="M6.2 4.4V3.2a.8.8 0 0 1 .8-.8h2a.8.8 0 0 1 .8.8v1.2" />
    <path d="M4.4 4.4 5 13a.8.8 0 0 0 .8.8h4.4A.8.8 0 0 0 11 13l.6-8.6" />
  </Svg>
);

export const IconLink = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.8 9.2a2.6 2.6 0 0 0 3.7 0l2-2a2.6 2.6 0 1 0-3.7-3.7l-.9.9" />
    <path d="M9.2 6.8a2.6 2.6 0 0 0-3.7 0l-2 2a2.6 2.6 0 1 0 3.7 3.7l.9-.9" />
  </Svg>
);

/** Arrow into a tray — "save this to your device". */
export const IconDownload = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 2.6v7.2" />
    <path d="M5.2 7.4 8 10.2l2.8-2.8" />
    <path d="M2.8 11.4v1a1.2 1.2 0 0 0 1.2 1.2h8a1.2 1.2 0 0 0 1.2-1.2v-1" />
  </Svg>
);

export const IconExternal = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12.6 9v3.2a1.2 1.2 0 0 1-1.2 1.2H3.8a1.2 1.2 0 0 1-1.2-1.2V4.6a1.2 1.2 0 0 1 1.2-1.2H7" />
    <path d="M9.8 2.6h3.6v3.6M13.4 2.6 7.8 8.2" />
  </Svg>
);

/* -------------------------------------------------------------- metadata */

export const IconCalendar = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.4" y="3.4" width="11.2" height="10.2" rx="1.6" />
    <path d="M2.4 6.6h11.2M5.6 2.4v2M10.4 2.4v2" />
  </Svg>
);

export const IconClock = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.6" />
    <path d="M8 4.9V8l2.2 1.5" />
  </Svg>
);

export const IconUser = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="5.6" r="2.6" />
    <path d="M3.2 13.4a4.8 4.8 0 0 1 9.6 0" />
  </Svg>
);

export const IconUsers = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="6.3" cy="5.6" r="2.4" />
    <path d="M2.2 13.2a4.1 4.1 0 0 1 8.2 0" />
    <path d="M10.6 3.6a2.4 2.4 0 0 1 0 4.4M11.5 9.6a4.1 4.1 0 0 1 2.3 3.6" />
  </Svg>
);

export const IconComment = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.6 4.5a1.5 1.5 0 0 1 1.5-1.5h7.8a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5H7L4 13.4V11h-.4a1.5 1.5 0 0 1-1-1.5v-5Z" />
  </Svg>
);

export const IconActivity = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.4 8h2.4l1.6-4 2.6 8.4 1.6-4.4h3" />
  </Svg>
);

export const IconLabel = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.6 7.2V3.9a1.3 1.3 0 0 1 1.3-1.3h3.3a1.3 1.3 0 0 1 .9.4l5 5a1.3 1.3 0 0 1 0 1.8l-3.5 3.5a1.3 1.3 0 0 1-1.8 0l-5-5a1.3 1.3 0 0 1-.2-1.1Z" />
    <path d="M5.4 5.4h.01" strokeWidth={2} />
  </Svg>
);

export const IconParent = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.4" y="2.6" width="6" height="4.2" rx="1.2" />
    <path d="M5.4 6.8v4a1.4 1.4 0 0 0 1.4 1.4h1.6" />
    <rect x="8.4" y="9.6" width="5.2" height="4" rx="1.2" />
  </Svg>
);

export const IconSubIssue = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 2.6v6.6a1.4 1.4 0 0 0 1.4 1.4H8" />
    <rect x="8.4" y="8.4" width="5.2" height="4" rx="1.2" />
  </Svg>
);

export const IconLogout = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.4 13.4H3.8a1.2 1.2 0 0 1-1.2-1.2V3.8a1.2 1.2 0 0 1 1.2-1.2h2.6" />
    <path d="M10 11.2 13.4 8 10 4.8M13.4 8H6" />
  </Svg>
);

export const IconSettings = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="2.1" />
    <path d="M8 1.8 9.1 3.4l1.9-.4.4 1.9 1.6 1.1-1 1.6 1 1.6-1.6 1.1-.4 1.9-1.9-.4L8 14.2l-1.1-1.6-1.9.4-.4-1.9L3 10l1-1.6L3 6.8l1.6-1.1.4-1.9 1.9.4L8 1.8Z" />
  </Svg>
);

export const IconHelp = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.6" />
    <path d="M6.4 6.3a1.7 1.7 0 1 1 2.3 1.6c-.5.2-.7.6-.7 1.1v.3" />
    <path d="M8 11.6h.01" strokeWidth={2} />
  </Svg>
);

export const IconInfo = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.6" />
    <path d="M8 7.4v3.4M8 5.2h.01" strokeWidth={2} />
  </Svg>
);

export const IconWarning = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 2.9a1.2 1.2 0 0 1 2 0l4.4 8.5a1.1 1.1 0 0 1-1 1.7H3.6a1.1 1.1 0 0 1-1-1.7L7 2.9Z" />
    <path d="M8 6.4v2.6M8 11.1h.01" strokeWidth={2} />
  </Svg>
);

export const IconSuccess = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="5.6" />
    <path d="m5.6 8.2 1.7 1.7 3.3-3.7" />
  </Svg>
);

export const IconMail = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.4" y="3.6" width="11.2" height="8.8" rx="1.4" />
    <path d="m2.8 4.6 5.2 3.8 5.2-3.8" />
  </Svg>
);

export const IconLock = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.4" y="7.1" width="9.2" height="6.4" rx="1.5" />
    <path d="M5.6 7.1V5.4a2.4 2.4 0 0 1 4.8 0v1.7" />
  </Svg>
);

export const IconEye = (p: IconProps) => (
  <Svg {...p}>
    <path d="M1.8 8S4.2 4.1 8 4.1 14.2 8 14.2 8 11.8 11.9 8 11.9 1.8 8 1.8 8Z" />
    <circle cx="8" cy="8" r="1.8" />
  </Svg>
);

export const IconEyeOff = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.3 4.4A6.3 6.3 0 0 1 8 4.1c3.8 0 6.2 3.9 6.2 3.9a12 12 0 0 1-2 2.4" />
    <path d="M11 11.3a6.2 6.2 0 0 1-3 .6C4.2 11.9 1.8 8 1.8 8a12 12 0 0 1 2.9-3" />
    <path d="m2.6 2.6 10.8 10.8" />
  </Svg>
);

export const IconArrowRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 8h10M9.4 4.4 13 8l-3.6 3.6" />
  </Svg>
);

export const IconRefresh = (p: IconProps) => (
  <Svg {...p}>
    <path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.8" />
    <path d="M13.4 2.6v3.2h-3.2" />
  </Svg>
);

export const IconInbox = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 9.2 4.2 3.6a1.2 1.2 0 0 1 1.2-.9h5.2a1.2 1.2 0 0 1 1.2.9l1.7 5.6v3a1.2 1.2 0 0 1-1.2 1.2H3.7a1.2 1.2 0 0 1-1.2-1.2v-3Z" />
    <path d="M2.5 9.2h3l.8 1.6h3.4l.8-1.6h3" />
  </Svg>
);

export const IconEmptyBox = (p: IconProps) => (
  <Svg {...p} size={p.size ?? 24} viewBox="0 0 24 24">
    <path d="M3.5 8.4 12 4l8.5 4.4v7.2L12 20l-8.5-4.4V8.4Z" />
    <path d="m3.5 8.4 8.5 4.4 8.5-4.4M12 12.8V20" />
  </Svg>
);

/* ------------------------------------------------------------------ theme */

export const IconSun = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="3.1" />
    <path d="M8 1.4v1.4M8 13.2v1.4M2.4 8H1M15 8h-1.4M4.05 4.05 3.05 3.05M12.95 12.95l-1-1M4.05 11.95l-1 1M12.95 3.05l-1 1" />
  </Svg>
);

export const IconMoon = (p: IconProps) => (
  <Svg {...p}>
    {/* A crescent as one closed path — a filled disc masked by a second disc
        renders as two overlapping shapes wherever the icon sits on a tint. */}
    <path d="M13.4 9.6A5.8 5.8 0 0 1 6.4 2.6a5.9 5.9 0 1 0 7 7Z" />
  </Svg>
);

export const IconSystem = (p: IconProps) => (
  <Svg {...p}>
    <rect x="1.8" y="2.8" width="12.4" height="8.4" rx="1.2" />
    <path d="M5.6 14h4.8M8 11.2V14" />
  </Svg>
);
