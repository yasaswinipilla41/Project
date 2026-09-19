import { expect, test } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { MEMBER_EMAIL, MEMBER_STATE, watchForProblems } from "./support";

/**
 * Create belongs to the project you are looking at.
 *
 * A designation is a fact about one membership, so the same person can be this
 * project's developer and that project's tester. The header reads the active
 * project out of the path and offers Create accordingly — and a developer is
 * not offered it at all.
 *
 * What is worth proving in a browser, rather than against the resolver, is the
 * part only a browser can answer: that the control is *absent* rather than
 * disabled, that the bar does not grow a gap where it used to be, and that
 * walking between two projects re-reads the designation instead of keeping the
 * first answer.
 */

test.use({ storageState: MEMBER_STATE });

let memberId = "";
let devKey = "";
let qaKey = "";
const restore: (() => Promise<void>)[] = [];

async function ensureMembership(projectId: string, userId: string) {
  const existing = await prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
    select: { designation: true },
  });

  if (!existing) {
    await prisma.projectMember.create({ data: { projectId, userId } });
    return async () => {
      await prisma.projectMember.deleteMany({ where: { projectId, userId } });
    };
  }

  const had = existing.designation;
  return async () => {
    await prisma.projectMember.update({
      where: { projectId_userId: { projectId, userId } },
      data: { designation: had },
    });
  };
}

test.beforeAll(async () => {
  memberId = (
    await prisma.user.findUniqueOrThrow({
      where: { email: MEMBER_EMAIL },
      select: { id: true },
    })
  ).id;

  const projects = await prisma.project.findMany({
    where: { isArchived: false },
    select: { id: true, key: true },
    orderBy: { key: "asc" },
    take: 2,
  });
  if (projects.length < 2) {
    throw new Error("This spec needs two projects to switch between.");
  }

  const [dev, qa] = projects;
  devKey = dev!.key.toLowerCase();
  qaKey = qa!.key.toLowerCase();

  restore.push(await ensureMembership(dev!.id, memberId));
  restore.push(await ensureMembership(qa!.id, memberId));

  await prisma.projectMember.update({
    where: { projectId_userId: { projectId: dev!.id, userId: memberId } },
    data: { designation: "DEVELOPER" },
  });
  await prisma.projectMember.update({
    where: { projectId_userId: { projectId: qa!.id, userId: memberId } },
    data: { designation: "QA" },
  });
});

test.afterAll(async () => {
  for (const undo of restore) await undo();
});

test.describe("Create, by what the project calls you", () => {
  test("is absent on a project you develop and present on one you test", async ({
    page,
  }) => {
    const { consoleErrors } = watchForProblems(page);

    const create = page.locator(".prio-create");
    const actions = page.locator(".prio-topbar__actions");

    await page.goto(`/projects/${devKey}/summary`);
    await expect(page.locator(".prio-topbar")).toBeVisible();
    await expect(create).toHaveCount(0);
    /* Not merely hidden: the caret that opens the type menu is gone with it. */
    await expect(
      page.getByRole("button", { name: "Choose what to create" }),
    ).toHaveCount(0);

    const barWithout = (await page.locator(".prio-topbar").boundingBox())!;
    const actionsWithout = (await actions.boundingBox())!;

    /* The same person, one project along. */
    await page.goto(`/projects/${qaKey}/summary`);
    await expect(create).toHaveCount(1);
    await expect(
      create.getByRole("button", { name: "Create", exact: true }),
    ).toBeVisible();

    const barWith = (await page.locator(".prio-topbar").boundingBox())!;

    /* No gap where the control was: the bar keeps its height, and the actions
       group is narrower without Create rather than the same width with a hole
       in it. */
    expect(Math.round(barWithout.height)).toBe(Math.round(barWith.height));
    const actionsWith = (await actions.boundingBox())!;
    expect(actionsWithout.width).toBeLessThan(actionsWith.width);

    expect(consoleErrors).toEqual([]);
  });

  test("follows the project as you move between them, and survives a reload", async ({
    page,
  }) => {
    const create = page.locator(".prio-create");

    await page.goto(`/projects/${qaKey}/summary`);
    await expect(create).toHaveCount(1);

    /* Through the application's own navigation, which is where a stale role
       would show: the header is not re-mounted by a client-side move. */
    await page.locator(`.prio-sidebar a[href^="/projects/${devKey}"]`).first().click();
    await expect(page).toHaveURL(new RegExp(`/projects/${devKey}`));
    await expect(create).toHaveCount(0);

    await page.reload();
    await expect(create).toHaveCount(0);

    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`/projects/${qaKey}`));
    await expect(create).toHaveCount(1);
  });

  test("is offered away from any project, where no designation applies", async ({
    page,
  }) => {
    /* Home belongs to no project, so the organisation-wide answer stands and
       the header behaves exactly as it did before designations existed. */
    await page.goto("/");
    await expect(page.locator(".prio-create")).toHaveCount(1);
  });
});
