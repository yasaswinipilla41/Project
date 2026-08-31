import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  PrismaClient,
  type IssueStatus,
  type IssueType,
  type Priority,
  type Severity,
} from "@prisma/client";
import { hashPassword } from "@better-auth/utils/password";
import { createLocalAccountIssuer } from "@better-auth/core/db";
import { DEFAULT_PROJECT_LABELS } from "../src/lib/domain";

/**
 * Development seed for Symbiosys Technologies.
 *
 * Produces a populated, realistic workspace: users, three projects, labels,
 * tasks, stories, bugs with full bug detail, comments with mentions, activity
 * history and notifications. Re-running is safe — it upserts by natural key.
 *
 * Passwords go through better-auth's own hasher, so seeded users sign in
 * through the normal form with no special-casing.
 */

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});

/** better-auth scopes local password accounts under a synthetic issuer. */
const CREDENTIAL_ISSUER = createLocalAccountIssuer("credential");

const DEFAULT_PASSWORD = process.env.SEED_DEFAULT_PASSWORD ?? "Prio@12345";
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? "admin@symbiosystech.com";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? DEFAULT_PASSWORD;

/* ----------------------------------------------------------------- clock */

/** Deterministic-ish timestamps relative to "now" so the data looks live. */
const now = Date.now();
const daysAgo = (days: number, hours = 0) =>
  new Date(now - days * 86_400_000 - hours * 3_600_000);
const daysAhead = (days: number) => new Date(now + days * 86_400_000);

/* ------------------------------------------------------------------ data */

interface SeedUser {
  email: string;
  name: string;
  role: "ADMIN" | "MEMBER";
  jobTitle: string;
}

const USERS: SeedUser[] = [
  {
    email: ADMIN_EMAIL,
    name: "Aarthi Rao",
    role: "ADMIN",
    jobTitle: "Engineering Manager",
  },
  {
    email: "rahul.menon@symbiosystech.com",
    name: "Rahul Menon",
    role: "ADMIN",
    jobTitle: "Tech Lead",
  },
  {
    email: "priya.nair@symbiosystech.com",
    name: "Priya Nair",
    role: "MEMBER",
    jobTitle: "Senior Engineer",
  },
  {
    email: "kiran.das@symbiosystech.com",
    name: "Kiran Das",
    role: "MEMBER",
    jobTitle: "Engineer",
  },
  {
    email: "sneha.iyer@symbiosystech.com",
    name: "Sneha Iyer",
    role: "MEMBER",
    jobTitle: "QA Engineer",
  },
  {
    email: "vikram.shetty@symbiosystech.com",
    name: "Vikram Shetty",
    role: "MEMBER",
    jobTitle: "Product Designer",
  },
  {
    email: "meera.pillai@symbiosystech.com",
    name: "Meera Pillai",
    role: "MEMBER",
    jobTitle: "Frontend Engineer",
  },
];

const PROJECTS = [
  {
    key: "ENG",
    name: "Engineering",
    description:
      "Platform and API work for the Symbiosys internal product suite.",
  },
  {
    key: "WEB",
    name: "Website",
    description: "Public marketing site, documentation and the careers portal.",
  },
  {
    key: "INT",
    name: "Internal Tools",
    description:
      "Tooling the team relies on day to day — reporting, onboarding, access.",
  },
] as const;

const LABELS: Record<string, { name: string; color: string }[]> = {
  ENG: [
    { name: "backend", color: "#3B82F6" },
    { name: "api", color: "#8B5CF6" },
    { name: "auth", color: "#E5484D" },
    { name: "performance", color: "#F0961F" },
    { name: "regression", color: "#0D9488" },
  ],
  WEB: [
    { name: "content", color: "#8B5CF6" },
    { name: "seo", color: "#14A06D" },
    { name: "responsive", color: "#3B82F6" },
    { name: "accessibility", color: "#F0961F" },
  ],
  INT: [
    { name: "reporting", color: "#3B82F6" },
    { name: "onboarding", color: "#14A06D" },
    { name: "access", color: "#E5484D" },
  ],
};

interface SeedIssue {
  type: IssueType;
  title: string;
  description: string;
  status: IssueStatus;
  priority: Priority;
  assignee?: string;
  reporter: string;
  labels?: string[];
  dueInDays?: number;
  createdDaysAgo: number;
  /** Title of the parent issue within the same project. */
  parentTitle?: string;

  // Bug-specific
  severity?: Severity;
  stepsToReproduce?: string;
  expectedResult?: string;
  actualResult?: string;
  environment?: string;
  browser?: string;
  operatingSystem?: string;
  versionBuild?: string;
  affectedModule?: string;
}

const ISSUES: Record<string, SeedIssue[]> = {
  ENG: [
    {
      type: "BUG",
      title: "Login fails after session expiration",
      description:
        "Users who leave a tab open overnight cannot sign back in without clearing cookies. The sign-in form accepts the credentials and then returns to the sign-in page.",
      status: "IN_PROGRESS",
      priority: "HIGH",
      severity: "MAJOR",
      assignee: "kiran.das@symbiosystech.com",
      reporter: "sneha.iyer@symbiosystech.com",
      labels: ["auth", "regression"],
      createdDaysAgo: 6,
      dueInDays: 2,
      stepsToReproduce:
        "1. Sign in to Prio.\n2. Leave the tab open and idle for longer than the session lifetime (7 days, or reduce it locally to reproduce faster).\n3. Return to the tab and perform any action.\n4. You are redirected to the sign-in page.\n5. Enter the same valid credentials and submit.",
      expectedResult:
        "The credentials are accepted and the user lands back on the page they were trying to reach.",
      actualResult:
        "The form submits, the page reloads, and the sign-in page is shown again with no error message. Clearing cookies for the site makes sign-in work again.",
      environment: "Staging",
      browser: "Chrome 141",
      operatingSystem: "Windows 11",
      versionBuild: "2026.8.14-rc2",
      affectedModule: "Authentication",
    },
    {
      type: "BUG",
      title: "Project filter does not persist after refresh",
      description:
        "Selecting a project filter on the issues list is lost when the page is refreshed, so the user has to reapply it every time.",
      status: "TODO",
      priority: "MEDIUM",
      severity: "MINOR",
      assignee: "meera.pillai@symbiosystech.com",
      reporter: "priya.nair@symbiosystech.com",
      labels: ["regression"],
      createdDaysAgo: 4,
      stepsToReproduce:
        "1. Open the Issues list.\n2. Filter by project Engineering.\n3. Refresh the browser.",
      expectedResult:
        "The project filter is still applied after the refresh, and the URL reflects the active filter.",
      actualResult: "The filter resets to All projects.",
      environment: "Production",
      browser: "Firefox 133",
      operatingSystem: "Ubuntu 24.04",
      versionBuild: "2026.8.12",
      affectedModule: "Issues list",
    },
    {
      type: "BUG",
      title: "Kanban card disappears after status change",
      description:
        "Dragging a card to In Review occasionally removes it from the board entirely. The issue still exists and reappears after a refresh, so this is a board state bug rather than data loss.",
      status: "IN_REVIEW",
      priority: "URGENT",
      severity: "CRITICAL",
      assignee: "rahul.menon@symbiosystech.com",
      reporter: "sneha.iyer@symbiosystech.com",
      labels: ["regression", "performance"],
      createdDaysAgo: 2,
      dueInDays: 1,
      stepsToReproduce:
        "1. Open a project board with more than 40 issues.\n2. Drag any card from In Progress to In Review.\n3. Watch the board immediately after the drop.",
      expectedResult:
        "The card settles into the In Review column and stays there.",
      actualResult:
        "The card vanishes from every column. Refreshing the page shows it correctly in In Review, so the status change did persist.",
      environment: "Production",
      browser: "Chrome 141",
      operatingSystem: "macOS 15.3",
      versionBuild: "2026.8.12",
      affectedModule: "Board",
    },
    {
      type: "STORY",
      title: "Team members can report a bug with reproduction steps",
      description:
        "As a team member I want to report a bug with reproduction steps, expected and actual results, so that whoever picks it up can reproduce it without asking me.",
      status: "DONE",
      priority: "HIGH",
      assignee: "priya.nair@symbiosystech.com",
      reporter: "aarthi",
      labels: ["backend"],
      createdDaysAgo: 21,
    },
    {
      type: "TASK",
      title: "Add database indexes for issue filtering",
      description:
        "Filtering by project, status, type and assignee is doing sequential scans on larger projects. Add composite indexes covering the common filter combinations and confirm with EXPLAIN ANALYZE.",
      status: "DONE",
      priority: "MEDIUM",
      assignee: "kiran.das@symbiosystech.com",
      reporter: "rahul.menon@symbiosystech.com",
      labels: ["backend", "performance"],
      createdDaysAgo: 14,
      parentTitle: "Team members can report a bug with reproduction steps",
    },
    {
      type: "TASK",
      title: "Write the notification digest job",
      description:
        "Queue a background job that batches unread notifications into a single email per user, rather than one email per event.",
      status: "TODO",
      priority: "MEDIUM",
      assignee: "priya.nair@symbiosystech.com",
      reporter: "aarthi",
      labels: ["backend", "api"],
      createdDaysAgo: 3,
      dueInDays: 9,
    },
    {
      type: "TASK",
      title: "Rate-limit the sign-in endpoint",
      description:
        "Add per-IP and per-account throttling to sign-in so repeated failures back off.",
      status: "BACKLOG",
      priority: "HIGH",
      reporter: "rahul.menon@symbiosystech.com",
      labels: ["auth", "backend"],
      createdDaysAgo: 9,
    },
    {
      type: "STORY",
      title: "Reporters can see every change made to their bug",
      description:
        "As the person who reported a bug I want to see each status, priority and severity change with who made it and when, so I can follow progress without asking.",
      status: "IN_PROGRESS",
      priority: "MEDIUM",
      assignee: "meera.pillai@symbiosystech.com",
      reporter: "sneha.iyer@symbiosystech.com",
      createdDaysAgo: 7,
      dueInDays: 5,
    },
    {
      type: "BUG",
      title: "Due date shows one day early in the issue table",
      description:
        "A due date saved as 30 September renders as 29 September for users east of UTC. The stored value is correct, so this is a rendering bug.",
      status: "BACKLOG",
      priority: "LOW",
      severity: "TRIVIAL",
      reporter: "vikram.shetty@symbiosystech.com",
      createdDaysAgo: 11,
      stepsToReproduce:
        "1. Set a due date of 30 September on any issue.\n2. Open the Issues table view.",
      expectedResult: "The Due column reads 30 Sep.",
      actualResult: "The Due column reads 29 Sep.",
      environment: "Production",
      browser: "Safari 18",
      operatingSystem: "macOS 15.3",
      versionBuild: "2026.8.12",
      affectedModule: "Issues table",
    },
    {
      type: "TASK",
      title: "Retire the legacy status column",
      description:
        "The old free-text status column is no longer read anywhere. Drop it after confirming no reports depend on it.",
      status: "CANCELLED",
      priority: "LOW",
      reporter: "rahul.menon@symbiosystech.com",
      labels: ["backend"],
      createdDaysAgo: 30,
    },
  ],
  WEB: [
    {
      type: "BUG",
      title: "Careers page images stretch on tablet widths",
      description:
        "Between 768px and 1024px the team photos lose their aspect ratio and appear stretched vertically.",
      status: "TODO",
      priority: "MEDIUM",
      severity: "MINOR",
      assignee: "vikram.shetty@symbiosystech.com",
      reporter: "meera.pillai@symbiosystech.com",
      labels: ["responsive"],
      createdDaysAgo: 5,
      stepsToReproduce:
        "1. Open the careers page.\n2. Resize the viewport to 820px wide.\n3. Scroll to the team section.",
      expectedResult: "Photos keep their 3:2 aspect ratio and crop instead.",
      actualResult: "Photos stretch to fill the container.",
      environment: "Production",
      browser: "Safari 18",
      operatingSystem: "iPadOS 18",
      versionBuild: "web-2026.08.09",
      affectedModule: "Careers",
    },
    {
      type: "TASK",
      title: "Add meta descriptions to documentation pages",
      description:
        "Documentation pages are missing meta descriptions, so search results show a truncated first paragraph.",
      status: "IN_PROGRESS",
      priority: "LOW",
      assignee: "meera.pillai@symbiosystech.com",
      reporter: "vikram.shetty@symbiosystech.com",
      labels: ["seo", "content"],
      createdDaysAgo: 8,
      dueInDays: 4,
    },
    {
      type: "STORY",
      title: "Visitors can navigate the docs by keyboard alone",
      description:
        "As a keyboard user I want to reach every documentation section without a mouse, so the site is usable with assistive technology.",
      status: "BACKLOG",
      priority: "MEDIUM",
      reporter: "vikram.shetty@symbiosystech.com",
      labels: ["accessibility"],
      createdDaysAgo: 12,
    },
    {
      type: "TASK",
      title: "Compress hero video for first paint",
      description:
        "The landing hero ships a 12MB video. Re-encode and serve a poster frame first.",
      status: "DONE",
      priority: "MEDIUM",
      assignee: "vikram.shetty@symbiosystech.com",
      reporter: "aarthi",
      createdDaysAgo: 18,
    },
  ],
  INT: [
    {
      type: "TASK",
      title: "Automate the new-joiner access checklist",
      description:
        "Provisioning accounts for a new joiner is a manual checklist across five systems. Script the parts that have APIs.",
      status: "IN_PROGRESS",
      priority: "HIGH",
      assignee: "priya.nair@symbiosystech.com",
      reporter: "aarthi",
      labels: ["onboarding", "access"],
      createdDaysAgo: 10,
      dueInDays: 3,
    },
    {
      type: "BUG",
      title: "Weekly report email sends twice on Mondays",
      description:
        "The weekly summary arrives twice every Monday morning, roughly a minute apart. Both copies have identical content.",
      status: "TODO",
      priority: "MEDIUM",
      severity: "MAJOR",
      assignee: "kiran.das@symbiosystech.com",
      reporter: "aarthi",
      labels: ["reporting"],
      createdDaysAgo: 7,
      stepsToReproduce:
        "1. Wait for the Monday 07:00 schedule, or trigger the weekly job manually twice within the same minute.\n2. Check the recipient inbox.",
      expectedResult: "Exactly one weekly summary email per recipient.",
      actualResult:
        "Two identical emails arrive about a minute apart. The job appears to be scheduled on two workers.",
      environment: "Production",
      versionBuild: "int-2026.08.03",
      affectedModule: "Reporting",
    },
    {
      type: "STORY",
      title: "Managers can export a team workload report",
      description:
        "As a manager I want to export open work per person as CSV, so I can review workload in our weekly planning meeting.",
      status: "BACKLOG",
      priority: "LOW",
      reporter: "aarthi",
      labels: ["reporting"],
      createdDaysAgo: 15,
    },
  ],
};

/* ------------------------------------------------------------------ main */

async function main() {
  console.log("Seeding Prio — Symbiosys Technologies\n");

  // ---------------------------------------------------------------- users
  const userIds = new Map<string, string>();

  for (const seedUser of USERS) {
    const password =
      seedUser.email === ADMIN_EMAIL ? ADMIN_PASSWORD : DEFAULT_PASSWORD;

    const user = await prisma.user.upsert({
      where: { email: seedUser.email },
      update: {
        name: seedUser.name,
        role: seedUser.role,
        jobTitle: seedUser.jobTitle,
        isActive: true,
      },
      create: {
        email: seedUser.email,
        name: seedUser.name,
        role: seedUser.role,
        jobTitle: seedUser.jobTitle,
        emailVerified: true,
      },
    });

    userIds.set(seedUser.email, user.id);

    // better-auth's credential account. The issuer is the synthetic
    // "local:credential" value better-auth looks for at sign-in — taken from
    // its own helper so the two can never drift apart.
    const existing = await prisma.account.findFirst({
      where: { userId: user.id, providerId: "credential" },
      select: { id: true },
    });

    if (existing) {
      await prisma.account.update({
        where: { id: existing.id },
        data: {
          issuer: CREDENTIAL_ISSUER,
          accountId: user.id,
          password: await hashPassword(password),
        },
      });
    } else {
      await prisma.account.create({
        data: {
          issuer: CREDENTIAL_ISSUER,
          accountId: user.id,
          providerId: "credential",
          userId: user.id,
          password: await hashPassword(password),
        },
      });
    }
  }

  // Convenience alias used in the issue table above.
  userIds.set("aarthi", userIds.get(ADMIN_EMAIL)!);
  console.log(`  users               ${USERS.length}`);

  const adminId = userIds.get(ADMIN_EMAIL)!;
  const uid = (key: string): string => {
    const id = userIds.get(key);
    if (!id) throw new Error(`Seed references unknown user "${key}"`);
    return id;
  };

  // ------------------------------------------------------------- projects
  let issueTotal = 0;
  let bugTotal = 0;
  let commentTotal = 0;
  let activityTotal = 0;
  let notificationTotal = 0;

  for (const projectSeed of PROJECTS) {
    const project = await prisma.project.upsert({
      where: { key: projectSeed.key },
      update: {
        name: projectSeed.name,
        description: projectSeed.description,
      },
      create: {
        key: projectSeed.key,
        name: projectSeed.name,
        description: projectSeed.description,
        createdById: adminId,
      },
    });

    // Everyone is a member of every seeded project so the demo data is visible.
    for (const seedUser of USERS) {
      await prisma.projectMember.upsert({
        where: {
          projectId_userId: {
            projectId: project.id,
            userId: uid(seedUser.email),
          },
        },
        update: {},
        create: { projectId: project.id, userId: uid(seedUser.email) },
      });
    }

    // --------------------------------------------------------- labels
    const labelIds = new Map<string, string>();
    /* Every project gets the shared vocabulary, plus whatever else this
       particular project is seeded with. Upsert keys on [projectId, name], so
       a name appearing in both lists is written once, not twice. */
    const projectLabels = [
      ...DEFAULT_PROJECT_LABELS,
      ...(LABELS[projectSeed.key] ?? []),
    ];
    for (const label of projectLabels) {
      const row = await prisma.label.upsert({
        where: {
          projectId_name: { projectId: project.id, name: label.name },
        },
        update: { color: label.color },
        create: {
          projectId: project.id,
          name: label.name,
          color: label.color,
        },
      });
      labelIds.set(label.name, row.id);
    }

    // --------------------------------------------------------- issues
    const issueIdsByTitle = new Map<string, string>();
    let sequence = project.issueSequence;

    for (const seed of ISSUES[projectSeed.key] ?? []) {
      const existing = await prisma.issue.findFirst({
        where: { projectId: project.id, title: seed.title },
        select: { id: true },
      });

      const createdAt = daysAgo(seed.createdDaysAgo, 3);
      const isClosed = seed.status === "DONE" || seed.status === "CANCELLED";

      const data = {
        type: seed.type,
        title: seed.title,
        description: seed.description,
        status: seed.status,
        priority: seed.priority,
        assigneeId: seed.assignee ? uid(seed.assignee) : null,
        reporterId: uid(seed.reporter),
        dueDate: seed.dueInDays !== undefined ? daysAhead(seed.dueInDays) : null,
        severity: seed.severity ?? null,
        stepsToReproduce: seed.stepsToReproduce ?? null,
        expectedResult: seed.expectedResult ?? null,
        actualResult: seed.actualResult ?? null,
        environment: seed.environment ?? null,
        browser: seed.browser ?? null,
        operatingSystem: seed.operatingSystem ?? null,
        versionBuild: seed.versionBuild ?? null,
        affectedModule: seed.affectedModule ?? null,
        completedAt: isClosed ? daysAgo(Math.max(0, seed.createdDaysAgo - 4)) : null,
      };

      let issueId: string;

      if (existing) {
        await prisma.issue.update({ where: { id: existing.id }, data });
        issueId = existing.id;
      } else {
        sequence += 1;
        const created = await prisma.issue.create({
          data: {
            ...data,
            projectId: project.id,
            number: sequence,
            key: `${project.key}-${sequence}`,
            sortIndex: sequence * 1000,
            createdAt,
            updatedAt: daysAgo(Math.max(0, seed.createdDaysAgo - 2)),
          },
        });
        issueId = created.id;
      }

      issueIdsByTitle.set(seed.title, issueId);
      issueTotal += 1;
      if (seed.type === "BUG") bugTotal += 1;

      // ------------------------------------------------------ labels
      for (const labelName of seed.labels ?? []) {
        const labelId = labelIds.get(labelName);
        if (!labelId) continue;
        await prisma.issueLabel.upsert({
          where: { issueId_labelId: { issueId, labelId } },
          update: {},
          create: { issueId, labelId },
        });
      }

      // ---------------------------------------------------- watchers
      const watcherIds = new Set<string>([uid(seed.reporter)]);
      if (seed.assignee) watcherIds.add(uid(seed.assignee));
      for (const userId of watcherIds) {
        await prisma.issueWatcher.upsert({
          where: { issueId_userId: { issueId, userId } },
          update: {},
          create: { issueId, userId },
        });
      }

      // ---------------------------------------------------- activity
      const hasActivity = await prisma.activityLogEntry.count({
        where: { issueId },
      });

      if (hasActivity === 0) {
        const entries: {
          actorId: string;
          action: string;
          field?: string;
          oldValue?: string;
          newValue?: string;
          createdAt: Date;
        }[] = [
          {
            actorId: uid(seed.reporter),
            action: seed.type === "BUG" ? "bug.created" : "issue.created",
            createdAt,
          },
        ];

        if (seed.assignee) {
          entries.push({
            actorId: uid(seed.reporter),
            action: "issue.updated",
            field: "assigneeId",
            oldValue: null as unknown as string,
            newValue: uid(seed.assignee),
            createdAt: daysAgo(Math.max(0, seed.createdDaysAgo - 1)),
          });
        }

        // Walk the workflow up to the seeded status so history reads honestly.
        const path: IssueStatus[] = [
          "BACKLOG",
          "TODO",
          "IN_PROGRESS",
          "IN_REVIEW",
          "DONE",
        ];
        const target = path.indexOf(seed.status);
        if (seed.status === "CANCELLED") {
          entries.push({
            actorId: uid(seed.reporter),
            action: "issue.updated",
            field: "status",
            oldValue: "BACKLOG",
            newValue: "CANCELLED",
            createdAt: daysAgo(Math.max(0, seed.createdDaysAgo - 3)),
          });
        } else if (target > 0) {
          for (let i = 1; i <= target; i += 1) {
            entries.push({
              actorId: seed.assignee ? uid(seed.assignee) : uid(seed.reporter),
              action: "issue.updated",
              field: "status",
              oldValue: path[i - 1]!,
              newValue: path[i]!,
              createdAt: daysAgo(
                Math.max(0, seed.createdDaysAgo - 1 - i),
                12 - i,
              ),
            });
          }
        }

        for (const entry of entries) {
          await prisma.activityLogEntry.create({
            data: {
              issueId,
              actorId: entry.actorId,
              action: entry.action,
              field: entry.field ?? null,
              oldValue: entry.oldValue ?? null,
              newValue: entry.newValue ?? null,
              createdAt: entry.createdAt,
            },
          });
          activityTotal += 1;
        }
      }

      // ---------------------------------------------------- comments
      const hasComments = await prisma.comment.count({ where: { issueId } });

      if (hasComments === 0 && seed.type === "BUG" && seed.assignee) {
        const reporterId = uid(seed.reporter);
        const assigneeId = uid(seed.assignee);

        const first = await prisma.comment.create({
          data: {
            issueId,
            authorId: reporterId,
            body: "Reproduced on a clean profile as well, so it is not cached state. Attaching the exact build in the environment section.",
            createdAt: daysAgo(Math.max(0, seed.createdDaysAgo - 1), 5),
          },
        });
        commentTotal += 1;

        const reply = await prisma.comment.create({
          data: {
            issueId,
            authorId: assigneeId,
            parentId: first.id,
            body: `Thanks — picking this up now. @${
              USERS.find((u) => u.email === seed.reporter)?.name ?? "team"
            } I will ping you once there is something to verify.`,
            createdAt: daysAgo(Math.max(0, seed.createdDaysAgo - 2), 2),
          },
        });
        commentTotal += 1;

        await prisma.commentMention.upsert({
          where: { commentId_userId: { commentId: reply.id, userId: reporterId } },
          update: {},
          create: { commentId: reply.id, userId: reporterId },
        });

        await prisma.activityLogEntry.createMany({
          data: [
            {
              issueId,
              actorId: reporterId,
              action: "comment.created",
              createdAt: first.createdAt,
            },
            {
              issueId,
              actorId: assigneeId,
              action: "comment.created",
              createdAt: reply.createdAt,
            },
          ],
        });
        activityTotal += 2;

        // ------------------------------------------- notifications
        await prisma.notification.create({
          data: {
            userId: reporterId,
            type: "MENTIONED",
            actorId: assigneeId,
            issueId,
            commentId: reply.id,
            message: `mentioned you on ${project.key}`,
            createdAt: reply.createdAt,
          },
        });
        await prisma.notification.create({
          data: {
            userId: assigneeId,
            type: "ISSUE_ASSIGNED",
            actorId: reporterId,
            issueId,
            message: `assigned a bug to you`,
            readAt: daysAgo(Math.max(0, seed.createdDaysAgo - 2)),
            createdAt: daysAgo(Math.max(0, seed.createdDaysAgo - 1)),
          },
        });
        notificationTotal += 2;
      }
    }

    // Parent links, applied after every issue in the project exists.
    for (const seed of ISSUES[projectSeed.key] ?? []) {
      if (!seed.parentTitle) continue;
      const childId = issueIdsByTitle.get(seed.title);
      const parentId = issueIdsByTitle.get(seed.parentTitle);
      if (childId && parentId) {
        await prisma.issue.update({
          where: { id: childId },
          data: { parentId },
        });
      }
    }

    if (sequence !== project.issueSequence) {
      await prisma.project.update({
        where: { id: project.id },
        data: { issueSequence: sequence },
      });
    }

    console.log(
      `  project ${projectSeed.key.padEnd(4)}        ${
        (ISSUES[projectSeed.key] ?? []).length
      } issues`,
    );
  }

  console.log(`
  issues              ${issueTotal} (${bugTotal} bugs)
  comments            ${commentTotal}
  activity entries    ${activityTotal}
  notifications       ${notificationTotal}

Sign in with:
  ${ADMIN_EMAIL}  /  ${ADMIN_PASSWORD}    (Admin)
  priya.nair@symbiosystech.com  /  ${DEFAULT_PASSWORD}    (Member)
`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (error) => {
    console.error("Seed failed:", error);
    await prisma.$disconnect();
    process.exit(1);
  });
