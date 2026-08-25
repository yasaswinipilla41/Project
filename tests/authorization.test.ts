import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createIssue, updateIssue } from "@/server/issues";
import { createProject } from "@/server/projects";
import { actAs, actAsAnonymous, deleteIssues, projectByKey } from "./helpers";

/**
 * Authorization is enforced server-side on every write (§40). These tests call
 * the actions directly — bypassing the UI entirely — to prove the checks do not
 * depend on the client hiding a button.
 */

const createdIssues: string[] = [];
const createdProjects: string[] = [];

afterAll(async () => {
  await deleteIssues(createdIssues);
  if (createdProjects.length > 0) {
    await prisma.project.deleteMany({ where: { id: { in: createdProjects } } });
  }
  await prisma.$disconnect();
});

describe("createProject", () => {
  it("refuses an unauthenticated caller", async () => {
    actAsAnonymous();

    const result = await createProject({
      name: "Should Not Exist",
      key: "NOPE",
      memberIds: [],
    });

    expect(result.ok).toBe(false);

    const project = await prisma.project.findUnique({ where: { key: "NOPE" } });
    expect(project).toBeNull();
  });

  it("refuses a member", async () => {
    await actAs("priya.nair@symbiosystech.com");

    const result = await createProject({
      name: "Member Attempt",
      key: "MEMTRY",
      memberIds: [],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/administrator/i);

    const project = await prisma.project.findUnique({ where: { key: "MEMTRY" } });
    expect(project).toBeNull();
  });

  it("allows an admin, and adds the creator as a member", async () => {
    const admin = await actAs("admin@symbiosystech.com");

    const result = await createProject({
      name: "Authorization Fixture",
      key: "AUTHZ",
      description: "Created by the authorization suite.",
      memberIds: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    createdProjects.push(result.data.id);

    expect(result.data.key).toBe("AUTHZ");

    const membership = await prisma.projectMember.findUnique({
      where: {
        projectId_userId: { projectId: result.data.id, userId: admin.id },
      },
    });
    expect(membership).not.toBeNull();
  });

  it("rejects a duplicate project key", async () => {
    await actAs("admin@symbiosystech.com");

    const result = await createProject({
      name: "Duplicate Engineering",
      key: "ENG",
      memberIds: [],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fieldErrors?.key).toBeTruthy();
  });
});

describe("issue access", () => {
  it("refuses issue creation from an unauthenticated caller", async () => {
    const project = await projectByKey("ENG");
    actAsAnonymous();

    const result = await createIssue({
      projectId: project.id,
      type: "TASK",
      title: "Anonymous should not create this",
    });

    expect(result.ok).toBe(false);
  });

  it("stops a member writing to a project they do not belong to", async () => {
    // A project the member is deliberately not part of.
    const admin = await actAs("admin@symbiosystech.com");
    const closed = await prisma.project.create({
      data: {
        name: "Closed Project",
        key: "CLOSED",
        createdById: admin.id,
        members: { create: { userId: admin.id } },
      },
      select: { id: true },
    });
    createdProjects.push(closed.id);

    await actAs("priya.nair@symbiosystech.com");

    const result = await createIssue({
      projectId: closed.id,
      type: "TASK",
      title: "Member should not be able to create this",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/access/i);

    const count = await prisma.issue.count({ where: { projectId: closed.id } });
    expect(count).toBe(0);
  });

  it("stops a member updating an issue outside their projects", async () => {
    const admin = await actAs("admin@symbiosystech.com");

    const hidden = await prisma.project.create({
      data: {
        name: "Hidden Project",
        key: "HIDDEN",
        createdById: admin.id,
        members: { create: { userId: admin.id } },
      },
      select: { id: true },
    });
    createdProjects.push(hidden.id);

    const issue = await createIssue({
      projectId: hidden.id,
      type: "TASK",
      title: "Only the admin can see this",
      status: "TODO",
    });
    expect(issue.ok).toBe(true);
    if (!issue.ok) return;
    createdIssues.push(issue.data.id);

    await actAs("priya.nair@symbiosystech.com");

    const result = await updateIssue({
      issueId: issue.data.id,
      status: "DONE",
    });

    expect(result.ok).toBe(false);

    const unchanged = await prisma.issue.findUniqueOrThrow({
      where: { id: issue.data.id },
      select: { status: true },
    });
    expect(unchanged.status).toBe("TODO");
  });

  it("refuses an assignee who is not a member of the project", async () => {
    const admin = await actAs("admin@symbiosystech.com");

    const solo = await prisma.project.create({
      data: {
        name: "Solo Project",
        key: "SOLO",
        createdById: admin.id,
        members: { create: { userId: admin.id } },
      },
      select: { id: true },
    });
    createdProjects.push(solo.id);

    const outsider = await prisma.user.findUniqueOrThrow({
      where: { email: "priya.nair@symbiosystech.com" },
      select: { id: true },
    });

    const result = await createIssue({
      projectId: solo.id,
      type: "TASK",
      title: "Assigning an outsider must fail",
      assigneeId: outsider.id,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fieldErrors?.assigneeId).toBeTruthy();
  });
});
