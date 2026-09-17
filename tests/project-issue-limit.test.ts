import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { ISSUE_LIMIT_CODE, ISSUE_LIMIT_REACHED } from "@/lib/domain";
import { createIssue, reportBug } from "@/server/issues";
import { createProject, updateProject } from "@/server/projects";
import { actAs } from "./helpers";

/**
 * The issue limit an administrator may set on a project.
 *
 * Prio has no built-in cap — `project-issue-capacity.test.ts` still asserts
 * that, and must keep passing — so this is about the one an administrator
 * chooses. A project holds as much as it likes until somebody says otherwise;
 * after that, filing work in it stops at the number they picked, and stops on
 * the server rather than in a dialog.
 *
 * Every project here is created by the suite and deleted afterwards, so none of
 * this touches the projects the installation already had.
 */

const ADMIN = "admin@symbiosystech.com";
/** A MEMBER account, for the checks about who may set a limit. */
const MEMBER = "kiran.das@symbiosystech.com";

const createdProjectIds: string[] = [];

afterAll(async () => {
  /* Each cascades to its own issues and everything hanging off them. */
  if (createdProjectIds.length > 0) {
    await prisma.project.deleteMany({
      where: { id: { in: createdProjectIds } },
    });
  }
  await prisma.$disconnect();
});

/** A fresh project, owned by this suite. */
async function aProject(prefix: string): Promise<{ id: string; key: string }> {
  await actAs(ADMIN);
  const key = `${prefix}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
  const created = await createProject({
    name: `${prefix} ${Date.now()}`,
    key,
    description: "Fixture for the project issue limit suite.",
  });
  if (!created.ok) throw new Error(created.error);
  createdProjectIds.push(created.data.id);
  return created.data;
}

/** Files one issue the ordinary way, as a person would. */
async function fileOne(projectId: string, title: string) {
  return createIssue({
    projectId,
    type: "TASK",
    title,
    description: "fixture",
    priority: "MEDIUM",
  });
}

/** Sets (or with null, removes) a project's limit as the administrator. */
async function setLimit(projectId: string, maxIssues: number | null) {
  await actAs(ADMIN);
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { name: true },
  });
  return updateProject({ projectId, name: project.name, maxIssues });
}

/** Fills a project to exactly `n` issues through the real action. */
async function fillTo(projectId: string, n: number) {
  await actAs(ADMIN);
  for (let i = 0; i < n; i += 1) {
    const result = await fileOne(projectId, `Fill ${i + 1}`);
    if (!result.ok) throw new Error(`fill stopped at ${i + 1}: ${result.error}`);
  }
}

function heldBy(projectId: string) {
  return prisma.issue.count({ where: { projectId } });
}

describe("a project with no limit set", () => {
  it("is unlimited, which is how every project starts", async () => {
    const project = await aProject("NOL");

    const row = await prisma.project.findUniqueOrThrow({
      where: { id: project.id },
      select: { maxIssues: true },
    });
    // Not zero, and not some number Prio chose — absent.
    expect(row.maxIssues).toBeNull();

    await actAs(ADMIN);
    for (const title of ["First", "Second", "Third"]) {
      const result = await fileOne(project.id, title);
      expect(result.ok, result.ok ? "" : result.error).toBe(true);
    }
    expect(await heldBy(project.id)).toBe(3);
  });
});

describe("a project below its limit", () => {
  it("accepts the issue that brings it exactly to the limit", async () => {
    const project = await aProject("BEL");
    await setLimit(project.id, 3);
    await fillTo(project.id, 2);

    await actAs(ADMIN);
    const result = await fileOne(project.id, "The third of three");

    expect(result.ok, result.ok ? "" : result.error).toBe(true);
    expect(await heldBy(project.id)).toBe(3);
  });
});

describe("a project at its limit", () => {
  it("refuses the next issue, in the exact words the popup shows", async () => {
    const project = await aProject("ATL");
    await setLimit(project.id, 3);
    await fillTo(project.id, 3);

    await actAs(ADMIN);
    const result = await fileOne(project.id, "One too many");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(ISSUE_LIMIT_REACHED);
    expect(result.error).toBe(
      "You have reached the maximum number of issues you can create",
    );
    // Named, so the dialog can single this out from every other failure.
    expect(result.code).toBe(ISSUE_LIMIT_CODE);
  });

  it("writes nothing — not the issue, and not the key it would have taken", async () => {
    const project = await aProject("NOW");
    await setLimit(project.id, 2);
    await fillTo(project.id, 2);

    const before = await prisma.project.findUniqueOrThrow({
      where: { id: project.id },
      select: { issueSequence: true },
    });

    await actAs(ADMIN);
    const refused = await fileOne(project.id, "Never written");
    expect(refused.ok).toBe(false);

    expect(await heldBy(project.id)).toBe(2);
    /* The refusal rolls the transaction back, so the sequence is where it was:
       a rejected create does not burn a number and leave a gap in the keys. */
    const after = await prisma.project.findUniqueOrThrow({
      where: { id: project.id },
      select: { issueSequence: true },
    });
    expect(after.issueSequence).toBe(before.issueSequence);
  });

  it("refuses a bug filed against work in it, not only the create dialog", async () => {
    /* `reportBug` is a second writer with its own entry point. It allocates a
       key the same way, which is exactly why it is covered too. */
    const project = await aProject("BUG");
    await setLimit(project.id, 2);
    await fillTo(project.id, 2);

    const target = await prisma.issue.findFirstOrThrow({
      where: { projectId: project.id },
      select: { id: true },
    });

    await actAs(ADMIN);
    const result = await reportBug({
      issueId: target.id,
      title: "A defect that cannot be filed",
      affectedModule: "Fixture",
      priority: "HIGH",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(ISSUE_LIMIT_REACHED);
    expect(await heldBy(project.id)).toBe(2);
  });
});

describe("a project past its limit", () => {
  it("stays shut rather than letting work back up to the number", async () => {
    /* Reached by lowering the limit under work already filed, which is the
       ordinary way a project ends up over: nothing is deleted to make room. */
    const project = await aProject("OVR");
    await fillTo(project.id, 4);
    await setLimit(project.id, 2);

    expect(await heldBy(project.id)).toBe(4);

    await actAs(ADMIN);
    const result = await fileOne(project.id, "Still refused");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(ISSUE_LIMIT_REACHED);
    // And the work that was already there is untouched.
    expect(await heldBy(project.id)).toBe(4);
  });
});

describe("one project's limit", () => {
  it("says nothing about another's", async () => {
    const full = await aProject("ISA");
    const open = await aProject("ISB");

    await setLimit(full.id, 2);
    await fillTo(full.id, 2);
    await fillTo(open.id, 2);

    await actAs(ADMIN);
    const refused = await fileOne(full.id, "Into the full one");
    const allowed = await fileOne(open.id, "Into the open one");

    expect(refused.ok).toBe(false);
    expect(allowed.ok, allowed.ok ? "" : allowed.error).toBe(true);

    expect(await heldBy(full.id)).toBe(2);
    expect(await heldBy(open.id)).toBe(3);
  });
});

describe("clearing the limit", () => {
  it("makes the project unlimited again", async () => {
    const project = await aProject("CLR");
    await setLimit(project.id, 2);
    await fillTo(project.id, 2);

    await actAs(ADMIN);
    expect((await fileOne(project.id, "Refused while limited")).ok).toBe(false);

    const cleared = await setLimit(project.id, null);
    expect(cleared.ok, cleared.ok ? "" : cleared.error).toBe(true);

    const row = await prisma.project.findUniqueOrThrow({
      where: { id: project.id },
      select: { maxIssues: true },
    });
    expect(row.maxIssues).toBeNull();

    await actAs(ADMIN);
    const result = await fileOne(project.id, "Allowed once cleared");
    expect(result.ok, result.ok ? "" : result.error).toBe(true);
    expect(await heldBy(project.id)).toBe(3);
  });
});

describe("who may set a limit", () => {
  it("is not an ordinary member, however the request is shaped", async () => {
    const project = await aProject("WHO");
    await setLimit(project.id, 5);

    await actAs(MEMBER);
    const result = await updateProject({
      projectId: project.id,
      name: "Renamed by a member",
      maxIssues: 9999,
    });

    expect(result.ok).toBe(false);

    /* And nothing moved — neither the limit they aimed at nor the name they
       would have changed on the way past it. */
    const row = await prisma.project.findUniqueOrThrow({
      where: { id: project.id },
      select: { maxIssues: true, name: true },
    });
    expect(row.maxIssues).toBe(5);
    expect(row.name).not.toBe("Renamed by a member");
  });

  it("refuses a limit of zero or less, which is not a limit but a closure", async () => {
    const project = await aProject("VAL");

    for (const bad of [0, -1, -100]) {
      const result = await setLimit(project.id, bad);
      expect(result.ok, `maxIssues=${bad} should be refused`).toBe(false);
    }

    const row = await prisma.project.findUniqueOrThrow({
      where: { id: project.id },
      select: { maxIssues: true },
    });
    expect(row.maxIssues).toBeNull();
  });

  it("leaves the limit alone when a caller does not mention it", async () => {
    /* The archive toggle and the rename post the same form. A payload without
       `maxIssues` must not read as "remove the limit". */
    const project = await aProject("KEP");
    await setLimit(project.id, 7);

    await actAs(ADMIN);
    const result = await updateProject({
      projectId: project.id,
      name: "Renamed, limit untouched",
    });
    expect(result.ok, result.ok ? "" : result.error).toBe(true);

    const row = await prisma.project.findUniqueOrThrow({
      where: { id: project.id },
      select: { maxIssues: true, name: true },
    });
    expect(row.maxIssues).toBe(7);
    expect(row.name).toBe("Renamed, limit untouched");
  });
});

describe("the limit is the server's", () => {
  it("holds against a direct call that never went near a dialog", async () => {
    /* The action is the API. Calling it straight, with a handcrafted payload
       naming the project by id, is the bypass a hidden button would not stop. */
    const project = await aProject("API");
    await setLimit(project.id, 1);
    await fillTo(project.id, 1);

    await actAs(ADMIN);
    const result = await createIssue({
      projectId: project.id,
      type: "BUG",
      title: "Straight at the action",
      description: "fixture",
      priority: "URGENT",
      status: "TODO",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe(ISSUE_LIMIT_REACHED);
    expect(await heldBy(project.id)).toBe(1);
  });

  it("cannot be raised by asking for several issues at once", async () => {
    /*
     * Two creates in flight together, against a project with one place left.
     *
     * `nextIssueNumber` updates the project row before it counts, so the second
     * transaction waits on that row and reads a count including the first.
     * Without it both would see the same count and both would be let through.
     */
    const project = await aProject("RAC");
    await setLimit(project.id, 3);
    await fillTo(project.id, 2);

    await actAs(ADMIN);
    const results = await Promise.all([
      fileOne(project.id, "Racer one"),
      fileOne(project.id, "Racer two"),
      fileOne(project.id, "Racer three"),
    ]);

    const won = results.filter((r) => r.ok).length;
    expect(won).toBe(1);
    expect(await heldBy(project.id)).toBe(3);

    for (const refused of results.filter((r) => !r.ok)) {
      if (!refused.ok) expect(refused.error).toBe(ISSUE_LIMIT_REACHED);
    }
  });
});

describe("the limit is the only new rule", () => {
  it("leaves who may raise what exactly as it was", async () => {
    /*
     * A member files their own work in a project they belong to, which they
     * could always do. The limit is about how much a project holds, not about
     * who may add to it, so below the limit nothing about permissions changes.
     */
    const project = await aProject("PRM");
    await setLimit(project.id, 50);

    const member = await prisma.user.findUniqueOrThrow({
      where: { email: MEMBER },
      select: { id: true },
    });
    await prisma.projectMember.create({
      data: { projectId: project.id, userId: member.id },
    });

    await actAs(MEMBER);
    for (const type of ["TASK", "BUG", "STORY", "EPIC", "FEATURE"] as const) {
      const result = await createIssue({
        projectId: project.id,
        type,
        title: `A ${type} a member may raise`,
        description: "fixture",
        priority: "MEDIUM",
      });
      expect(result.ok, result.ok ? "" : `${type}: ${result.error}`).toBe(true);
    }

    expect(await heldBy(project.id)).toBe(5);
  });
});
