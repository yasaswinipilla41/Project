import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createIssue, updateIssue } from "@/server/issues";
import { actAs, holdWorkRole, joinProject, projectByKey } from "./helpers";

/**
 * The two moves the board refuses, asserted against the server.
 *
 * The Flow Board stops these before they are sent, and shows why beside its
 * Labels filter — but a board that merely declines to ask is not a permission.
 * Every case here calls `updateIssue` directly, which is the same call a
 * hand-made request would make, so what is being tested is the rule rather
 * than the drag handler.
 *
 * Both roles are established rather than assumed: the rule turns entirely on
 * which half of the job somebody holds, and a stray team row would quietly
 * turn either of these people into somebody the rule does not apply to.
 */

const ADMIN = "admin@symbiosystech.com";
const DEVELOPER = "kiran.das@symbiosystech.com";
const TESTER = "priya.nair@symbiosystech.com";

const undo: (() => Promise<void>)[] = [];
const createdIssueIds: string[] = [];

beforeAll(async () => {
  undo.push((await holdWorkRole(DEVELOPER, "DEVELOPER")).leave);
  undo.push((await holdWorkRole(TESTER, "QA")).leave);
  for (const email of [DEVELOPER, TESTER]) {
    undo.push((await joinProject("ENG", email)).leave);
  }
});

afterAll(async () => {
  if (createdIssueIds.length > 0) {
    await prisma.notification.deleteMany({
      where: { issueId: { in: createdIssueIds } },
    });
    await prisma.issue.deleteMany({ where: { id: { in: createdIssueIds } } });
  }
  for (const leave of undo.reverse()) await leave();
  await prisma.$disconnect();
});

/** An ENG issue in a given status, put there by the administrator. */
async function anIssue(title: string, status: "IN_PROGRESS" | "IN_REVIEW") {
  await actAs(ADMIN);
  const project = await projectByKey("ENG");
  const created = await createIssue({
    projectId: project.id,
    type: "TASK",
    title: `${title} ${Date.now()}`,
    description: "fixture",
    priority: "MEDIUM",
  });
  if (!created.ok) throw new Error(created.error);
  createdIssueIds.push(created.data.id);

  const moved = await updateIssue({ issueId: created.data.id, status });
  if (!moved.ok) throw new Error(moved.error);
  return created.data.id;
}

function statusOf(issueId: string) {
  return prisma.issue.findUniqueOrThrow({
    where: { id: issueId },
    select: { status: true },
  });
}

describe("a tester dropping work into Ready for QA", () => {
  it("is refused, and the issue does not move", async () => {
    /* Ready for QA is the developer's hand-off: it says the build is finished
       and ready to be checked, which is not a claim a tester makes. */
    const issueId = await anIssue("Tester aims at Ready for QA", "IN_PROGRESS");

    await actAs(TESTER);
    const result = await updateIssue({ issueId, status: "IN_REVIEW" });

    expect(result.ok).toBe(false);
    expect((await statusOf(issueId)).status).toBe("IN_PROGRESS");
  });
});

describe("a developer dropping work into In QA or Done", () => {
  it("is refused for In QA, and the issue does not move", async () => {
    const issueId = await anIssue("Developer aims at In QA", "IN_REVIEW");

    await actAs(DEVELOPER);
    const result = await updateIssue({ issueId, status: "IN_QA" });

    expect(result.ok).toBe(false);
    expect((await statusOf(issueId)).status).toBe("IN_REVIEW");
  });

  it("is refused for Done, and the issue does not move", async () => {
    /* Marking your own work finished is the verdict, and the verdict is
       testing's. */
    const issueId = await anIssue("Developer aims at Done", "IN_REVIEW");

    await actAs(DEVELOPER);
    const result = await updateIssue({ issueId, status: "DONE" });

    expect(result.ok).toBe(false);
    expect((await statusOf(issueId)).status).toBe("IN_REVIEW");
  });
});

describe("the moves each role is actually for", () => {
  it("lets a developer hand work over as Ready for QA", async () => {
    const issueId = await anIssue("Developer hands over", "IN_PROGRESS");

    await actAs(DEVELOPER);
    const result = await updateIssue({ issueId, status: "IN_REVIEW" });

    expect(result.ok, result.ok ? "" : result.error).toBe(true);
    expect((await statusOf(issueId)).status).toBe("IN_REVIEW");
  });

  it("lets a tester take work into In QA and then finish it", async () => {
    const issueId = await anIssue("Tester takes it in", "IN_REVIEW");

    await actAs(TESTER);
    const taken = await updateIssue({ issueId, status: "IN_QA" });
    expect(taken.ok, taken.ok ? "" : taken.error).toBe(true);

    const finished = await updateIssue({ issueId, status: "DONE" });
    expect(finished.ok, finished.ok ? "" : finished.error).toBe(true);
    expect((await statusOf(issueId)).status).toBe("DONE");
  });
});
