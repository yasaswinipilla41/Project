import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { issueScope } from "@/lib/authz";
import { OPEN_STATUSES } from "@/lib/domain";
import type { CurrentUser } from "@/lib/session";
import { createIssue, updateIssue } from "@/server/issues";
import { loadDashboard } from "@/server/queries/dashboard";
import { actAs, deleteIssues, projectByKey } from "./helpers";

/**
 * "My Work" must show an issue the moment somebody else assigns it.
 *
 * The page itself is `force-dynamic` and reads straight from PostgreSQL, so
 * the only way it can go stale is if the *data* is wrong — the assignment not
 * persisted, the wrong user id stored, or the issue falling outside the
 * viewer's project scope. These tests reproduce the exact query
 * `src/app/(app)/my-work/page.tsx` runs, immediately after a real
 * `updateIssue` assignment, so a failure here points at the real layer rather
 * than at a suspected cache.
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

/** Exactly the query the My Work page runs for its "assigned" list. */
async function myWorkAssigned(user: CurrentUser) {
  return prisma.issue.findMany({
    where: {
      ...issueScope(user),
      assigneeId: user.id,
      status: { in: [...OPEN_STATUSES] },
    },
    orderBy: [{ priority: "asc" }, { dueDate: { sort: "asc", nulls: "last" } }],
    select: { id: true, key: true, status: true },
  });
}

describe("My Work reflects a new assignment", () => {
  it("shows an issue an admin just assigned, with no second write or refresh step", async () => {
    const member = await userByEmail("priya.nair@symbiosystech.com");
    const project = await projectByKey("ENG");

    await actAs("admin@symbiosystech.com");
    const result = await createIssue({
      projectId: project.id,
      type: "TASK",
      title: "My Work refresh fixture",
      description: "Created by the integration suite.",
      status: "TODO",
      priority: "MEDIUM",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    created.push(result.data.id);

    // Not assigned yet: it must not be in the member's list.
    const before = await myWorkAssigned(member);
    expect(before.map((i) => i.id)).not.toContain(result.data.id);

    const assign = await updateIssue({
      issueId: result.data.id,
      assigneeId: member.id,
    });
    expect(assign.ok).toBe(true);

    // The assignment really landed on the right person, in the database.
    const row = await prisma.issue.findUniqueOrThrow({
      where: { id: result.data.id },
      select: { assigneeId: true },
    });
    expect(row.assigneeId).toBe(member.id);

    // ...and the page's own query picks it up immediately.
    const after = await myWorkAssigned(member);
    expect(after.map((i) => i.id)).toContain(result.data.id);
  });

  it("keeps showing it on every subsequent read — it is not a one-shot", async () => {
    const member = await userByEmail("kiran.das@symbiosystech.com");
    const project = await projectByKey("ENG");

    await actAs("admin@symbiosystech.com");
    const result = await createIssue({
      projectId: project.id,
      type: "TASK",
      title: "My Work persistence fixture",
      description: "Created by the integration suite.",
      status: "TODO",
      priority: "MEDIUM",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    created.push(result.data.id);

    await updateIssue({ issueId: result.data.id, assigneeId: member.id });

    // Three independent reads stand in for refresh / logout / log back in:
    // the page holds no state of its own, so a fresh query is exactly what
    // each of those produces.
    for (let read = 0; read < 3; read += 1) {
      const rows = await myWorkAssigned(member);
      expect(rows.map((i) => i.id)).toContain(result.data.id);
    }
  });

  it("a reassignment away from someone removes it from their list", async () => {
    const first = await userByEmail("priya.nair@symbiosystech.com");
    const second = await userByEmail("kiran.das@symbiosystech.com");
    const project = await projectByKey("ENG");

    await actAs("admin@symbiosystech.com");
    const result = await createIssue({
      projectId: project.id,
      type: "TASK",
      title: "My Work reassignment fixture",
      description: "Created by the integration suite.",
      status: "TODO",
      priority: "MEDIUM",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    created.push(result.data.id);

    await updateIssue({ issueId: result.data.id, assigneeId: first.id });
    expect((await myWorkAssigned(first)).map((i) => i.id)).toContain(
      result.data.id,
    );

    await updateIssue({ issueId: result.data.id, assigneeId: second.id });

    expect((await myWorkAssigned(first)).map((i) => i.id)).not.toContain(
      result.data.id,
    );
    expect((await myWorkAssigned(second)).map((i) => i.id)).toContain(
      result.data.id,
    );
  });
});

describe("the dashboard's capped assigned list", () => {
  const localCreated: string[] = [];

  afterAll(async () => {
    await deleteIssues(localCreated);
  });

  it("surfaces a new low-priority assignment even when higher-priority work fills the list", async () => {
    /*
     * The real defect this fixes. "My assigned tasks" takes 8, ordered by
     * priority — so for someone already carrying a full page of URGENT work,
     * a newly assigned LOW issue sorted off the end and looked like the
     * assignment had silently failed. The seeded member here has >8 open
     * items precisely so this reproduces rather than passing by luck.
     */
    const member = await userByEmail("priya.nair@symbiosystech.com");
    const project = await projectByKey("ENG");

    const openCount = await prisma.issue.count({
      where: {
        assigneeId: member.id,
        status: { in: [...OPEN_STATUSES] },
      },
    });
    expect(
      openCount,
      "this member must already have more open work than the dashboard shows",
    ).toBeGreaterThan(8);

    await actAs("admin@symbiosystech.com");
    const result = await createIssue({
      projectId: project.id,
      type: "TASK",
      title: "Lowest-priority new assignment fixture",
      description: "Created by the integration suite.",
      status: "TODO",
      priority: "LOW",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    localCreated.push(result.data.id);

    await updateIssue({ issueId: result.data.id, assigneeId: member.id });

    const data = await loadDashboard(member);
    const shown = data.assigned.find((i) => i.id === result.data.id);

    expect(
      shown,
      "a brand-new assignment must be visible even below the priority cut-off",
    ).toBeDefined();
    expect(shown?.isNewAssignment).toBe(true);
    // …and it leads, because it is the thing the person does not yet know about.
    expect(data.assigned[0]?.id).toBe(result.data.id);
  });
});
