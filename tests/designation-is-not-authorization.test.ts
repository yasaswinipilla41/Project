import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProjectDesignation } from "@prisma/client";
import { workRoleOf } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { createIssue } from "@/server/issues";
import { createSprint } from "@/server/sprints";
import { actAs, holdWorkRole, joinProject, projectByKey } from "./helpers";

/**
 * Hiding Create did not move authorization into the browser.
 *
 * The header now reads a project's designation and stops offering Create to a
 * developer. That is a statement about a menu and nothing else: the server
 * decides what may be raised, from the work role it derives itself, exactly as
 * it did before the header learned anything.
 *
 * Two ways that could have gone wrong are pinned here. The first is the server
 * quietly copying the new rule, which would turn a tidier menu into a lost
 * capability for everybody calling the action directly. The second is the
 * designation being treated as a role — a project calling somebody QA does not
 * make them one, and must not let them do what only a tester or only an
 * administrator may.
 */

const DEVELOPER = "kiran.das@symbiosystech.com";

let projectId = "";
let developerId = "";
const restore: (() => Promise<void>)[] = [];
const raised: string[] = [];

/** Sets what this project calls somebody, and hands back the undo. */
async function designate(designation: ProjectDesignation | null) {
  await prisma.projectMember.update({
    where: { projectId_userId: { projectId, userId: developerId } },
    data: { designation },
  });
}

beforeAll(async () => {
  projectId = (await projectByKey("ENG")).id;

  const held = await holdWorkRole(DEVELOPER, "DEVELOPER");
  developerId = held.userId;
  restore.push(held.leave);

  const joined = await joinProject("ENG", DEVELOPER);
  restore.push(joined.leave);

  const before = await prisma.projectMember.findUniqueOrThrow({
    where: { projectId_userId: { projectId, userId: developerId } },
    select: { designation: true },
  });
  restore.push(() => designate(before.designation));
});

afterAll(async () => {
  if (raised.length > 0) {
    await prisma.notification.deleteMany({ where: { issueId: { in: raised } } });
    await prisma.activityLogEntry.deleteMany({
      where: { issueId: { in: raised } },
    });
    await prisma.issue.deleteMany({ where: { id: { in: raised } } });
  }
  for (const undo of restore.reverse()) await undo();
  await prisma.$disconnect();
});

describe("what the server does with a designation", () => {
  it("still lets a developer raise work, menu or no menu", async () => {
    /* The very case the header now hides. The action a browser calls is
       unchanged, so a request that never went near the menu is answered by the
       same rule as before. */
    await designate("DEVELOPER");
    await actAs(DEVELOPER);

    const result = await createIssue({
      projectId,
      type: "TASK",
      title: `Raised without the menu ${Date.now()}`,
      description: "fixture",
      priority: "MEDIUM",
    });

    expect(result.ok, result.ok ? "" : result.error).toBe(true);
    if (result.ok) raised.push(result.data.id);
  });

  it("does not let a project's label unlock an administrator's action", async () => {
    /* That the column leaves `workRoleOf` alone is pinned in
       `project-designation.test.ts`; what is asserted here is the consequence
       at the action a browser calls. */
    await designate("QA");
    await actAs(DEVELOPER);
    expect(await workRoleOf(await requireUser())).toBe("DEVELOPER");

    const result = await createSprint({
      projectId,
      name: `Should never exist ${Date.now()}`,
      goal: "fixture",
      startDate: new Date().toISOString(),
      endDate: new Date(Date.now() + 14 * 864e5).toISOString(),
    });

    expect(result.ok).toBe(false);

    /* And nothing was written on the way to being refused. */
    const sprints = await prisma.sprint.count({
      where: { projectId, name: { startsWith: "Should never exist" } },
    });
    expect(sprints).toBe(0);
  });
});
