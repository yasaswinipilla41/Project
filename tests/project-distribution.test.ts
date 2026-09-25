import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { loadDashboard } from "@/server/queries/dashboard";
import { accessibleProjectIds } from "@/lib/authz";
import {
  distributionCategoryFor,
  distributionTotal,
} from "@/lib/statusDistribution";
import type { CurrentUser } from "@/lib/session";
import { holdWorkRole } from "./helpers";

/**
 * The four-way breakdown Home draws beside each project's progress bar.
 *
 * The arithmetic itself is pinned by `status-distribution.test.ts`, which
 * needs no database. What is asserted here is the part only a real query can
 * answer: that the breakdown is a reading of the rows the viewer may actually
 * see, that it counts each of them exactly once, and that who is looking
 * changes *which* work is counted without changing what any of it means.
 *
 * Nothing here writes issues. Work-role fixtures put their rosters back.
 */

const ADMIN = "admin@symbiosystech.com";
const MEMBER = "priya.nair@symbiosystech.com";

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

const undoRoles: Array<() => Promise<void>> = [];

afterAll(async () => {
  for (const undo of undoRoles) await undo();
});

describe("counting each work item exactly once", () => {
  it("adds the four groups back up to the project's own total", async () => {
    const admin = await userByEmail(ADMIN);
    const data = await loadDashboard(admin);

    expect(data.projects.length).toBeGreaterThan(0);

    for (const project of data.projects) {
      expect(
        distributionTotal(project.distribution),
        `${project.key} breakdown must total its issue count`,
      ).toBe(project.total);
    }
  });

  /*
   * The dashboard groups by project, status and type at once, so a single
   * status arrives as several rows. This is the check that those rows were
   * added rather than overwriting one another — it counts the same issues a
   * second way, straight from the table, and the two have to agree.
   */
  it("matches an independent count of the same rows", async () => {
    const admin = await userByEmail(ADMIN);
    const data = await loadDashboard(admin);

    const project = data.projects.find((candidate) => candidate.total > 0);
    expect(project, "seed data should contain a project with issues").toBeTruthy();

    const rows = await prisma.issue.findMany({
      where: { projectId: project!.id },
      select: { status: true },
    });

    const expected = { completed: 0, inProgress: 0, notStarted: 0, other: 0 };
    for (const row of rows) expected[distributionCategoryFor(row.status)] += 1;

    expect(project!.distribution).toEqual(expected);
    expect(rows.length).toBe(project!.total);
  });

  it("reads a project with no work as four zeroes", async () => {
    const admin = await userByEmail(ADMIN);
    const data = await loadDashboard(admin);

    for (const project of data.projects) {
      if (project.total !== 0) continue;
      expect(project.distribution).toEqual({
        completed: 0,
        inProgress: 0,
        notStarted: 0,
        other: 0,
      });
    }
  });
});

describe("who is looking", () => {
  /*
   * The property that matters: a role decides which projects and issues are
   * in the dataset, and nothing else. A member's breakdown of a project they
   * share with an administrator has to be the same breakdown — anything else
   * would mean a status meant something different depending on who asked.
   */
  it("shows a member only projects they may open", async () => {
    const member = await userByEmail(MEMBER);
    const data = await loadDashboard(member);
    const allowed = new Set(await accessibleProjectIds(member));

    expect(data.projects.length).toBeGreaterThan(0);
    for (const project of data.projects) {
      expect(allowed.has(project.id), `${project.key} must be visible`).toBe(true);
    }
  });

  it("never lets a member's figures exceed what they can see", async () => {
    const member = await userByEmail(MEMBER);
    const data = await loadDashboard(member);
    const allowed = await accessibleProjectIds(member);

    const visible = await prisma.issue.count({
      where: { projectId: { in: allowed } },
    });
    const counted = data.projects.reduce(
      (sum, project) => sum + distributionTotal(project.distribution),
      0,
    );

    expect(counted).toBeLessThanOrEqual(visible);
  });

  it("classifies the same project identically for every role", async () => {
    const admin = await userByEmail(ADMIN);
    const adminData = await loadDashboard(admin);

    const roles = ["DEVELOPER", "QA", "FULLSTACK"] as const;
    const seen: Array<Record<string, unknown>> = [];

    for (const role of roles) {
      const fixture = await holdWorkRole(MEMBER, role);
      undoRoles.push(fixture.leave);

      const member = await userByEmail(MEMBER);
      const data = await loadDashboard(member);

      /* A project the member can see, compared against the administrator's
         reading of the very same project. */
      for (const project of data.projects) {
        const asAdmin = adminData.projects.find((p) => p.id === project.id);
        if (!asAdmin) continue;
        expect(
          project.distribution,
          `${project.key} must read the same for ${role} as for an admin`,
        ).toEqual(asAdmin.distribution);
      }

      seen.push({ role, projects: data.projects.length });
      await fixture.leave();
      undoRoles.pop();
    }

    expect(seen).toHaveLength(roles.length);
  });
});
