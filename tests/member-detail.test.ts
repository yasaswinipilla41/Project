import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { AuthorizationError } from "@/lib/authz";
import type { CurrentUser } from "@/lib/session";
import { loadMemberDetail } from "@/server/queries/memberDetail";
import { getMemberDetail } from "@/server/users";
import { createIssue } from "@/server/issues";
import { actAs, deleteIssues, joinProject, projectByKey } from "./helpers";

/**
 * The Admin Portal's member detail view (§ New Members → View details).
 *
 * Admin-only, and everything it returns must trace back to real rows —
 * assigned work, project membership and recent activity, not invented or
 * hardcoded figures.
 *
 * The member is named rather than discovered. This suite used to take whichever
 * row `findFirstOrThrow` happened to return for the project, which is insertion
 * order — so *which person* was being examined changed as other suites added and
 * removed memberships, and with them how much work that person was holding.
 * That matters because `assignedIssues` is capped at twenty and ordered by
 * priority, then due date, then recency: a fixture that sorts below twenty other
 * issues is correctly absent, and the assertion fails for a reason that has
 * nothing to do with the view being tested.
 */

const ADMIN_EMAIL = "admin@symbiosystech.com";
/** The member examined throughout — a MEMBER account, on the project below. */
const MEMBER_EMAIL = "kiran.das@symbiosystech.com";

/**
 * Earlier than any real due date.
 *
 * `assignedIssues` orders by priority, then due date ascending with undated
 * work last. An Urgent issue dated here therefore sorts above everything the
 * member already holds, which is what puts the fixture provably inside the
 * twenty rows the view returns — rather than hoping it lands there.
 */
const EARLIEST_DUE = "1970-01-02";

const created: string[] = [];
const undo: (() => Promise<void>)[] = [];

beforeAll(async () => {
  /* The access half of what the view reports, made true rather than assumed. */
  undo.push((await joinProject("ENG", MEMBER_EMAIL)).leave);
});

afterAll(async () => {
  await deleteIssues(created);
  for (const leave of undo.reverse()) await leave();
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
    const admin = await userByEmail(ADMIN_EMAIL);
    const member = await userByEmail(MEMBER_EMAIL);
    const project = await projectByKey("ENG");

    await actAs(ADMIN_EMAIL);
    const result = await createIssue({
      projectId: project.id,
      type: "TASK",
      title: `Member detail fixture ${Date.now()}`,
      description: "Created by the integration suite.",
      status: "TODO",
      /* Urgent and dated earlier than anything real, so the fixture is inside
         the twenty rows the view returns however much this member is already
         holding — see `EARLIEST_DUE`. Assigned in the same call, and the
         result checked: an assignment that quietly failed would surface as a
         confusing absence three assertions later. */
      priority: "URGENT",
      dueDate: EARLIEST_DUE,
      assigneeId: member.id,
    });
    expect(result.ok, result.ok ? "" : result.error).toBe(true);
    if (!result.ok) return;
    created.push(result.data.id);

    const detail = await loadMemberDetail(admin, member.id);
    expect(detail).not.toBeNull();
    if (!detail) return;

    expect(detail.id).toBe(member.id);
    expect(detail.projects.map((p) => p.id)).toContain(project.id);
    expect(detail.assignedIssues.map((i) => i.id)).toContain(result.data.id);

    // Every assigned issue really is assigned to this person — no leakage
    // from another member's work.
    for (const issue of detail.assignedIssues) {
      const row = await prisma.issue.findUniqueOrThrow({
        where: { id: issue.id },
        select: { assigneeId: true },
      });
      expect(row.assigneeId).toBe(member.id);
    }

    // The candidate list for "Assign task / bug" never includes something
    // already assigned to them, and stays inside their own projects.
    const memberProjectIds = detail.projects.map((p) => p.id);
    for (const issue of detail.assignableIssues) {
      const row = await prisma.issue.findUniqueOrThrow({
        where: { id: issue.id },
        select: { assigneeId: true, projectId: true },
      });
      expect(row.assigneeId).not.toBe(member.id);
      expect(memberProjectIds).toContain(row.projectId);
    }
  });

  it("includes unassigned open issues as assignable, not just ones held by someone else", async () => {
    /*
     * Regression: `assigneeId: { not: memberId } }` alone silently drops every
     * unassigned issue too — SQL's `<> value` never matches NULL, so
     * "not already theirs" has to include `assigneeId: null` explicitly.
     */
    const admin = await userByEmail(ADMIN_EMAIL);
    const member = await userByEmail(MEMBER_EMAIL);
    const project = await projectByKey("ENG");

    await actAs(ADMIN_EMAIL);
    const result = await createIssue({
      projectId: project.id,
      type: "TASK",
      title: `Member detail — unassigned candidate fixture ${Date.now()}`,
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

    const detail = await loadMemberDetail(admin, member.id);
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
