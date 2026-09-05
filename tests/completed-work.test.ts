import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createIssue, updateIssue } from "@/server/issues";
import { loadCompletedByPerson } from "@/server/queries/completedWork";
import { actAs, deleteIssues, projectByKey } from "./helpers";

/**
 * Who completed the work.
 *
 * The Completed section on a project's summary answers a question the `Issue`
 * row cannot: **the assignee is not necessarily the person who finished it.**
 * Work gets reassigned, handed over, and closed by reviewers, so reading
 * `assigneeId` and calling that person the finisher is simply wrong — and it
 * is wrong in the worst way, by crediting somebody plausible.
 *
 * These tests pin the three cases that matter: the finisher is read from the
 * activity trail, a later reassignment does not move the credit, and where
 * there is no trail entry nobody is named at all.
 */

const ADMIN = "admin@symbiosystech.com";
const FINISHER = "priya.nair@symbiosystech.com";
const HOLDER = "rahul.menon@symbiosystech.com";

const createdIssues: string[] = [];

afterAll(async () => {
  await deleteIssues(createdIssues);
});

/** Walks an issue through the ordinary workflow to Done, as whoever is acting. */
async function finish(issueId: string) {
  for (const status of ["TODO", "IN_PROGRESS", "IN_REVIEW", "DONE"] as const) {
    const result = await updateIssue({ issueId, status });
    if (!result.ok) throw new Error(`could not move to ${status}: ${result.error}`);
  }
}

async function makeIssue(projectId: string, title: string) {
  const result = await createIssue({ projectId, type: "TASK", title });
  if (!result.ok) throw new Error(`createIssue failed: ${result.error}`);
  const issue = await prisma.issue.findUniqueOrThrow({
    where: { key: result.data.key },
    select: { id: true, key: true },
  });
  createdIssues.push(issue.id);
  return issue;
}

describe("Completed work, grouped by who completed it", () => {
  it("credits the person who moved it to Done, not the person holding it", async () => {
    const admin = await actAs(ADMIN);
    const project = await projectByKey("ENG");
    const finisher = await prisma.user.findUniqueOrThrow({
      where: { email: FINISHER },
      select: { id: true, name: true },
    });
    const holder = await prisma.user.findUniqueOrThrow({
      where: { email: HOLDER },
      select: { id: true },
    });

    const issue = await makeIssue(project.id, `Finished by someone else`);

    // Somebody other than the eventual finisher is holding it to begin with.
    expect(
      (await updateIssue({ issueId: issue.id, assigneeId: holder.id })).ok,
    ).toBe(true);

    // The finisher — a different person again — takes it to Done.
    await actAs(FINISHER);
    await finish(issue.id);

    /* And afterwards it is handed to a third person. This is the step that
       breaks any implementation reading `assigneeId`: the issue now belongs to
       the administrator, who never touched the work. */
    await actAs(ADMIN);
    expect(
      (await updateIssue({ issueId: issue.id, assigneeId: admin.id })).ok,
    ).toBe(true);

    const people = await loadCompletedByPerson(project.id);
    const credited = people.find((person) =>
      person.issues.some((row) => row.id === issue.id),
    );

    expect(credited?.id).toBe(finisher.id);
    expect(credited?.name).toBe(finisher.name);
    // Emphatically not the current assignee.
    expect(credited?.id).not.toBe(admin.id);
    expect(credited?.id).not.toBe(holder.id);
  });

  it("credits whoever finished it last when work was reopened", async () => {
    await actAs(ADMIN);
    const project = await projectByKey("ENG");
    const second = await prisma.user.findUniqueOrThrow({
      where: { email: HOLDER },
      select: { id: true, name: true },
    });

    const issue = await makeIssue(project.id, `Finished twice`);

    await actAs(FINISHER);
    await finish(issue.id);

    // Back into play, then finished again by somebody else.
    await actAs(ADMIN);
    expect(
      (await updateIssue({ issueId: issue.id, status: "REOPENED" })).ok,
    ).toBe(true);

    await actAs(HOLDER);
    await finish(issue.id);

    const people = await loadCompletedByPerson(project.id);
    const credited = people.find((person) =>
      person.issues.some((row) => row.id === issue.id),
    );

    expect(credited?.id).toBe(second.id);
  });

  it("names nobody when the trail does not say who finished it", async () => {
    /*
     * An issue completed without a status-change entry — the shape imported or
     * pre-trail data has. The honest answer is "not recorded", and the group
     * carries no user id, so the section cannot link to a person who was never
     * established as the finisher.
     */
    await actAs(ADMIN);
    const project = await projectByKey("ENG");
    const issue = await makeIssue(project.id, `Completed with no trail`);

    // Written directly, so no `ActivityLogEntry` exists for the transition.
    await prisma.issue.update({
      where: { id: issue.id },
      data: { status: "DONE", completedAt: new Date() },
    });

    const people = await loadCompletedByPerson(project.id);
    const group = people.find((person) =>
      person.issues.some((row) => row.id === issue.id),
    );

    expect(group).toBeDefined();
    expect(group?.id).toBeNull();
    expect(group?.name).toBe("Not recorded");
    // The unattributed group sorts last, whatever its size.
    expect(people[people.length - 1]?.id).toBeNull();
  });

  it("only ever reports the project it was asked about", async () => {
    await actAs(ADMIN);
    const website = await projectByKey("WEB");
    const engineering = await projectByKey("ENG");

    const webIssue = await makeIssue(website.id, `Finished in Website`);
    await finish(webIssue.id);

    const forEngineering = await loadCompletedByPerson(engineering.id);
    const keys = forEngineering.flatMap((person) =>
      person.issues.map((row) => row.key),
    );

    expect(keys).not.toContain(webIssue.key);
    expect(keys.every((key) => key.startsWith("ENG-"))).toBe(true);
  });
});
