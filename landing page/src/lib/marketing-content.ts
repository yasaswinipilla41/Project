/**
 * Copy and sample data for the marketing site, kept out of the components so
 * the wording can change without touching layout or motion code.
 *
 * Everything here is illustrative. The companies are fictional and the metrics
 * describe the sample workspace shown in the mockups — no real customers and no
 * invented results are claimed.
 */

export const NAV_LINKS = [
  { label: "Product", href: "#product" },
  { label: "Solutions", href: "#value" },
  { label: "Features", href: "#features" },
  { label: "Resources", href: "#workflow" },
  { label: "Pricing", href: "#cta" },
] as const;

export const HERO = {
  eyebrow: "The modern internal issue tracker",
  heading: ["Plan better.", "Track smarter.", "Deliver faster."],
  body: "Prio brings projects, issues, teams, priorities, and progress into one beautifully simple workspace.",
  primaryCta: "Get Started",
  secondaryCta: "Explore Prio",
  trust: "Built for teams that want less chaos and more clarity.",
} as const;

/** Fictional marks for the social proof strip (§12). */
export const COMPANIES = [
  { name: "Northwind", glyph: "◈" },
  { name: "Aperture Labs", glyph: "◐" },
  { name: "Vertex", glyph: "▲" },
  { name: "Lumen", glyph: "◎" },
  { name: "Cobalt", glyph: "◆" },
  { name: "Meridian", glyph: "❖" },
] as const;

export const VALUES = [
  {
    id: "plan",
    step: "01",
    title: "Plan",
    description:
      "Organize projects, priorities, milestones, and upcoming work in one place.",
    points: ["Roadmaps", "Milestones", "Backlog grooming"],
  },
  {
    id: "track",
    step: "02",
    title: "Track",
    description:
      "See issues, ownership, deadlines, blockers, and progress as they change.",
    points: ["Live status", "Ownership", "Blockers"],
  },
  {
    id: "deliver",
    step: "03",
    title: "Deliver",
    description: "Move work from idea to completion faster, with less friction.",
    points: ["Reviews", "Releases", "Retrospectives"],
  },
] as const;

export const FEATURES = [
  {
    id: "issues",
    title: "Issue Management",
    description:
      "Every task, story and bug in one queue with filters that actually hold.",
    accent: "blue",
  },
  {
    id: "bugs",
    title: "Bug Tracking",
    description:
      "Reproduction steps, expected versus actual, severity and environment.",
    accent: "red",
  },
  {
    id: "projects",
    title: "Project Management",
    description: "Immutable issue keys, members, labels and per-project settings.",
    accent: "indigo",
  },
  {
    id: "kanban",
    title: "Kanban Boards",
    description: "Drag work through Backlog, Todo, In Progress, Review and Done.",
    accent: "purple",
  },
  {
    id: "priorities",
    title: "Priorities & Severity",
    description:
      "Urgency and impact stay separate, because they answer different questions.",
    accent: "amber",
  },
  {
    id: "collaboration",
    title: "Team Collaboration",
    description: "Threaded comments, mentions and notifications on every issue.",
    accent: "teal",
  },
  {
    id: "workflows",
    title: "Custom Workflows",
    description: "Automations that route, notify and assign without the busywork.",
    accent: "violet",
  },
  {
    id: "analytics",
    title: "Analytics",
    description: "Distributions, workload and throughput, straight from the data.",
    accent: "green",
  },
] as const;

export type IssueStatusKey =
  | "backlog"
  | "todo"
  | "progress"
  | "review"
  | "done";

export const BOARD_COLUMNS: {
  id: IssueStatusKey;
  label: string;
}[] = [
  { id: "backlog", label: "Backlog" },
  { id: "todo", label: "To Do" },
  { id: "progress", label: "In Progress" },
  { id: "review", label: "Review" },
  { id: "done", label: "Done" },
];

export const BOARD_CARDS = [
  {
    key: "PRIO-201",
    title: "Research payment gateway",
    column: "backlog" as IssueStatusKey,
    priority: "Medium",
    assignee: "RM",
    type: "task" as const,
  },
  {
    key: "PRIO-204",
    title: "Fix login bug",
    column: "todo" as IssueStatusKey,
    priority: "Urgent",
    assignee: "KD",
    type: "bug" as const,
  },
  {
    key: "PRIO-207",
    title: "Improve API response time",
    column: "progress" as IssueStatusKey,
    priority: "High",
    assignee: "PN",
    type: "task" as const,
  },
  {
    key: "PRIO-209",
    title: "Code review",
    column: "review" as IssueStatusKey,
    priority: "Medium",
    assignee: "SI",
    type: "story" as const,
  },
  {
    key: "PRIO-212",
    title: "Setup CI/CD pipeline",
    column: "done" as IssueStatusKey,
    priority: "High",
    assignee: "MP",
    type: "task" as const,
  },
] as const;

/** Issues shown inside the hero dashboard mockup. */
export const HERO_ISSUES = [
  {
    key: "PRIO-118",
    title: "Fix authentication bug",
    type: "bug" as const,
    status: "progress" as IssueStatusKey,
    priority: "Urgent",
    assignee: "KD",
  },
  {
    key: "PRIO-124",
    title: "Improve API performance",
    type: "task" as const,
    status: "progress" as IssueStatusKey,
    priority: "High",
    assignee: "PN",
  },
  {
    key: "PRIO-131",
    title: "Update dashboard UI",
    type: "story" as const,
    status: "todo" as IssueStatusKey,
    priority: "Medium",
    assignee: "MP",
  },
  {
    key: "PRIO-136",
    title: "Add notification system",
    type: "task" as const,
    status: "review" as IssueStatusKey,
    priority: "High",
    assignee: "SI",
  },
  {
    key: "PRIO-140",
    title: "Review deployment pipeline",
    type: "task" as const,
    status: "done" as IssueStatusKey,
    priority: "Low",
    assignee: "RM",
  },
] as const;

export const ISSUE_DETAIL = {
  key: "PRIO-124",
  title: "Improve dashboard performance",
  priority: "High",
  severity: "Major",
  status: "In Progress",
  assignee: { name: "Priya Nair", initials: "PN" },
  reporter: { name: "Sneha Iyer", initials: "SI" },
  due: "12 Sep",
  labels: ["performance", "frontend"],
  description:
    "The project dashboard takes over four seconds to paint on projects with more than a thousand issues. Aggregate the counts in a single grouped query and paginate the activity feed.",
  activity: [
    { who: "Sarah", initials: "SW", action: "moved this to In Progress", at: "2h ago" },
    { who: "Alex", initials: "AK", action: "added a comment", at: "1h ago" },
    { who: "Priya", initials: "PN", action: "changed priority to High", at: "24m ago" },
  ],
  comment: {
    who: "Alex Kerr",
    initials: "AK",
    body: "Profiled it — the count queries are the bottleneck, not the render. One groupBy should cover the whole panel.",
  },
} as const;

export const WORKFLOW_STEPS = [
  { id: "idea", label: "Idea", detail: "Captured from anywhere" },
  { id: "planned", label: "Planned", detail: "Scoped and prioritised" },
  { id: "progress", label: "In Progress", detail: "Owned and moving" },
  { id: "review", label: "Review", detail: "Checked before release" },
  { id: "done", label: "Done", detail: "Shipped and recorded" },
] as const;

export const ANALYTICS = {
  stats: [
    { label: "Completion rate", value: 87, suffix: "%", tone: "green" },
    { label: "Open issues", value: 142, suffix: "", tone: "blue" },
    { label: "Resolved this month", value: 318, suffix: "", tone: "purple" },
    { label: "Avg. cycle time", value: 3.4, suffix: "d", decimals: 1, tone: "amber" },
  ],
  velocity: [38, 52, 45, 61, 58, 72, 66, 81],
  priorities: [
    { label: "Urgent", value: 12, tone: "red" },
    { label: "High", value: 34, tone: "amber" },
    { label: "Medium", value: 58, tone: "blue" },
    { label: "Low", value: 38, tone: "slate" },
  ],
  workload: [
    { name: "Priya Nair", initials: "PN", load: 82 },
    { name: "Kiran Das", initials: "KD", load: 64 },
    { name: "Meera Pillai", initials: "MP", load: 47 },
    { name: "Sneha Iyer", initials: "SI", load: 35 },
  ],
} as const;

export const AUTOMATION_STEPS = [
  {
    kind: "WHEN",
    title: "Issue priority becomes High",
    detail: "Triggers the moment priority changes, however it was changed.",
  },
  {
    kind: "THEN",
    title: "Notify project lead",
    detail: "An in-app notification, and email if they have it enabled.",
  },
  {
    kind: "AND",
    title: "Add issue to urgent queue",
    detail: "Appears at the top of the team's urgent view.",
  },
  {
    kind: "AND",
    title: "Assign to appropriate team",
    detail: "Routed by affected module to the team that owns it.",
  },
] as const;

export const COLLABORATION_CARDS = [
  {
    id: "mention",
    who: "Rahul Menon",
    initials: "RM",
    text: "@priya can you take the query profiling on this one?",
    meta: "Mentioned you",
  },
  {
    id: "status",
    who: "Kiran Das",
    initials: "KD",
    text: "Moved PRIO-118 from In Review to Done",
    meta: "Status update",
  },
  {
    id: "assign",
    who: "Sneha Iyer",
    initials: "SI",
    text: "Assigned PRIO-136 to you",
    meta: "Assignment",
  },
] as const;

export const FOOTER_GROUPS = [
  {
    title: "Product",
    links: ["Features", "Projects", "Issue Tracking", "Workflows", "Analytics"],
  },
  { title: "Company", links: ["About", "Careers", "Contact"] },
  { title: "Resources", links: ["Documentation", "Help Center", "Guides"] },
  { title: "Legal", links: ["Privacy", "Terms", "Security"] },
] as const;

export const FINAL_CTA = {
  heading: "Your team's work deserves a better workspace.",
  body: "Bring projects, issues, priorities, and people together with Prio.",
  primary: "Get Started with Prio",
  secondary: "Explore the Platform",
} as const;
