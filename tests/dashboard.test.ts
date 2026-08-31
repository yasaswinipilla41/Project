import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { accessibleProjectIds } from "@/lib/authz";
import { CLOSED_STATUSES, OPEN_STATUSES } from "@/lib/domain";
import type { CurrentUser } from "@/lib/session";
import { loadDashboard } from "@/server/queries/dashboard";
import { createIssue, updateIssue } from "@/server/issues";
import { markNotificationRead } from "@/server/notifications";
import { actAs, deleteIssues, projectByKey } from "./helpers";

/**
 * The dashboard's contract is that every figure on it is real: an aggregate
 * over rows the signed-in person is actually allowed to see.
 *
 * So these tests never assert a literal like `expect(kpi.openIssues).toBe(14)`
 * — that would only prove the seed has not changed. Each one recomputes the
 * figure independently, with a different query than the one under test, and
 * asserts the two agree. If `loadDashboard` ever starts padding, guessing or
 * leaking across a project boundary, the two answers diverge and the test
 * fails.
 */

const open = { in: [...OPEN_STATUSES] };

afterAll(async () => {
  await prisma.$disconnect();
});

/** The dashboard takes a `CurrentUser`; read the authoritative row for one. */
async function userByEmail(email: string): Promise<CurrentUser> {
  return prisma.user.findUniqueOrThrow({
    where: { email },
    select: {
      id: true,
      name: true,
      email: true,
      image: true,
      role: true,
      jobTitle: true,
      isActive: true,
    },
  });
}

async function anAdmin(): Promise<CurrentUser> {
  const row = await prisma.user.findFirstOrThrow({
    where: { role: "ADMIN", isActive: true },
    select: { email: true },
    orderBy: { createdAt: "asc" },
  });
  return userByEmail(row.email);
}

/** A member who belongs to at least one project — the ordinary case. */
async function aMemberWithProjects(): Promise<CurrentUser> {
  const row = await prisma.user.findFirstOrThrow({
    where: { role: "MEMBER", isActive: true, projectMemberships: { some: {} } },
    select: { email: true },
    orderBy: { createdAt: "asc" },
  });
  return userByEmail(row.email);
}

describe("loadDashboard — scope", () => {
  it("aggregates only over projects the person can reach", async () => {
    const member = await aMemberWithProjects();
    const data = await loadDashboard(member);

    const allowed = await accessibleProjectIds(member);
    expect([...data.scope.projectIds].sort()).toEqual([...allowed].sort());

    // Everything surfaced must sit inside that scope — no cross-project leak.
    const surfaced = [...data.assigned, ...data.important].map((i) => i.id);
    if (surfaced.length > 0) {
      const outside = await prisma.issue.count({
        where: { id: { in: surfaced }, projectId: { notIn: allowed } },
      });
      expect(outside).toBe(0);
    }

    expect(data.projects.map((p) => p.id).sort()).toEqual([...allowed].sort());
  });

  it("gives an admin the org-wide panel and a member none", async () => {
    const adminData = await loadDashboard(await anAdmin());
    const memberData = await loadDashboard(await aMemberWithProjects());

    expect(adminData.scope.isAdmin).toBe(true);
    expect(adminData.org).not.toBeNull();

    expect(memberData.scope.isAdmin).toBe(false);
    // The org panel is the one place with organization-wide counts. A member
    // must not receive it at all — not even zeroed, which would still be a
    // shape the client could probe.
    expect(memberData.org).toBeNull();

    // `newUsers` follows the same admin-only rule as `org`.
    expect(adminData.newUsers).not.toBeNull();
    expect(memberData.newUsers).toBeNull();
  });
});

describe("loadDashboard — new users", () => {
  it("lists recently created accounts, newest first, matching an independent query", async () => {
    const data = await loadDashboard(await anAdmin());
    expect(data.newUsers).not.toBeNull();
    if (!data.newUsers) return;

    const since = new Date();
    since.setDate(since.getDate() - 14);
    const expected = await prisma.user.findMany({
      where: { createdAt: { gte: since } },
      select: { id: true },
      orderBy: { createdAt: "desc" },
      take: 10,
    });

    expect(data.newUsers.map((u) => u.id)).toEqual(expected.map((u) => u.id));

    const times = data.newUsers.map((u) => u.createdAt.getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("picks up a person the moment they exist, with no separate step", async () => {
    const stranger = await prisma.user.create({
      data: {
        name: "Dashboard New User Fixture",
        email: `dashboard-newuser-${Date.now()}@symbiosystech.local`,
        role: "MEMBER",
        isActive: true,
      },
      select: { id: true },
    });

    try {
      const data = await loadDashboard(await anAdmin());
      expect(data.newUsers?.map((u) => u.id)).toContain(stranger.id);
    } finally {
      await prisma.user.delete({ where: { id: stranger.id } });
    }
  });
});

describe("loadDashboard — team members", () => {
  it("is visible to a member, not just an admin, and scoped to their own projects", async () => {
    const member = await aMemberWithProjects();
    const data = await loadDashboard(member);
    const allowed = await accessibleProjectIds(member);

    // Every teammate must actually share one of the viewer's own projects —
    // never someone reachable only from a project the viewer cannot see.
    for (const teammate of data.teamMembers) {
      const shared = await prisma.projectMember.count({
        where: { userId: teammate.id, projectId: { in: allowed } },
      });
      expect(shared).toBeGreaterThan(0);
      expect(teammate.isActive).toBe(true);
    }

    // Independently recompute who should be on the list and compare sets —
    // not just "non-empty", but the exact membership.
    const expected = await prisma.user.findMany({
      where: {
        isActive: true,
        projectMemberships: { some: { projectId: { in: allowed } } },
      },
      select: { id: true },
      take: 24,
      orderBy: { name: "asc" },
    });
    expect(data.teamMembers.map((t) => t.id).sort()).toEqual(
      expected.map((u) => u.id).sort(),
    );
  });

  it("counts each teammate's open work only within the viewer's own scope", async () => {
    const admin = await anAdmin();
    const data = await loadDashboard(admin);

    for (const teammate of data.teamMembers) {
      const expectedOpen = await prisma.issue.count({
        where: {
          projectId: { in: data.scope.projectIds },
          assigneeId: teammate.id,
          status: open,
        },
      });
      expect(teammate.openInScope).toBe(expectedOpen);
    }
  });

  it("never carries the admin-only aggregate fields a member must not receive", async () => {
    const memberData = await loadDashboard(await aMemberWithProjects());

    /* The team list is deliberately narrower than `org.workload` — a name,
       avatar, role, active flag, a single in-scope count, and whether the row
       is the viewer's own. `isYou` is derived from the viewer's own id, so it
       tells them nothing about anyone else; the pin stays exact so anything
       genuinely cross-user still fails here. */
    for (const teammate of memberData.teamMembers) {
      expect(Object.keys(teammate).sort()).toEqual(
        ["id", "image", "isActive", "isYou", "name", "openInScope", "role"].sort(),
      );
    }
  });
});

describe("loadDashboard — every figure is the real count", () => {
  it("matches independently computed KPI counts", async () => {
    const user = await anAdmin();
    const data = await loadDashboard(user);
    const scope = { projectId: { in: data.scope.projectIds } };

    const [openIssues, openBugs, inProgress, completed, highPriorityOpen] =
      await Promise.all([
        prisma.issue.count({ where: { ...scope, status: open } }),
        prisma.issue.count({ where: { ...scope, type: "BUG", status: open } }),
        prisma.issue.count({ where: { ...scope, status: "IN_PROGRESS" } }),
        prisma.issue.count({ where: { ...scope, status: "DONE" } }),
        prisma.issue.count({
          where: {
            ...scope,
            status: open,
            priority: { in: ["URGENT", "HIGH"] },
          },
        }),
      ]);

    expect(data.kpi.openIssues).toBe(openIssues);
    expect(data.kpi.openBugs).toBe(openBugs);
    expect(data.kpi.inProgress).toBe(inProgress);
    expect(data.kpi.completed).toBe(completed);
    expect(data.kpi.highPriorityOpen).toBe(highPriorityOpen);
    expect(data.kpi.projects).toBe(data.scope.projectIds.length);
  });

  it("matches the person's own queue", async () => {
    const user = await aMemberWithProjects();
    const data = await loadDashboard(user);
    const mine = {
      projectId: { in: data.scope.projectIds },
      assigneeId: user.id,
    };

    const [assigned, inProgress, review, completed, reported] =
      await Promise.all([
        prisma.issue.count({ where: { ...mine, status: open } }),
        prisma.issue.count({ where: { ...mine, status: "IN_PROGRESS" } }),
        prisma.issue.count({ where: { ...mine, status: "IN_REVIEW" } }),
        prisma.issue.count({
          where: { ...mine, status: { in: [...CLOSED_STATUSES] } },
        }),
        prisma.issue.count({
          where: {
            projectId: { in: data.scope.projectIds },
            reporterId: user.id,
          },
        }),
      ]);

    expect(data.myWork.assigned).toBe(assigned);
    expect(data.myWork.inProgress).toBe(inProgress);
    expect(data.myWork.review).toBe(review);
    expect(data.myWork.completed).toBe(completed);
    expect(data.myWork.reported).toBe(reported);
  });

  it("distributes issues without inventing or losing any", async () => {
    const data = await loadDashboard(await anAdmin());
    const scope = { projectId: { in: data.scope.projectIds } };

    const total = await prisma.issue.count({ where: scope });
    const byStatus = Object.values(data.byStatus).reduce((s, n) => s + n, 0);
    const byType = Object.values(data.byType).reduce((s, n) => s + n, 0);

    // Status and type partition the same set, so both must sum to the whole.
    expect(byStatus).toBe(total);
    expect(byType).toBe(total);

    // Priority is deliberately open-issues-only; it must sum to that instead.
    const byPriority = Object.values(data.byPriority).reduce((s, n) => s + n, 0);
    expect(byPriority).toBe(
      await prisma.issue.count({ where: { ...scope, status: open } }),
    );
  });

  it("rolls each project up to the same totals the project itself reports", async () => {
    const data = await loadDashboard(await anAdmin());

    for (const project of data.projects) {
      const [total, projectOpen, done, bugs, openBugs, members] =
        await Promise.all([
          prisma.issue.count({ where: { projectId: project.id } }),
          prisma.issue.count({
            where: { projectId: project.id, status: open },
          }),
          prisma.issue.count({
            where: { projectId: project.id, status: "DONE" },
          }),
          prisma.issue.count({ where: { projectId: project.id, type: "BUG" } }),
          prisma.issue.count({
            where: { projectId: project.id, type: "BUG", status: open },
          }),
          prisma.projectMember.count({ where: { projectId: project.id } }),
        ]);

      expect(project.total).toBe(total);
      expect(project.open).toBe(projectOpen);
      expect(project.done).toBe(done);
      expect(project.bugs).toBe(bugs);
      expect(project.openBugs).toBe(openBugs);
      expect(project.members).toBe(members);

      // Done can never exceed the total, so a progress bar can never overrun.
      expect(project.done).toBeLessThanOrEqual(project.total);
    }
  });

  it("derives project health from overdue work and open bugs, nothing else", async () => {
    const data = await loadDashboard(await anAdmin());

    for (const project of data.projects) {
      const expected =
        project.overdue >= 3 || project.openBugs >= 5
          ? "at-risk"
          : project.overdue > 0 || project.openBugs >= 2
            ? "attention"
            : "healthy";

      expect(project.health).toBe(expected);
    }
  });

  it("buckets due dates without double-counting", async () => {
    const user = await anAdmin();
    const data = await loadDashboard(user);
    const mine = {
      projectId: { in: data.scope.projectIds },
      assigneeId: user.id,
      status: open,
    };

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const overdue = await prisma.issue.count({
      where: { ...mine, dueDate: { lt: startOfToday } },
    });

    expect(data.due.overdue).toBe(overdue);

    // The three buckets are disjoint windows over the same set, so their sum
    // can never exceed the number of dated open items assigned to the person.
    const dated = await prisma.issue.count({
      where: { ...mine, dueDate: { not: null } },
    });
    expect(data.due.overdue + data.due.today + data.due.thisWeek)
      .toBeLessThanOrEqual(dated);
  });

  it("shows only real, open, assigned work in the assigned list", async () => {
    const user = await aMemberWithProjects();
    const data = await loadDashboard(user);

    for (const issue of data.assigned) {
      const row = await prisma.issue.findUniqueOrThrow({
        where: { id: issue.id },
        select: { assigneeId: true, status: true, key: true, title: true },
      });

      expect(row.assigneeId).toBe(user.id);
      expect((OPEN_STATUSES as readonly string[])).toContain(row.status);
      expect(issue.key).toBe(row.key);
      expect(issue.title).toBe(row.title);
    }

    // The list is capped for the page; the count beside it is the true total.
    expect(data.assigned.length).toBeLessThanOrEqual(data.myWork.assigned);
  });

  it("reports sub-issue progress only where sub-issues exist", async () => {
    const data = await loadDashboard(await anAdmin());

    for (const issue of [...data.assigned, ...data.important]) {
      const children = await prisma.issue.count({
        where: { parentId: issue.id },
      });

      if (children === 0) {
        expect(issue.progress).toBeNull();
      } else {
        expect(issue.progress?.total).toBe(children);
        expect(issue.progress!.done).toBeLessThanOrEqual(children);
      }
    }
  });

  it("reads activity from the real trail, newest first", async () => {
    const data = await loadDashboard(await anAdmin());

    for (const entry of data.activity) {
      const row = await prisma.activityLogEntry.findUniqueOrThrow({
        where: { id: entry.id },
        select: { action: true, createdAt: true },
      });
      expect(entry.action).toBe(row.action);
      expect(entry.createdAt.getTime()).toBe(row.createdAt.getTime());
    }

    const times = data.activity.map((a) => a.createdAt.getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });
});

describe("loadDashboard — nothing to show", () => {
  it("returns a well-formed empty shape rather than fabricating data", async () => {
    /*
     * A real account with no project membership. Created and removed here so
     * the case is exercised even when the seed has no such person — the empty
     * state is what a newly invited colleague sees on their first sign-in.
     */
    const stranger = await prisma.user.create({
      data: {
        name: "Dashboard Empty State",
        email: `dashboard-empty-${Date.now()}@symbiosystech.local`,
        role: "MEMBER",
        isActive: true,
      },
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
        role: true,
        jobTitle: true,
        isActive: true,
      },
    });

    try {
      const data = await loadDashboard(stranger);

      expect(data.scope.projectIds).toEqual([]);
      expect(data.kpi.projects).toBe(0);
      expect(data.kpi.openIssues).toBe(0);
      expect(data.myWork.assigned).toBe(0);
      expect(data.assigned).toEqual([]);
      expect(data.important).toEqual([]);
      expect(data.projects).toEqual([]);
      expect(data.teamMembers).toEqual([]);
      expect(data.activity).toEqual([]);
      expect(data.byStatus).toEqual({});
      expect(data.org).toBeNull();
      expect(data.newUsers).toBeNull();
      expect(data.qa).toBeNull();
    } finally {
      await prisma.user.delete({ where: { id: stranger.id } });
    }
  });
});

describe("loadDashboard — new assignment highlight", () => {
  const created: string[] = [];

  afterAll(async () => {
    await deleteIssues(created);
  });

  it("marks a freshly assigned issue as new, until the notification is read", async () => {
    await actAs("admin@symbiosystech.com");
    const project = await projectByKey("ENG");

    // Must be a MEMBER, not the acting admin — `notify()` never notifies the
    // actor about their own action, so picking the admin's own membership row
    // here (they are often a project member too) would make this flaky.
    const membership = await prisma.projectMember.findFirstOrThrow({
      where: { projectId: project.id, user: { role: "MEMBER" } },
      select: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
            role: true,
            jobTitle: true,
            isActive: true,
          },
        },
      },
    });
    const member = membership.user;

    // Urgent, so it sorts to the very top of the capped "assigned" list
    // regardless of how much other open work this member already has.
    const result = await createIssue({
      projectId: project.id,
      type: "TASK",
      title: "Dashboard new-assignment highlight fixture",
      description: "Created by the integration suite.",
      status: "TODO",
      priority: "URGENT",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    created.push(result.data.id);

    const assign = await updateIssue({
      issueId: result.data.id,
      assigneeId: member.id,
    });
    expect(assign.ok).toBe(true);

    const beforeRead = await loadDashboard(member);
    const found = beforeRead.assigned.find((i) => i.id === result.data.id);
    expect(found).toBeDefined();
    expect(found?.isNewAssignment).toBe(true);

    const notification = await prisma.notification.findFirstOrThrow({
      where: { userId: member.id, issueId: result.data.id, type: "ISSUE_ASSIGNED" },
      select: { id: true },
    });

    await actAs(member.email);
    const marked = await markNotificationRead(notification.id, true);
    expect(marked.ok).toBe(true);

    const afterRead = await loadDashboard(member);

    /*
     * Reading the notification drops the "new" flag. The issue then takes its
     * ordinary place in the priority-ordered preview, which for a busy member
     * may be past the cut-off — so the assertion is that it is no longer
     * *flagged*, not that it is still on screen. It is still assigned either
     * way, which is checked directly rather than inferred from the preview.
     */
    expect(
      afterRead.assigned.filter((i) => i.isNewAssignment).map((i) => i.id),
    ).not.toContain(result.data.id);

    const foundAfter = afterRead.assigned.find((i) => i.id === result.data.id);
    if (foundAfter) expect(foundAfter.isNewAssignment).toBe(false);

    const stillAssigned = await prisma.issue.findUniqueOrThrow({
      where: { id: result.data.id },
      select: { assigneeId: true },
    });
    expect(stillAssigned.assigneeId).toBe(member.id);
  });
});
