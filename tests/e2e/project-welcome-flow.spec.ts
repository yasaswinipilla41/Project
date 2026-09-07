import { expect, test, type Page } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { OPEN_STATUSES } from "@/lib/domain";
import { MEMBER_STATE } from "./support";

/**
 * The route through Prio, checked as a route rather than as five pages.
 *
 *   dashboard → pick a project → Welcome → Go to Project → Summary → the views
 *
 * The step that has to hold is the middle one: choosing a project from any of
 * the global surfaces passes through that project's Welcome page, and never
 * lands straight on its Summary. Every picker is checked, not just one, because
 * the failure this guards against is a single link that was missed.
 *
 * Everything the Welcome page says is asserted against the same rows the
 * database holds, so a figure is only correct here if it describes that
 * project. The second project exists in this file for the failure that matters
 * most on a page like this: a count that quietly describes the organisation
 * rather than the project whose page it is on.
 */

/** What the database says about a project, for the Welcome page to match. */
async function truthFor(key: string) {
  const project = await prisma.project.findUniqueOrThrow({
    where: { key },
    select: {
      id: true,
      key: true,
      name: true,
      createdBy: { select: { name: true } },
      _count: { select: { members: true } },
    },
  });

  const open = await prisma.issue.count({
    where: { projectId: project.id, status: { in: [...OPEN_STATUSES] } },
  });

  return { ...project, open };
}

/** The value under a labelled fact on the Welcome card. */
async function fact(page: Page, label: string): Promise<string> {
  const entry = page.locator(".prio-welcome__fact").filter({
    has: page.locator("dt", {
      hasText: new RegExp(String.raw`^\s*${label}\s*$`, "i"),
    }),
  });
  await expect(entry, `one fact labelled ${label}`).toHaveCount(1);
  return (await entry.locator("dd").innerText()).trim();
}

/* ------------------------------------------------------- the whole route */

test.describe("Dashboard to project workspace", () => {
  test("passes through Welcome and lands on Summary", async ({ page }) => {
    const truth = await truthFor("ENG");

    // 1. The global dashboard, which is not any project's page.
    await page.goto("/");
    await expect(page.locator(".prio-sidebar")).toBeVisible();
    await expect(page).toHaveURL(/localhost:3000\/$/);

    // 2. Picking the project from it.
    await page
      .locator(".prio-projrow")
      .filter({ hasText: truth.key })
      .first()
      .click();

    // 3. Welcome — not Summary.
    await expect(page).toHaveURL(/\/projects\/eng\/welcome$/);
    await expect(
      page.getByRole("heading", { name: `Welcome to ${truth.name}` }),
    ).toBeVisible();

    // 4. The one step onward.
    await page.getByRole("link", { name: "Go to Project" }).click();
    await expect(page).toHaveURL(/\/projects\/eng\/summary$/);
    await expect(page.locator(".prio-summary__grid")).toBeVisible();

    // 5. And the workspace's own views, all still this project's.
    for (const view of ["list", "board", "calendar", "timeline"] as const) {
      await page.goto(`/projects/eng/${view}`);
      await expect(page).toHaveURL(new RegExp(`/projects/eng/${view}$`));
    }
  });

  test("every project picker in Prio opens Welcome first", async ({ page }) => {
    /*
     * A picker is a surface whose job is choosing which project to work in.
     * All of them lead to Welcome. Contextual links — an issue's breadcrumb
     * back to its project, the Flow Board's, Settings' — are deliberately not
     * pickers and are covered separately below.
     *
     * Each picker is driven with whichever project it is actually offering
     * rather than with a named one. The sidebar and the switcher show the
     * twelve most recently opened projects, so in a full run — where earlier
     * specs have created and cloned projects of their own — a fixed name may
     * genuinely not be on the list. The claim under test is about the surface,
     * not about which project happens to be on it, so it is asserted that way.
     */
    const key = "ENG";
    const { name } = await truthFor(key);

    // The sidebar.
    await page.goto("/");
    const sidebarRow = page.locator(".prio-sidebar__project-row").first();
    await expect(sidebarRow).toBeVisible();
    const sidebarName = (
      await sidebarRow.locator(".prio-navitem__label").innerText()
    ).trim();
    await sidebarRow.locator("a.prio-sidebar__project-link").click();
    await expect(page).toHaveURL(/\/projects\/[a-z0-9-]+\/welcome$/);

    // It opened that project, not merely some Welcome page.
    await expect(page.locator(".prio-welcome__project")).toHaveText(sidebarName);

    // The directory.
    await page.goto("/projects");
    await page.locator(".prio-projectcard__name a").first().click();
    await expect(page).toHaveURL(/\/projects\/[a-z0-9-]+\/welcome$/);

    // The top bar's switcher.
    await page.goto("/");
    await page.getByRole("button", { name: /^Projects$/ }).click();
    const menuItem = page
      .getByRole("menu")
      .getByRole("menuitem")
      .filter({ hasNot: page.getByText("All projects") })
      .first();
    /* Where the item says it goes, taken from the item itself -- so this
       is checked against whichever project the switcher happens to be
       offering rather than against a name that may not be on its
       twelve-row list. */
    const switcherHref = await menuItem.getAttribute("href");
    expect(switcherHref, "a switcher entry points at Welcome").toMatch(
      /^[/]projects[/][a-z0-9-]+[/]welcome$/,
    );
    await menuItem.click();
    await expect(page).toHaveURL(new RegExp(`${switcherHref}$`));

    /* And the named project, reached the one way that does not depend on a
       twelve-row list: the directory holds every project the reader can see. */
    await page.goto("/projects");
    await page
      .locator(".prio-projectcard")
      .filter({ hasText: key })
      .first()
      .locator(".prio-projectcard__name a")
      .click();
    await expect(page).toHaveURL(new RegExp(`/projects/${key.toLowerCase()}/welcome$`));
    await expect(page.locator(".prio-welcome__project")).toHaveText(name);

    // Search. Its project results are the rows that link into /projects.
    await page.goto(`/search?q=${encodeURIComponent(name)}`);
    const hrefs = await page
      .locator('a.prio-relatedrow[href^="/projects/"]')
      .evaluateAll((links) => links.map((l) => l.getAttribute("href")!));
    expect(hrefs.length, "the project is among the search results").toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(href, "a project result opens Welcome").toMatch(/\/welcome$/);
    }
  });

  test("coming back to a project from inside it goes to the workspace", async ({
    page,
  }) => {
    /*
     * The counterpart rule. Following "back to project" from an issue is not
     * picking a project — it is returning to one you are already in — and being
     * shown the introduction again would be a step backwards. The project's
     * base path redirects into the workspace for exactly that reason, which
     * also keeps every existing link and every `revalidatePath` working.
     */
    await page.goto("/projects/eng");
    await expect(page).toHaveURL(/\/projects\/eng\/summary$/);
    await expect(page.locator(".prio-summary__grid")).toBeVisible();
  });

  test("browser back retraces the route without losing the project", async ({
    page,
  }) => {
    await page.goto("/");
    await page.locator(".prio-projrow").filter({ hasText: "ENG" }).first().click();
    await expect(page).toHaveURL(/\/projects\/eng\/welcome$/);

    await page.getByRole("link", { name: "Go to Project" }).click();
    await expect(page).toHaveURL(/\/projects\/eng\/summary$/);

    /* Scoped to the project's own tab strip: "Flow Board" is also the sidebar's
       global board, and clicking that one would leave the project — which is
       the opposite of what this test is about. */
    await page
      .getByRole("navigation", { name: "Project views" })
      .getByRole("link", { name: "Flow Board" })
      .click();
    await expect(page).toHaveURL(/\/projects\/eng\/board$/);

    // …and back out again, one step at a time, arriving where it began.
    await page.goBack();
    await expect(page).toHaveURL(/\/projects\/eng\/summary$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/projects\/eng\/welcome$/);
    await page.goBack();
    await expect(page).toHaveURL(/localhost:3000\/$/);
  });
});

/* ------------------------------------------------------- the Welcome page */

for (const key of ["ENG", "WEB"]) {
  test.describe(`${key} Welcome`, () => {
    test("says what the database says about this project", async ({ page }) => {
      const truth = await truthFor(key);
      await page.goto(`/projects/${key.toLowerCase()}/welcome`);

      // The project it names is the project in the route.
      await expect(page.locator(".prio-welcome__card .prio-key")).toHaveText(
        truth.key,
      );
      await expect(page.locator(".prio-welcome__project")).toHaveText(
        truth.name,
      );

      // Its monogram comes from its own key, not from a fixed pair of letters.
      await expect(page.locator(".prio-welcome__badge")).toHaveText(
        truth.key.slice(0, 2),
      );

      // The lead is the person who created it, and the counts are its own.
      expect(await fact(page, "Project lead")).toContain(truth.createdBy.name);
      expect(Number(await fact(page, "Open issues"))).toBe(truth.open);
      expect(Number(await fact(page, "Team members"))).toBe(
        truth._count.members,
      );

      // A role is stated rather than left blank.
      expect((await fact(page, "Your role")).length).toBeGreaterThan(0);

      // The CTA goes to this project's workspace, never a hard-coded one.
      await expect(
        page.getByRole("link", { name: "Go to Project" }),
      ).toHaveAttribute("href", `/projects/${key.toLowerCase()}/summary`);
    });

    test("carries the members it actually has", async ({ page }) => {
      const truth = await truthFor(key);
      await page.goto(`/projects/${key.toLowerCase()}/welcome`);

      const stack = page.locator(".prio-welcome__members .prio-avatar");
      if (truth._count.members === 0) {
        await expect(page.locator(".prio-welcome__members")).toHaveCount(0);
        return;
      }

      /* Never more avatars than the project has people — the overflow chip
         carries the remainder as `+N` rather than the stack growing. */
      expect(await stack.count()).toBeLessThanOrEqual(
        Math.min(truth._count.members, 7),
      );

      const names = await prisma.projectMember.findMany({
        where: { projectId: truth.id },
        select: { user: { select: { name: true } } },
      });
      const real = new Set(names.map((m) => m.user.name));

      /* Each avatar carries the person it stands for as its title -- the
         overflow chip carries "N more" instead, which is the one that is not
         a member's name. */
      const titles = await stack.evaluateAll((nodes) =>
        nodes.map((n) => n.getAttribute("title") ?? ""),
      );
      for (const title of titles) {
        if (/^\d+ more$/.test(title)) continue;
        expect(real.has(title), `${title} is a member of ${key}`).toBe(true);
      }
    });
  });
}

/* -------------------------------------------------------- authorization */

test.describe("Welcome authorization", () => {
  test.use({ storageState: MEMBER_STATE });

  test("a project the member is not on is not introduced either", async ({
    page,
  }) => {
    const member = await prisma.user.findFirstOrThrow({
      where: { email: "priya.nair@symbiosystech.com" },
      select: { id: true },
    });

    const forbidden = await prisma.project.findFirst({
      where: {
        isArchived: false,
        members: { none: { userId: member.id } },
      },
      select: { key: true },
    });
    test.skip(!forbidden, "this member is on every project");

    /* The Welcome page must not be a way around project scope: it answers
       exactly as that project's Summary would — not found, rather than an
       introduction to a project they cannot open. */
    await page.goto(`/projects/${forbidden!.key.toLowerCase()}/welcome`);
    await expect(page.locator(".prio-welcome__card")).toHaveCount(0);
    await expect(page.locator(".prio-notfound")).toBeVisible();

    // The same answer its Summary gives, so Welcome is not a softer door.
    await page.goto(`/projects/${forbidden!.key.toLowerCase()}/summary`);
    await expect(page.locator(".prio-summary__grid")).toHaveCount(0);
    await expect(page.locator(".prio-notfound")).toBeVisible();
  });

  test("a member reaches the workspace through Welcome like anyone else", async ({
    page,
  }) => {
    const member = await prisma.user.findFirstOrThrow({
      where: { email: "priya.nair@symbiosystech.com" },
      select: { id: true },
    });
    const allowed = await prisma.project.findFirstOrThrow({
      where: { isArchived: false, members: { some: { userId: member.id } } },
      select: { key: true },
    });
    const slug = allowed.key.toLowerCase();

    await page.goto(`/projects/${slug}/welcome`);
    await expect(page.locator(".prio-welcome__card")).toBeVisible();

    await page.getByRole("link", { name: "Go to Project" }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${slug}/summary$`));
  });
});
