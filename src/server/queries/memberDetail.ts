import type { IssueStatus, IssueType, Priority, Role, Severity } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { assertAdmin } from "@/lib/authz";
import { OPEN_STATUSES } from "@/lib/domain";
import type { CurrentUser } from "@/lib/session";

/**
 * The Admin Portal's member detail view (§ New Members → View details).
 *
 * Admin-only, checked here rather than trusted from the caller — the same
 * discipline every other admin-scoped query in this codebase already
 * follows. Everything returned is either already shown elsewhere to an admin
 * (the `/admin` table, the org workload panel) or a narrower slice of it —
 * this does not expose anything a member's own data wouldn't already reveal
 * to an admin who opened their profile and their assigned work separately.
 */

export interface MemberDetailIssue {
  id: string;
  key: string;
  title: string;
  type: IssueType;
  status: IssueStatus;
  priority: Priority;
  severity: Severity | null;
  dueDate: Date | null;
  project: { key: string; name: string };
}

export interface MemberDetailActivity {
  id: string;
  action: string;
  field: string | null;
  createdAt: Date;
  issue: { key: string; title: string };
}

export interface MemberDetail {
  id: string;
  name: string;
  email: string;
  image: string | null;
  jobTitle: string | null;
  role: Role;
  isActive: boolean;
  createdAt: Date;
  projects: { id: string; key: string; name: string }[];
  assignedIssues: MemberDetailIssue[];
  /** Open issues in the member's own projects, not already theirs — the
   *  candidate list for "Assign task / bug". Bounded, not a full search. */
  assignableIssues: MemberDetailIssue[];
  recentActivity: MemberDetailActivity[];
}

const ISSUE_CARD_SELECT = {
  id: true,
  key: true,
  title: true,
  type: true,
  status: true,
  priority: true,
  severity: true,
  dueDate: true,
  project: { select: { key: true, name: true } },
} as const;

export async function loadMemberDetail(
  admin: CurrentUser,
  memberId: string,
): Promise<MemberDetail | null> {
  assertAdmin(admin);

  const user = await prisma.user.findUnique({
    where: { id: memberId },
    select: {
      id: true,
      name: true,
      email: true,
      image: true,
      jobTitle: true,
      role: true,
      isActive: true,
      createdAt: true,
    },
  });
  if (!user) return null;

  const memberships = await prisma.projectMember.findMany({
    where: { userId: memberId },
    select: { project: { select: { id: true, key: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });
  const projects = memberships.map((m) => m.project);
  const projectIds = projects.map((p) => p.id);

  const [assignedIssues, assignableIssues, recentActivity] = await Promise.all([
    prisma.issue.findMany({
      where: { assigneeId: memberId },
      select: ISSUE_CARD_SELECT,
      orderBy: [
        { priority: "asc" },
        { dueDate: { sort: "asc", nulls: "last" } },
        { updatedAt: "desc" },
      ],
      take: 20,
    }),
    projectIds.length === 0
      ? Promise.resolve([])
      : prisma.issue.findMany({
          where: {
            projectId: { in: projectIds },
            status: { in: [...OPEN_STATUSES] },
            // `assigneeId: { not: memberId }` alone would silently drop every
            // unassigned issue too: SQL's `<> value` never matches NULL, so
            // "not already theirs" has to say "unassigned, or someone else's"
            // explicitly rather than relying on `not` to cover both.
            OR: [{ assigneeId: null }, { assigneeId: { not: memberId } }],
          },
          select: ISSUE_CARD_SELECT,
          orderBy: { updatedAt: "desc" },
          take: 50,
        }),
    prisma.activityLogEntry.findMany({
      where: { actorId: memberId },
      select: {
        id: true,
        action: true,
        field: true,
        createdAt: true,
        issue: { select: { key: true, title: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
  ]);

  return { ...user, projects, assignedIssues, assignableIssues, recentActivity };
}
