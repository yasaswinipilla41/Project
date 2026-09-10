import { expect, test, type Page } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { ADMIN_STATE } from "./support";

/**
 * Who a person is, in the places where people are picked.
 *
 * A member row names somebody and then says one more thing about them. That
 * second line used to be their email address, which is how the system knows
 * them rather than how the team does — a column of addresses tells an
 * administrator nothing about who does what. It is their designation now.
 *
 * The email did not stop mattering: it is still what colleagues look each
 * other up by, and every picker here still finds people by it. That is the
 * pairing these walk — designation shown, email searched — because dropping
 * the second half is an easy and silent way to make the first half a
 * regression.
 */

const NOT_SET = "Not set";

/**
 * Somebody with a designation and somebody without, neither of them already on
 * the project — the dialog offers people who can still be added, so anyone
 * already a member is not a row to assert about.
 */
async function twoKindsOfPerson(projectId: string) {
  const notAlreadyOn = {
    isActive: true,
    projectMemberships: { none: { projectId } },
  } as const;

  const [withTitle, withoutTitle] = await Promise.all([
    prisma.user.findFirst({
      where: { ...notAlreadyOn, NOT: { jobTitle: null } },
      select: { id: true, name: true, email: true, jobTitle: true },
    }),
    prisma.user.findFirst({
      where: { ...notAlreadyOn, jobTitle: null },
      select: { id: true, name: true, email: true, jobTitle: true },
    }),
  ]);
  return { withTitle, withoutTitle };
}

/**
 * A live project that still has somebody to add, and one such person.
 *
 * Picking a project and a person independently does not work: the dialog only
 * offers people who are not already members, and the first project happens to
 * hold everybody. Choosing the pair together is what makes the row exist.
 */
async function projectWithCandidate(where: Record<string, unknown> = {}) {
  const projects = await prisma.project.findMany({
    where: { isArchived: false },
    select: { id: true, key: true },
  });

  for (const project of projects) {
    const person = await prisma.user.findFirst({
      where: {
        isActive: true,
        projectMemberships: { none: { projectId: project.id } },
        ...where,
      },
      select: { id: true, name: true, email: true, jobTitle: true },
    });
    if (person) return { project, person };
  }
  return null;
}

/** Opens Project → Members → Add members for the given project key. */
async function openAddMembers(page: Page, projectKey: string) {
  await page.goto(`/projects/${projectKey.toLowerCase()}/summary`);
  const add = page.getByRole("button", { name: /add members/i }).first();
  await expect(add).toBeVisible();
  await add.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe("Project → Members → Add members", () => {
  test.use({ storageState: ADMIN_STATE });

  test("a row says what somebody does, never their email address", async ({
    page,
  }) => {
    const titled = await projectWithCandidate({ NOT: { jobTitle: null } });
    expect(titled, "no project has an addable person with a designation").not.toBeNull();
    if (!titled) return;

    const { project } = titled;
    const withTitle = titled.person;
    const { withoutTitle } = await twoKindsOfPerson(project.id);

    const dialog = await openAddMembers(page, project.key);
    const search = dialog.getByPlaceholder(/name or email/i);
    await expect(search).toBeVisible();

    {
      await search.fill(withTitle.name);
      const row = dialog
        .locator(".prio-memberrow")
        .filter({ hasText: withTitle.name })
        .first();
      await expect(row).toBeVisible();
      await expect(row).toContainText(withTitle.jobTitle!);
      /* The address is the thing that must not be on the row. */
      await expect(row).not.toContainText(withTitle.email);
    }

    if (withoutTitle) {
      await search.fill(withoutTitle.name);
      const row = dialog
        .locator(".prio-memberrow")
        .filter({ hasText: withoutTitle.name })
        .first();
      if ((await row.count()) > 0) {
        /* No designation is a neutral line, never "undefined", never the
           address the previous case just refused to show. */
        await expect(row).toContainText(NOT_SET);
        await expect(row).not.toContainText(withoutTitle.email);
        await expect(row).not.toContainText("undefined");
        await expect(row).not.toContainText("null");
      }
    }
  });

  test("still finds people by email, which is how colleagues look each other up", async ({
    page,
  }) => {
    const pair = await projectWithCandidate();
    expect(pair, "no project has anybody left to add").not.toBeNull();
    if (!pair) return;
    const { project, person } = pair;

    const dialog = await openAddMembers(page, project.key);
    const search = dialog.getByPlaceholder(/name or email/i);

    await search.fill(person.email);
    await expect(
      dialog.locator(".prio-memberrow").filter({ hasText: person.name }).first(),
    ).toBeVisible();

    /* And by name, which is the other half of what the field promises. */
    await search.fill(person.name);
    await expect(
      dialog.locator(".prio-memberrow").filter({ hasText: person.name }).first(),
    ).toBeVisible();
  });
});

test.describe("Administration's people picker", () => {
  test.use({ storageState: ADMIN_STATE });

  test("shows a designation and still searches by email", async ({ page }) => {
    /*
     * The roster dialog's field says "name or email", and it matched the
     * second line to do it. That line is a designation now, so the address
     * moved to a hidden keyword — the promise on the label is unchanged and
     * this is what checks it is still true.
     */
    const person = await prisma.user.findFirstOrThrow({
      where: { isActive: true, NOT: { jobTitle: null } },
      select: { name: true, email: true, jobTitle: true },
    });

    await page.goto("/admin");
    const block = page
      .locator(".prio-issue__section")
      .filter({ has: page.getByRole("heading", { name: /^Testing · / }) });
    await block.getByRole("button", { name: "Add members" }).click();

    const dialog = page.getByRole("dialog");
    const search = dialog.locator("#team-search");
    await expect(search).toBeVisible();

    await search.click();
    await search.fill(person.email);

    /* Portaled to the body so the dialog's overflow cannot clip it, so it is
       addressed from the page. */
    const option = page
      .locator("#team-search-options")
      .getByRole("option")
      .filter({ hasText: person.name })
      .first();

    await expect(option, "found by email").toBeVisible();
    await expect(option).toContainText(person.jobTitle!);
    await expect(option).not.toContainText(person.email);
  });
});

test.describe("Administration → Add new user", () => {
  test.use({ storageState: ADMIN_STATE });

  test("the Users block leads to People, and New user opens the account form", async ({
    page,
  }) => {
    /* People is on Administration itself now, so the tile scrolls to the
       block rather than opening a page — and the form it offers is the same
       one it has always offered. */
    await page.goto("/admin");
    await page.locator('.prio-stat[href="#people"]').click();
    await expect(page.locator("#people")).toBeVisible();

    await page.locator("#people").getByRole("button", { name: /new user/i }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(/create user account/i);

    /* The existing form, with the fields it has always had — not a second
       user-creation flow standing beside it. */
    await expect(dialog.getByLabel(/full name/i)).toBeVisible();
    await expect(dialog.getByLabel(/work email/i)).toBeVisible();
  });
});

test.describe("a cloned project's members", () => {
  test.use({ storageState: ADMIN_STATE });

  /** The copy this file makes, removed again so the fixture is left as found. */
  let cloneId: string | null = null;

  test.afterAll(async () => {
    if (cloneId) await prisma.project.delete({ where: { id: cloneId } });
  });

  test("behave exactly as an original's do, and the addition survives a reload", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    /*
     * A copy is a project like any other, and the reason to walk it separately
     * is that it is the one built by code rather than by a person: if adding
     * members worked only on projects created through the form, this is where
     * that would show.
     */
    /* The smallest live project. Copying one carries all of its issues and
       comments across, so cloning the largest would be a slow way to ask a
       question that has nothing to do with size. */
    const candidates = await prisma.project.findMany({
      where: { isArchived: false },
      select: { id: true, key: true, _count: { select: { issues: true } } },
    });
    const source = candidates.sort(
      (a, b) => a._count.issues - b._count.issues,
    )[0]!;

    /*
     * Cloned through the interface, which is both the faithful path and the
     * only one available here: `duplicateProject` derives its caller from the
     * request, and a Playwright process has no request scope to derive from.
     */
    await page.goto(`/projects/${source.key.toLowerCase()}/summary`);
    await page.getByRole("button", { name: "More project actions" }).click();
    await page.getByRole("menuitem", { name: /clone project/i }).click();

    const cloneDialog = page.getByRole("dialog");
    await expect(cloneDialog).toBeVisible();
    await cloneDialog.getByRole("button", { name: /^Clone/ }).last().click();

    /*
     * The copy opens on its own board; its key is the one in the address.
     *
     * Waited for by the board route rather than by "a path that is not the
     * source's". A clone's key is derived from the project name, so it can
     * *contain* the source's — cloning "Testing" (TES) produces TESTINCOPY —
     * and a not-the-source predicate is then never satisfied even though the
     * clone was made.
     */
    await page.waitForURL(/\/projects\/[^/]+\/board/, { timeout: 120_000 });

    const cloneKey = new URL(page.url()).pathname.split("/")[2]!.toUpperCase();
    expect(cloneKey).not.toBe(source.key);
    const clone = await prisma.project.findUniqueOrThrow({
      where: { key: cloneKey },
      select: { id: true, key: true },
    });
    cloneId = clone.id;

    /* Somebody the copy does not already hold. */
    const person = await prisma.user.findFirstOrThrow({
      where: {
        isActive: true,
        projectMemberships: { none: { projectId: clone.id } },
      },
      select: { id: true, name: true, email: true, jobTitle: true },
    });

    const dialog = await openAddMembers(page, clone.key);
    const search = dialog.getByPlaceholder(/name or email/i);

    /* Found by email, described by designation — the same pairing as an
       original project's dialog. */
    await search.fill(person.email);
    const row = dialog
      .locator(".prio-memberrow")
      .filter({ hasText: person.name })
      .first();
    await expect(row).toBeVisible();
    await expect(row).toContainText(person.jobTitle ?? NOT_SET);
    await expect(row).not.toContainText(person.email);

    await row.getByRole("button", { name: /^Add$/ }).click();

    /* Persisted, not merely drawn. */
    await expect
      .poll(async () =>
        prisma.projectMember.count({
          where: { projectId: clone.id, userId: person.id },
        }),
      )
      .toBe(1);

    /* And still there after a reload, which is the half a hopeful UI can fake. */
    await page.reload();
    await expect(
      page.locator(".prio-memberrow").filter({ hasText: person.name }).first(),
    ).toBeVisible();
  });
});
