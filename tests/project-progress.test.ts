import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { CLOSED_STATUSES, ISSUE_STATUSES, OPEN_STATUSES } from "@/lib/domain";
import { countsAsCompleted, projectProgress } from "@/lib/projectProgress";
import { loadDashboard } from "@/server/queries/dashboard";
import { requireUser } from "@/lib/session";
import { actAs, projectByKey } from "./helpers";

/**
 * How far through a project its work is — one answer, wherever it is drawn.
 *
 * The project directory has always divided closed work by all work. Home
 * divided `DONE` alone by all work, so the same project read as two different
 * percentages depending on which page you were on. The definition now lives in
 * `lib/projectProgress`, and what is asserted here is that the definition says
 * what the directory always said and that the dashboard query now reports it.
 */

const ADMIN = "admin@symbiosystech.com";

afterAll(async () => {
  await prisma.$disconnect();
});

describe("what counts as completed", () => {
  it("counts every closed status and no open one", () => {
    for (const status of CLOSED_STATUSES) {
      expect(countsAsCompleted(status), `${status} is finished`).toBe(true);
    }
    for (const status of OPEN_STATUSES) {
      expect(countsAsCompleted(status), `${status} is not finished`).toBe(false);
    }
  });

  it("has an answer for every status Prio has", () => {
    /* A status added later must be decided deliberately, not fall through to
       "not finished" unnoticed — this fails the moment the two lists stop
       covering the vocabulary between them. */
    for (const status of ISSUE_STATUSES) {
      const known =
        (CLOSED_STATUSES as readonly string[]).includes(status) ||
        (OPEN_STATUSES as readonly string[]).includes(status);
      expect(known, `${status} is classified`).toBe(true);
    }
  });
});

describe("the progress contract", () => {
  it("is empty rather than nought per cent when there is nothing to do", () => {
    const progress = projectProgress("p1", 0, 0);
    expect(progress.isEmpty).toBe(true);
    expect(progress.percentage).toBe(0);
    expect(progress.label).toBe("No issues yet");
  });

  it("reads nought per cent when nothing is finished", () => {
    const progress = projectProgress("p1", 0, 8);
    expect(progress.isEmpty).toBe(false);
    expect(progress.percentage).toBe(0);
    expect(progress.label).toBe("0% complete · 0 of 8");
  });

  it("reads a hundred per cent when everything is", () => {
    const progress = projectProgress("p1", 8, 8);
    expect(progress.percentage).toBe(100);
    expect(progress.label).toBe("100% complete · 8 of 8");
  });

  it("carries the counts it was given, and says where they belong", () => {
    const progress = projectProgress("project-42", 3, 4);
    expect(progress).toMatchObject({
      projectId: "project-42",
      completed: 3,
      total: 4,
      percentage: 75,
      isEmpty: false,
    });
  });

  it("is the same figure for the same counts, wherever it is built", () => {
    /* The property the two pages rely on: the contract is a pure function of
       the counts, so a card cannot arrive at its own percentage. */
    expect(projectProgress("a", 5, 9).percentage).toBe(
      projectProgress("b", 5, 9).percentage,
    );
  });
});

describe("the dashboard reports the same completion the directory counts", () => {
  it("counts closed work, not Done alone", async () => {
    await actAs(ADMIN);
    const user = await requireUser();
    const project = await projectByKey("ENG");

    /* The directory's own rule, stated here rather than imported, so this
       fails if the rule quietly changes on either side. */
    const [closed, total] = await Promise.all([
      prisma.issue.count({
        where: { projectId: project.id, status: { in: [...CLOSED_STATUSES] } },
      }),
      prisma.issue.count({ where: { projectId: project.id } }),
    ]);

    const data = await loadDashboard(user);
    const card = data.projects.find((row) => row.id === project.id);

    expect(card, "the administrator's Home lists ENG").toBeTruthy();
    expect(card!.total).toBe(total);
    expect(card!.completed).toBe(closed);

    /* And the figure the bar draws is the directory's figure. */
    const fromDashboard = projectProgress(project.id, card!.completed, card!.total);
    const fromDirectory = projectProgress(project.id, closed, total);
    expect(fromDashboard.percentage).toBe(fromDirectory.percentage);
    expect(fromDashboard.label).toBe(fromDirectory.label);
  });

  it("keeps Done as its own count, which is not the same question", async () => {
    await actAs(ADMIN);
    const user = await requireUser();
    const project = await projectByKey("ENG");

    const done = await prisma.issue.count({
      where: { projectId: project.id, status: "DONE" },
    });

    const data = await loadDashboard(user);
    const card = data.projects.find((row) => row.id === project.id)!;

    expect(card.done).toBe(done);
    /* Closed work is Done plus the two ways work is written off, so it can
       never be the smaller of the two. */
    expect(card.completed).toBeGreaterThanOrEqual(card.done);
  });
});
