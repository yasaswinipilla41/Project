import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { AUTOMATIC_ASSIGNMENT_ACTION } from "@/lib/activity";
import { OPEN_STATUSES } from "@/lib/domain";
import { createIssue, updateIssue } from "@/server/issues";
import { createProject } from "@/server/projects";
import { previewBacklogAllocation } from "@/server/backlogAssignment";
import { actAs, holdWorkRole } from "./helpers";

/**
 * Work a tester raises into the backlog, and who ends up building it.
 *
 * Two rules are asserted here, and they are the two that were missing rather
 * than the ones that already worked:
 *
 *  - **a tester's unclaimed backlog item is handed to the lightest-loaded
 *    eligible developer, and only then becomes New.** Raising work into the
 *    backlog with nobody on it is a request for somebody to pick it up, so
 *    Prio picks somebody. The status moves because the work has an owner, so
 *    the pair either happens together or not at all — New with nobody on it is
 *    the state this must never produce.
 *  - **work waiting to be tested may only be given to somebody who tests.**
 *    An administrator reassigning a Ready for QA issue is checked against the
 *    same three facts the Assign Work to QA dialog checks: active, on the
 *    project, doing the QA half of the job.
 *
 * Nothing here touches the return to the tester who raised the work, which is
 * `qa-return-to-reporter.test.ts` and was already working.
 *
 * Two projects of this file's own. The seeded Engineering project has hundreds
 * of issues and a membership other suites change, so "who was chosen" would be
 * an assertion about the seed; and a project with *no* eligible developer
 * cannot be arranged inside one that has them.
 */

const ADMIN = "admin@symbiosystech.com";
/** The tester who raises the work. */
const TESTER = "priya.nair@symbiosystech.com";
/** The two who build it, and the only two eligible on the project. */
const DEVELOPER_A = "kiran.das@symbiosystech.com";
const DEVELOPER_B = "sneha.iyer@symbiosystech.com";
/** A second tester, for the administrator's Ready for QA reassignment. */
const QA_OTHER = "meera.pillai@symbiosystech.com";
/** A tester who is switched off, and one who is not on the project. */
const QA_INACTIVE = "aaripakabhavana@gmail.com";
const QA_OUTSIDER = "yasaswinipilla41@gmail.com";

/** The project with developers on it, and the one without. */
let withDevelopers = "";
let withoutDevelopers = "";

const ids: Record<string, string> = {};
const releases: (() => Promise<void>)[] = [];
/** Everything this file created, so the invariant can be checked over all. */
const madeIssues: string[] = [];

async function userId(email: string): Promise<string> {
  const row = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: { id: true },
  });
  return row.id;
}

beforeAll(async () => {
  /*
   * Authoritative rosters rather than additions, through the shared helper:
   * a Development row left behind by another suite would make the "tester"
   * full stack and every rule below would be asserted against the wrong role.
   */
  for (const [email, role] of [
    [TESTER, "QA"],
    [DEVELOPER_A, "DEVELOPER"],
    [DEVELOPER_B, "DEVELOPER"],
    [QA_OTHER, "QA"],
    [QA_INACTIVE, "QA"],
    [QA_OUTSIDER, "QA"],
  ] as const) {
    const held = await holdWorkRole(email, role);
    ids[email] = held.userId;
    releases.push(held.leave);
  }
  ids[ADMIN] = await userId(ADMIN);

  await actAs(ADMIN);

  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();

  /* The developers, the tester who raises the work, and a second tester for
     the Ready for QA cases. `QA_OTHER` is a pure tester, so they are not in
     the developer pool and cannot disturb who is chosen below. */
  const one = await createProject({
    name: `Auto hand-out ${Date.now()}`,
    key: `TA${suffix}`,
    description: "Fixture: a project with eligible developers on it.",
    memberIds: [
      ids[TESTER]!,
      ids[DEVELOPER_A]!,
      ids[DEVELOPER_B]!,
      ids[QA_OTHER]!,
      ids[QA_INACTIVE]!,
    ],
  });
  if (!one.ok) throw new Error(one.error);
  withDevelopers = one.data.id;

  /* The tester alone. The administrator is a member too, and is deliberately
     not a candidate: `autoAssignable` hands work only to somebody whose
     working role is DEVELOPER, and an administrator's queue is not one. */
  const two = await createProject({
    name: `No developers ${Date.now()}`,
    key: `TB${suffix}`,
    description: "Fixture: a project nobody on it builds.",
    memberIds: [ids[TESTER]!],
  });
  if (!two.ok) throw new Error(two.error);
  withoutDevelopers = two.data.id;
});

afterAll(async () => {
  /* The projects cascade to their issues, activity and notifications. */
  await prisma.project.deleteMany({
    where: { id: { in: [withDevelopers, withoutDevelopers].filter(Boolean) } },
  });
  for (const release of releases) await release();
  await prisma.$disconnect();
});

/** Work raised by the tester, the way the create dialog raises it. */
async function testerRaises(
  projectId: string,
  label: string,
  extra: { status?: "BACKLOG" | "TODO"; assigneeId?: string } = {},
): Promise<string> {
  await actAs(TESTER);
  const result = await createIssue({
    projectId,
    type: "BUG",
    title: `${label} ${Date.now()}-${Math.random()}`,
    description: "Raised by QA for this test.",
    priority: "P2",
    ...extra,
  });
  if (!result.ok) throw new Error(result.error);
  madeIssues.push(result.data.id);
  return result.data.id;
}

async function readIssue(id: string) {
  return prisma.issue.findUniqueOrThrow({
    where: { id },
    select: { status: true, assigneeId: true, reporterId: true, key: true },
  });
}

/** How many open issues somebody holds — the figure the allocator weighs. */
async function openWorkOf(email: string): Promise<number> {
  return prisma.issue.count({
    where: { assigneeId: ids[email]!, status: { in: [...OPEN_STATUSES] } },
  });
}

/**
 * Tops somebody up with open work until they hold `target`.
 *
 * The two developers start with whatever the seed and other suites left them,
 * and "the lightest queue wins" is only testable against a known difference.
 * Filed by the administrator and assigned outright, so nothing here goes near
 * the rule under test.
 */
async function loadUpTo(email: string, target: number): Promise<void> {
  await actAs(ADMIN);
  for (let held = await openWorkOf(email); held < target; held += 1) {
    const result = await createIssue({
      projectId: withDevelopers,
      type: "TASK",
      title: `Ballast for ${email} ${Date.now()}-${Math.random()}`,
      description: "fixture",
      status: "TODO",
      priority: "P3",
      assigneeId: ids[email]!,
    });
    if (!result.ok) throw new Error(result.error);
    madeIssues.push(result.data.id);
  }
}

/** Makes the two developers hold the same amount, and says how much. */
async function levelTheQueues(): Promise<number> {
  const level =
    Math.max(await openWorkOf(DEVELOPER_A), await openWorkOf(DEVELOPER_B)) + 1;
  await loadUpTo(DEVELOPER_A, level);
  await loadUpTo(DEVELOPER_B, level);
  return level;
}

/* ------------------------------------------------------------------ A1, A7 */

describe("A1  a tester's unclaimed backlog item is handed out", () => {
  it("assigns an eligible developer and moves it to New", async () => {
    const issueId = await testerRaises(withDevelopers, "Handed out");
    const row = await readIssue(issueId);

    expect(row.status, "Backlog became New").toBe("TODO");
    expect(row.assigneeId).not.toBeNull();
    expect(
      [ids[DEVELOPER_A], ids[DEVELOPER_B]],
      "one of the project's developers, and nobody else",
    ).toContain(row.assigneeId);

    /* Who raised it is untouched — that is what Ready for QA later reads. */
    expect(row.reporterId).toBe(ids[TESTER]);
  });

  it("A7  never leaves work New with nobody on it", async () => {
    await testerRaises(withDevelopers, "Never new and empty");

    const orphaned = await prisma.issue.count({
      where: {
        projectId: { in: [withDevelopers, withoutDevelopers] },
        status: "TODO",
        assigneeId: null,
      },
    });
    expect(orphaned, "New always has somebody on it").toBe(0);
  });
});

/* ---------------------------------------------------------------------- A2 */

describe("A2  the lightest queue takes it", () => {
  it("chooses whichever developer is holding less, both ways round", async () => {
    /* A is made strictly lighter, so A must take it. */
    const level = await levelTheQueues();
    await loadUpTo(DEVELOPER_B, level + 2);

    const toA = await readIssue(await testerRaises(withDevelopers, "Lighter A"));
    expect(toA.assigneeId).toBe(ids[DEVELOPER_A]);

    /*
     * And then the other way, which is the half a test that only checked one
     * direction would pass by accident: A is loaded past B, and the next item
     * has to change hands.
     */
    await loadUpTo(DEVELOPER_A, (await openWorkOf(DEVELOPER_B)) + 2);

    const toB = await readIssue(await testerRaises(withDevelopers, "Lighter B"));
    expect(toB.assigneeId).toBe(ids[DEVELOPER_B]);
  });
});

/* ---------------------------------------------------------------------- A3 */

describe("A3  a tie is broken the same way every time", () => {
  it("picks by name rather than by chance, and repeats itself", async () => {
    /*
     * The documented rule: equal queues are separated by name and then by id,
     * never by a shuffle. Written out here from the names rather than read back
     * from the implementation, so this is the rule being asserted.
     */
    const people = await prisma.user.findMany({
      where: { id: { in: [ids[DEVELOPER_A]!, ids[DEVELOPER_B]!] } },
      select: { id: true, name: true },
    });
    const expected = [...people].sort(
      (a, b) => a.name.localeCompare(b.name, "en") || (a.id < b.id ? -1 : 1),
    )[0]!;

    await levelTheQueues();
    const first = await readIssue(await testerRaises(withDevelopers, "Tie one"));
    expect(first.assigneeId).toBe(expected.id);

    /* Level again — the first hand-out moved one queue — and the same inputs
       must give the same answer, not the other person's turn. */
    await levelTheQueues();
    const second = await readIssue(await testerRaises(withDevelopers, "Tie two"));
    expect(second.assigneeId).toBe(expected.id);
  });
});

/* ---------------------------------------------------------------------- A4 */

describe("A4  nobody eligible means nothing happens", () => {
  it("leaves it in the Backlog, unassigned, rather than guessing", async () => {
    const issueId = await testerRaises(withoutDevelopers, "Nobody to build it");
    const row = await readIssue(issueId);

    expect(row.status, "still waiting in the Backlog").toBe("BACKLOG");
    expect(row.assigneeId, "and nobody was invented for it").toBeNull();
  });

  it("writes no assignment history and notifies nobody", async () => {
    const issueId = await testerRaises(withoutDevelopers, "No trail either");

    const assignments = await prisma.activityLogEntry.count({
      where: { issueId, field: "assigneeId" },
    });
    expect(assignments).toBe(0);

    const notices = await prisma.notification.count({
      where: { issueId, type: "ISSUE_ASSIGNED" },
    });
    expect(notices).toBe(0);
  });
});

/* ------------------------------------------------------------------ A5, A6 */

describe("A5 / A6  the trail and the notice", () => {
  it("records the assignment as Prio's decision, not the tester's choice", async () => {
    const issueId = await testerRaises(withDevelopers, "Automatic trail");
    const row = await readIssue(issueId);

    const assignment = await prisma.activityLogEntry.findFirstOrThrow({
      where: { issueId, field: "assigneeId" },
      select: { action: true, oldValue: true, newValue: true, actorId: true },
    });

    expect(assignment.action).toBe(AUTOMATIC_ASSIGNMENT_ACTION);
    expect(assignment.oldValue).toBeNull();
    expect(assignment.newValue).toBe(row.assigneeId);
    /* The tester caused it, and the action is what says they did not choose. */
    expect(assignment.actorId).toBe(ids[TESTER]);

    /* The move out of the backlog is an ordinary status entry: naming it an
       automatic *assignment* would put a row in the assignment history that
       is not one. */
    const moved = await prisma.activityLogEntry.findFirstOrThrow({
      where: { issueId, field: "status" },
      select: { action: true, oldValue: true, newValue: true },
    });
    expect(moved).toEqual({
      action: "issue.updated",
      oldValue: "BACKLOG",
      newValue: "TODO",
    });
  });

  it("tells the developer the work is theirs, exactly once", async () => {
    const issueId = await testerRaises(withDevelopers, "Notified once");
    const row = await readIssue(issueId);

    const notices = await prisma.notification.findMany({
      where: { issueId, userId: row.assigneeId! },
      select: { type: true, message: true, actorId: true },
    });

    expect(notices, "one notice, not one per write").toHaveLength(1);
    expect(notices[0]!.type).toBe("ISSUE_ASSIGNED");
    expect(notices[0]!.actorId).toBe(ids[TESTER]);
    expect(notices[0]!.message).toContain(row.key);
  });

  it("puts it in the developer's own assigned work", async () => {
    const issueId = await testerRaises(withDevelopers, "In their queue");
    const row = await readIssue(issueId);

    const mine = await prisma.issue.count({
      where: { id: issueId, assigneeId: row.assigneeId },
    });
    expect(mine).toBe(1);
  });
});

/* ------------------------------------------------------------- A8, A9, A10 */

describe("A8 / A9  what the rule deliberately does not touch", () => {
  it("A8  leaves work a tester filed as New exactly as filed", async () => {
    const issueId = await testerRaises(withDevelopers, "Filed as New", {
      status: "TODO",
    });
    const row = await readIssue(issueId);

    /* Filing as New is a statement about the work, not a request for somebody
       to be found: the rule is about the backlog. */
    expect(row.status).toBe("TODO");
    expect(row.assigneeId).toBeNull();
  });

  it("A9  keeps an assignee the tester named, in the Backlog", async () => {
    const issueId = await testerRaises(withDevelopers, "Named a developer", {
      status: "BACKLOG",
      assigneeId: ids[DEVELOPER_A]!,
    });
    const row = await readIssue(issueId);

    expect(row.assigneeId).toBe(ids[DEVELOPER_A]);
    expect(row.status, "somebody chose, so nothing was decided for them").toBe(
      "BACKLOG",
    );
  });

  it("A9  does not hand out an administrator's backlog item", async () => {
    await actAs(ADMIN);
    const result = await createIssue({
      projectId: withDevelopers,
      type: "TASK",
      title: `Admin parks work ${Date.now()}`,
      description: "fixture",
      status: "BACKLOG",
      priority: "P2",
    });
    if (!result.ok) throw new Error(result.error);
    madeIssues.push(result.data.id);

    const row = await readIssue(result.data.id);
    /* Parking work is planning, and Auto-assign backlog is where an
       administrator deals it out when they mean to. */
    expect(row.status).toBe("BACKLOG");
    expect(row.assigneeId).toBeNull();
  });

  it("A9  does not hand out a developer's own backlog item", async () => {
    await actAs(DEVELOPER_A);
    const result = await createIssue({
      projectId: withDevelopers,
      type: "TASK",
      title: `Developer raises work ${Date.now()}`,
      description: "fixture",
      priority: "P2",
    });
    if (!result.ok) throw new Error(result.error);
    madeIssues.push(result.data.id);

    const row = await readIssue(result.data.id);
    expect(row.status, "a developer files at New, as they always did").toBe(
      "TODO",
    );
    expect(row.assigneeId).toBeNull();
  });

  it("A10  leaves the administrator's own backlog allocation working", async () => {
    await actAs(ADMIN);
    const preview = await previewBacklogAllocation({
      projectId: withDevelopers,
    });
    expect(preview.ok, preview.ok ? "" : preview.error).toBe(true);
    if (!preview.ok) return;

    /* A preview still writes nothing, and still reports the cap it works to. */
    expect(preview.data.assigned).toBe(0);
    expect(preview.data.perRun).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------- Workflow C: Ready for QA */

/**
 * An issue waiting to be tested, held by a developer.
 *
 * Built the way Prio builds one — the work is the developer's, and then it is
 * marked ready — with the administrator as reporter so the return to the tester
 * who raised it does not fire and take the fixture over. That path is
 * `qa-return-to-reporter.test.ts` and is deliberately untouched here.
 */
async function readyForQa(label: string): Promise<string> {
  await actAs(ADMIN);
  const result = await createIssue({
    projectId: withDevelopers,
    type: "TASK",
    title: `${label} ${Date.now()}-${Math.random()}`,
    description: "fixture",
    status: "TODO",
    priority: "P2",
    assigneeId: ids[DEVELOPER_A]!,
  });
  if (!result.ok) throw new Error(result.error);
  madeIssues.push(result.data.id);

  const moved = await updateIssue({
    issueId: result.data.id,
    status: "IN_REVIEW",
  });
  if (!moved.ok) throw new Error(moved.error);

  const row = await readIssue(result.data.id);
  if (row.status !== "IN_REVIEW" || row.assigneeId !== ids[DEVELOPER_A]) {
    throw new Error("fixture: expected Ready for QA, held by the developer");
  }
  return result.data.id;
}

describe("C1 / C5  an administrator may hand it to another tester", () => {
  it("changes who holds it, keeps it Ready for QA, and stays Manual", async () => {
    const issueId = await readyForQa("Admin reassigns");

    await actAs(ADMIN);
    const result = await updateIssue({
      issueId,
      assigneeId: ids[QA_OTHER]!,
    });
    expect(result.ok, result.ok ? "" : result.error).toBe(true);

    const row = await readIssue(issueId);
    expect(row.assigneeId).toBe(ids[QA_OTHER]);
    expect(row.status, "assignment and transition stay separate").toBe(
      "IN_REVIEW",
    );

    /* C5: an administrator choosing somebody is a choice, and the history has
       to go on saying so — `issue.assigned.auto` is Prio's decisions only. */
    const entry = await prisma.activityLogEntry.findFirstOrThrow({
      where: { issueId, field: "assigneeId", newValue: ids[QA_OTHER]! },
      select: { action: true, oldValue: true, actorId: true },
    });
    expect(entry.action).toBe("issue.updated");
    expect(entry.oldValue).toBe(ids[DEVELOPER_A]);
    expect(entry.actorId).toBe(ids[ADMIN]);
  });

  it("allows it in the same request that moves the work there", async () => {
    await actAs(ADMIN);
    const created = await createIssue({
      projectId: withDevelopers,
      type: "TASK",
      title: `Named on the way in ${Date.now()}`,
      description: "fixture",
      status: "IN_PROGRESS",
      priority: "P2",
      assigneeId: ids[DEVELOPER_A]!,
    });
    if (!created.ok) throw new Error(created.error);
    madeIssues.push(created.data.id);

    const result = await updateIssue({
      issueId: created.data.id,
      status: "IN_REVIEW",
      assigneeId: ids[QA_OTHER]!,
    });
    expect(result.ok, result.ok ? "" : result.error).toBe(true);

    const row = await readIssue(created.data.id);
    expect(row).toMatchObject({
      status: "IN_REVIEW",
      assigneeId: ids[QA_OTHER],
    });
  });
});

describe("C2 / C3 / C4  and may not hand it to anybody else", () => {
  it("C2  refuses a developer who does no QA work", async () => {
    const issueId = await readyForQa("Refuse a developer");

    await actAs(ADMIN);
    const result = await updateIssue({
      issueId,
      assigneeId: ids[DEVELOPER_B]!,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/does not do QA work/i);

    /* And nothing moved: a refusal is not a partial write. */
    const row = await readIssue(issueId);
    expect(row.assigneeId).toBe(ids[DEVELOPER_A]);
    expect(row.status).toBe("IN_REVIEW");
  });

  it("C2  refuses it on the way in as well", async () => {
    await actAs(ADMIN);
    const created = await createIssue({
      projectId: withDevelopers,
      type: "TASK",
      title: `Refused on the way in ${Date.now()}`,
      description: "fixture",
      status: "IN_PROGRESS",
      priority: "P2",
      assigneeId: ids[DEVELOPER_A]!,
    });
    if (!created.ok) throw new Error(created.error);
    madeIssues.push(created.data.id);

    /* Naming a developer in the same request that marks it Ready for QA is the
       same assignment reached by the other route, and is refused the same. */
    const result = await updateIssue({
      issueId: created.data.id,
      status: "IN_REVIEW",
      assigneeId: ids[DEVELOPER_B]!,
    });
    expect(result.ok).toBe(false);

    const row = await readIssue(created.data.id);
    expect(row.status, "the status did not move either").toBe("IN_PROGRESS");
    expect(row.assigneeId).toBe(ids[DEVELOPER_A]);
  });

  it("C3  refuses a tester whose account is switched off", async () => {
    const issueId = await readyForQa("Refuse an inactive tester");

    await prisma.user.update({
      where: { id: ids[QA_INACTIVE]! },
      data: { isActive: false },
    });
    try {
      await actAs(ADMIN);
      const result = await updateIssue({
        issueId,
        assigneeId: ids[QA_INACTIVE]!,
      });

      expect(result.ok).toBe(false);
      expect((await readIssue(issueId)).assigneeId).toBe(ids[DEVELOPER_A]);
    } finally {
      await prisma.user.update({
        where: { id: ids[QA_INACTIVE]! },
        data: { isActive: true },
      });
    }
  });

  it("C4  refuses a tester who is not on the project", async () => {
    const issueId = await readyForQa("Refuse an outsider");

    await actAs(ADMIN);
    const result = await updateIssue({
      issueId,
      assigneeId: ids[QA_OUTSIDER]!,
    });

    expect(result.ok).toBe(false);
    expect((await readIssue(issueId)).assigneeId).toBe(ids[DEVELOPER_A]);
  });

  it("still lets an administrator unassign it", async () => {
    /* An empty assignee has nobody to be eligible, and putting work down is
       not the same act as giving it to the wrong person. */
    const issueId = await readyForQa("Unassign is not assignment");

    await actAs(ADMIN);
    const result = await updateIssue({ issueId, assigneeId: null });
    expect(result.ok, result.ok ? "" : result.error).toBe(true);

    const row = await readIssue(issueId);
    expect(row.assigneeId).toBeNull();
    expect(row.status).toBe("IN_REVIEW");
  });
});

describe("C6  who may decide is unchanged", () => {
  it("still refuses a developer naming anybody, in the old words", async () => {
    const issueId = await readyForQa("Developer may not choose");

    await actAs(DEVELOPER_A);
    const result = await updateIssue({
      issueId,
      assigneeId: ids[QA_OTHER]!,
    });

    expect(result.ok).toBe(false);
    /* The pre-existing rule still answers first: this is about who may decide,
       not about whether the person named does QA work. */
    if (!result.ok) expect(result.error).toMatch(/only an administrator/i);
  });

  it("still refuses a tester the assignee outright", async () => {
    const issueId = await readyForQa("Tester may not choose");

    await actAs(TESTER);
    const result = await updateIssue({
      issueId,
      assigneeId: ids[QA_OTHER]!,
    });

    expect(result.ok).toBe(false);
    expect((await readIssue(issueId)).assigneeId).toBe(ids[DEVELOPER_A]);
  });

  it("leaves a status-only hand-off alone", async () => {
    /*
     * The ordinary Ready for QA move, which names nobody: it must stay
     * possible, and it must go on leaving the work with the developer who
     * built it — that is the state the QA lane is built to notice.
     */
    await actAs(ADMIN);
    const created = await createIssue({
      projectId: withDevelopers,
      type: "TASK",
      title: `Status only ${Date.now()}`,
      description: "fixture",
      status: "IN_PROGRESS",
      priority: "P2",
      assigneeId: ids[DEVELOPER_A]!,
    });
    if (!created.ok) throw new Error(created.error);
    madeIssues.push(created.data.id);

    await actAs(DEVELOPER_A);
    const moved = await updateIssue({
      issueId: created.data.id,
      status: "IN_REVIEW",
    });
    expect(moved.ok, moved.ok ? "" : moved.error).toBe(true);

    const row = await readIssue(created.data.id);
    expect(row).toMatchObject({
      status: "IN_REVIEW",
      assigneeId: ids[DEVELOPER_A],
    });
  });
});
