import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { loadDashboard } from "@/server/queries/dashboard";
import { listIssues } from "@/server/queries/issues";
import type { CurrentUser } from "@/lib/session";
import { projectByKey } from "./helpers";

/**
 * Home's figures, and the lists they open.
 *
 * Every card on Home is a number over a link, and the promise is that clicking
 * the number shows exactly the issues it counted. That holds only while the
 * two are cut on the same scope — and they were not: Home aggregated over
 * `accessibleProjectIds`, which leaves archived projects out, while the issue
 * list, My Work and the export all read `issueScope`, which does not. The two
 * agreed for as long as nothing was archived, and diverged the moment anything
 * was.
 *
 * So each case here archives a project the reader can see, and asserts the
 * figure still equals the list. Archiving is the cheapest way to make the
 * difference appear; the property being pinned is the general one — Home and
 * the list it links to are the same query with a different projection.
 *
 * The project is put back in `afterAll` whatever happens in between.
 */

const ADMIN = "admin@symbiosystech.com";
const MEMBER = "priya.nair@symbiosystech.com";

/** Archived for the duration, restored afterwards. */
let archivedId = "";

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

beforeAll(async () => {
  const project = await projectByKey("WEB");
  archivedId = project.id;

  /* The reader has to be able to see the project for its issues to be in
     scope at all; archiving is about whether it is *listed*, not about
     access. */
  const member = await userByEmail(MEMBER);
  await prisma.projectMember.upsert({
    where: { projectId_userId: { projectId: archivedId, userId: member.id } },
    update: {},
    create: { projectId: archivedId, userId: member.id },
  });

  await prisma.project.update({
    where: { id: archivedId },
    data: { isArchived: true },
  });
});

afterAll(async () => {
  if (archivedId) {
    await prisma.project.update({
      where: { id: archivedId },
      data: { isArchived: false },
    });
  }
  await prisma.$disconnect();
});

describe("with a project archived", () => {
  for (const email of [ADMIN, MEMBER]) {
    it(`keeps Home and the issue list on one scope for ${email}`, async () => {
      const user = await userByEmail(email);
      const data = await loadDashboard(user);

      /* Assigned to me — the KPI, and the list its link opens. */
      const assigned = await listIssues(user, {
        assigneeIds: [user.id],
        resolution: "open",
        pageSize: 200,
      });
      expect(data.myWork.assigned, "Assigned to me").toBe(assigned.total);

      /* Open issues. */
      const open = await listIssues(user, {
        resolution: "open",
        pageSize: 200,
      });
      expect(data.kpi.openIssues, "Open issues").toBe(open.total);

      /* Completed — Done, and only Done. */
      const done = await listIssues(user, {
        statuses: ["DONE"],
        pageSize: 200,
      });
      expect(data.kpi.completed, "Completed issues").toBe(done.total);

      /* My work's own tiles, each against the list it links to. */
      const inProgress = await listIssues(user, {
        assigneeIds: [user.id],
        statuses: ["IN_PROGRESS"],
        pageSize: 200,
      });
      expect(data.myWork.inProgress, "In progress").toBe(inProgress.total);

      const review = await listIssues(user, {
        assigneeIds: [user.id],
        statuses: ["IN_REVIEW"],
        pageSize: 200,
      });
      expect(data.myWork.review, "Ready for QA").toBe(review.total);

      const inQa = await listIssues(user, {
        assigneeIds: [user.id],
        statuses: ["IN_QA"],
        pageSize: 200,
      });
      expect(data.myWork.inQa, "In QA").toBe(inQa.total);

      const completedMine = await listIssues(user, {
        assigneeIds: [user.id],
        statuses: ["DONE"],
        pageSize: 200,
      });
      expect(data.myWork.completed, "My completed").toBe(completedMine.total);

      const overdue = await listIssues(user, {
        assigneeIds: [user.id],
        resolution: "open",
        overdue: true,
        pageSize: 200,
      });
      expect(data.myWork.overdue, "Overdue").toBe(overdue.total);

      const reported = await listIssues(user, {
        reporterIds: [user.id],
        pageSize: 500,
      });
      expect(data.myWork.reported, "Reported").toBe(reported.total);
    });
  }

  it("counts the viewer's own row in Team members the way My Work does", async () => {
    /*
     * Home's Team members block shows each person's open work "in scope". For
     * the viewer's own row that is the same question My Work answers about
     * them, so the two must agree — this is the mismatch §12 describes.
     */
    const user = await userByEmail(MEMBER);
    const data = await loadDashboard(user);

    const me = data.teamMembers.find((person) => person.isYou);
    expect(me, "the viewer is on their own team list").toBeTruthy();

    const mine = await listIssues(user, {
      assigneeIds: [user.id],
      resolution: "open",
      pageSize: 200,
    });
    expect(me!.openInScope).toBe(mine.total);
    expect(me!.openInScope).toBe(data.myWork.assigned);
  });
});
