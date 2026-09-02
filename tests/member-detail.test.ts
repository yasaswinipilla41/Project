import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { AuthorizationError } from "@/lib/authz";
import type { CurrentUser } from "@/lib/session";
import { loadMemberDetail } from "@/server/queries/memberDetail";
import { getMemberDetail } from "@/server/users";
import { createIssue, updateIssue } from "@/server/issues";
import { actAs, deleteIssues, projectByKey } from "./helpers";

/**
 * The Admin Portal's member detail view (§ New Members → View details).
 *
 * Admin-only, and everything it returns must trace back to real rows —
 * assigned work, project membership and recent activity, not invented or
 * hardcoded figures.
 */

const created: string[] = [];

afterAll(async () => {
  await deleteIssues(created);
  await prisma.$disconnect();
});

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

describe("loadMemberDetail", () => {
  it("refuses a caller who is not an admin", async () => {
    const member = await userByEmail("priya.nair@symbiosystech.com");
    await expect(loadMemberDetail(member, member.id)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it("returns null for a member id that does not exist", async () => {
    const admin = await userByEmail("admin@symbiosystech.com");
    const detail = await loadMemberDetail(admin, "does-not-exist");
    expect(detail).toBeNull();
  });

  it("reports the member's real projects, assigned work and activity", async () => {
    const admin = await userByEmail("admin@symbiosystech.com");
    const project = await projectByKey("ENG");

    const membership = await prisma.projectMember.findFirstOrThrow({
      where: { projectId: project.id },
      select: { userId: true },
    });

    await actAs("admin@symbiosystech.com");
    const result = await createIssue({
      projectId: project.id,
      type: "TASK",
      title: "Member detail fixture",
      description: "Created by the integration suite.",
      status: "TODO",
      priority: "MEDIUM",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    created.push(result.data.id);

    await updateIssue({ issueId: result.data.id, assigneeId: membership.userId });

    const detail = await loadMemberDetail(admin, membership.userId);
    expect(detail).not.toBeNull();
    if (!detail) return;

    expect(detail.id).toBe(membership.userId);
    expect(detail.projects.map((p) => p.id)).toContain(project.id);
    expect(detail.assignedIssues.map((i) => i.id)).toContain(result.data.id);

    // Every assigned issue really is assigned to this person — no leakage
    // from another member's work.
    for (const issue of detail.assignedIssues) {
      const row = await prisma.issue.findUniqueOrThrow({
        where: { id: issue.id },
        select: { assigneeId: true },
      });
      expect(row.assigneeId).toBe(membership.userId);
    }

    // The candidate list for "Assign task / bug" never includes something
    // already assigned to them, and stays inside their own projects.
    const memberProjectIds = detail.projects.map((p) => p.id);
    for (const issue of detail.assignableIssues) {
      const row = await prisma.issue.findUniqueOrThrow({
        where: { id: issue.id },
        select: { assigneeId: true, projectId: true },
      });
      expect(row.assigneeId).not.toBe(membership.userId);
      expect(memberProjectIds).toContain(row.projectId);
    }
  });

  it("includes unassigned open issues as assignable, not just ones held by someone else", async () => {
    /*
     * Regression: `assigneeId: { not: memberId } }` alone silently drops every
     * unassigned issue too — SQL's `<> value` never matches NULL, so
     * "not already theirs" has to include `assigneeId: null` explicitly.
     */
    const admin = await userByEmail("admin@symbiosystech.com");
    const project = await projectByKey("ENG");

    const membership = await prisma.projectMember.findFirstOrThrow({
      where: { projectId: project.id },
      select: { userId: true },
    });

    await actAs("admin@symbiosystech.com");
    const result = await createIssue({
      projectId: project.id,
      type: "TASK",
      title: "Member detail — unassigned candidate fixture",
      description: "Created by the integration suite.",
      status: "TODO",
      /*
       * Urgent, so this fixture is inside the window the picker offers.
       *
       * `assignableIssues` is capped at fifty and ordered unassigned-first,
       * then by priority, then by recency. That is the intended contract --
       * the fifty most important things this person could be given -- and on a
       * database with more than fifty unassigned urgent issues in it, a
       * freshly created medium one is correctly absent. The claim being tested
       * is that unassigned work is offered at all, not that the cap does not
       * exist, so the fixture is made to belong in the window rather than the
       * window widened to admit it.
       */
      priority: "URGENT",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    created.push(result.data.id);

    const row = await prisma.issue.findUniqueOrThrow({
      where: { id: result.data.id },
      select: { assigneeId: true },
    });
    expect(row.assigneeId).toBeNull();

    const detail = await loadMemberDetail(admin, membership.userId);
    expect(detail?.assignableIssues.map((i) => i.id)).toContain(result.data.id);
  });

  it("only includes activity the member actually performed", async () => {
    const admin = await userByEmail("admin@symbiosystech.com");
    const kiran = await userByEmail("kiran.das@symbiosystech.com");

    const detail = await loadMemberDetail(admin, kiran.id);
    expect(detail).not.toBeNull();
    if (!detail) return;

    for (const entry of detail.recentActivity) {
      const row = await prisma.activityLogEntry.findUniqueOrThrow({
        where: { id: entry.id },
        select: { actorId: true },
      });
      expect(row.actorId).toBe(kiran.id);
    }
  });
});

describe("getMemberDetail (server action)", () => {
  it("returns ok:false for a member caller instead of throwing", async () => {
    await actAs("priya.nair@symbiosystech.com");
    const admin = await userByEmail("admin@symbiosystech.com");

    const result = await getMemberDetail(admin.id);
    expect(result.ok).toBe(false);
  });

  it("returns the member's detail for an admin caller", async () => {
    await actAs("admin@symbiosystech.com");
    const kiran = await userByEmail("kiran.das@symbiosystech.com");

    const result = await getMemberDetail(kiran.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.id).toBe(kiran.id);
    expect(result.data.email).toBe(kiran.email);
  });
});
