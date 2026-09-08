import path from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { DEVELOPMENT_TEAM_SLUG, TESTING_TEAM_SLUG } from "@/lib/authz";
import { signIn } from "./support";

/**
 * The three working roles, walked through the running application.
 *
 * Everything here is asserted from what the browser is actually shown: the
 * badge that names the role, the figure on a tile, and the rows in the list
 * that tile opens. The server rules are pinned separately in
 * `tests/fullstack-role.test.ts` — this is the other half of the claim, that
 * what a person is *told* matches what they are allowed and what they hold.
 *
 * Three people, made here and unmade afterwards:
 *
 *   QA1   Testing only              -> QA member
 *   DEV1  neither team              -> Developer (the long-standing default)
 *   FSD1  Testing and Development   -> Full Stack Developer
 *
 * The count-versus-list cases are the invariant this suite exists for: a tile
 * says a number, the list behind it holds that many rows, and every row is the
 * reader's own.
 */

const PASSWORD = process.env.SEED_DEFAULT_PASSWORD ?? "Prio@12345";

const QA1 = "priya.nair@symbiosystech.com";
const DEV1 = "kiran.das@symbiosystech.com";
const FSD1 = "meera.pillai@symbiosystech.com";

/**
 * One stored session per person, written once by `beforeAll`.
 *
 * better-auth rate-limits sign-in to three attempts per ten seconds — real
 * brute-force protection, and a suite that signs in per test trips it. Every
 * test below opens a context from one of these instead, which is the pattern
 * `auth.setup.ts` already uses for the two shared accounts. The memberships
 * are written before any of them, so each session is established with its
 * person's teams already in place.
 */
const STATE: Record<string, string> = {
  [QA1]: path.join("test-results", ".auth", "role-qa1.json"),
  [DEV1]: path.join("test-results", ".auth", "role-dev1.json"),
  [FSD1]: path.join("test-results", ".auth", "role-fsd1.json"),
};

/** A page already signed in as `email`, plus the context to close afterwards. */
async function pageAs(
  browser: Browser,
  email: string,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ storageState: STATE[email] });
  const page = await context.newPage();
  return { page, close: () => context.close() };
}

/** Memberships this file created, removed again so the fixture is left as found. */
const created: string[] = [];

async function userIdOf(email: string): Promise<string> {
  const row = await prisma.user.findUniqueOrThrow({
    where: { email },
    select: { id: true },
  });
  return row.id;
}

async function join(email: string, slug: string): Promise<void> {
  const [userId, team] = await Promise.all([
    userIdOf(email),
    prisma.team.findUniqueOrThrow({ where: { slug }, select: { id: true } }),
  ]);
  const row = await prisma.teamMember.upsert({
    where: { teamId_userId: { teamId: team.id, userId } },
    update: {},
    create: { teamId: team.id, userId },
    select: { id: true },
  });
  created.push(row.id);
}

/** Leaves both teams, so a run never inherits the last one's state. */
async function clearTeams(email: string): Promise<void> {
  const userId = await userIdOf(email);
  await prisma.teamMember.deleteMany({
    where: {
      userId,
      team: { slug: { in: [TESTING_TEAM_SLUG, DEVELOPMENT_TEAM_SLUG] } },
    },
  });
}

test.beforeAll(async ({ browser }) => {
  for (const email of [QA1, DEV1, FSD1]) await clearTeams(email);

  await join(QA1, TESTING_TEAM_SLUG);
  await join(FSD1, TESTING_TEAM_SLUG);
  await join(FSD1, DEVELOPMENT_TEAM_SLUG);
  // DEV1 joins nothing: a member on no team is a developer.

  /*
   * Three sign-ins, spaced out.
   *
   * better-auth allows three attempts per ten seconds and this needs exactly
   * three, so doing them back to back sits right on the limit and the first
   * retry costs eleven seconds. Waiting between them is faster than being
   * throttled, and keeps the rate limit real rather than disabled for tests.
   */
  test.setTimeout(180_000);

  const people = [QA1, DEV1, FSD1];
  for (const [index, email] of people.entries()) {
    /*
     * Explicitly stateless.
     *
     * The `desktop` project carries the administrator's stored session in its
     * `use`, and a context that inherits it is already signed in — `/sign-in`
     * then redirects to the dashboard and there is no form to fill. Saying so
     * here, and clearing cookies as well, makes each of these a genuine
     * sign-in as the person named rather than a no-op as somebody else.
     */
    const context = await browser.newContext({ storageState: undefined });
    await context.clearCookies();
    const page = await context.newPage();
    await signIn(page, email, PASSWORD);
    await context.storageState({ path: STATE[email] });
    await context.close();
    if (index < people.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 11_000));
    }
  }
});

test.afterAll(async () => {
  if (created.length > 0) {
    await prisma.teamMember.deleteMany({ where: { id: { in: created } } });
  }
});

/** The badge the dashboard shows the signed-in person. */
async function roleBadge(page: Page): Promise<string> {
  const badge = page.locator(".prio-dash__heroaside .prio-rolebadge");
  await expect(badge).toBeVisible();
  return (await badge.textContent())!.trim();
}

/**
 * How many issues the list says it holds.
 *
 * `.prio-filters__total` renders "N results" and is the list's own answer, so
 * it is the figure a tile has to match — counting rows would only ever see one
 * page of a longer queue.
 */
async function listTotal(page: Page): Promise<number> {
  const total = page.locator(".prio-filters__total");
  await expect(total).toBeVisible();
  await expect(total).not.toHaveText(/Loading/);
  const text = (await total.textContent()) ?? "";
  const match = /(\d[\d,]*)/.exec(text);
  return Number((match?.[1] ?? "0").replace(/,/g, ""));
}

/** The number printed on a named "My work" tile. */
async function tileValue(page: Page, label: string): Promise<number> {
  const tile = page
    .locator(".prio-worktile")
    .filter({
      has: page.locator(".prio-worktile__label", { hasText: label }),
    })
    .first();
  await expect(tile).toBeVisible();
  const text = await tile.locator(".prio-worktile__value").textContent();
  return Number((text ?? "").trim());
}

test.describe("effective role resolution, as the application reports it", () => {
  test("Testing only is a QA member", async ({ browser }) => {
    const { page, close } = await pageAs(browser, QA1);
    try {
      await page.goto("/");
      expect(await roleBadge(page)).toBe("QA member");
    } finally {
      await close();
    }
  });

  test("neither team is a Developer", async ({ browser }) => {
    const { page, close } = await pageAs(browser, DEV1);
    try {
      await page.goto("/");
      expect(await roleBadge(page)).toBe("Developer");
    } finally {
      await close();
    }
  });

  test("Testing and Development is a Full Stack Developer", async ({
    browser,
  }) => {
    /* The rule the whole change turns on: not "QA member", not "Developer". */
    const { page, close } = await pageAs(browser, FSD1);
    try {
      await page.goto("/");
      const badge = await roleBadge(page);
      expect(badge).toBe("Full Stack Developer");
      expect(badge).not.toBe("QA member");
      expect(badge).not.toBe("Developer");
    } finally {
      await close();
    }
  });

  test("the role survives a reload", async ({ browser }) => {
    const { page, close } = await pageAs(browser, FSD1);
    try {
      await page.goto("/");
      expect(await roleBadge(page)).toBe("Full Stack Developer");
      await page.reload();
      expect(await roleBadge(page)).toBe("Full Stack Developer");
    } finally {
      await close();
    }
  });
});

test.describe("what each role is offered", () => {
  test("Create is offered to whoever raises work, and withheld from a pure developer", async ({
    browser,
  }) => {
    for (const [email, expected] of [
      [QA1, true],
      [FSD1, true],
      [DEV1, false],
    ] as const) {
      const { page, close } = await pageAs(browser, email);
      try {
        await page.goto("/");
        const create = page.locator(".prio-create__main");
        if (expected) await expect(create).toBeVisible();
        else await expect(create).toHaveCount(0);
      } finally {
        await close();
      }
    }
  });

  test("Sprints is withheld from a pure QA member and kept for a full stack one", async ({
    browser,
  }) => {
    const project = await prisma.project.findFirstOrThrow({
      where: {
        isArchived: false,
        members: { some: { userId: await userIdOf(QA1) } },
      },
      select: { key: true },
    });
    const base = `/projects/${project.key.toLowerCase()}`;

    const qa = await pageAs(browser, QA1);
    try {
      await qa.page.goto(`${base}/summary`);
      await expect(
        qa.page.locator(".prio-projectnav__tab", { hasText: "Sprints" }),
      ).toHaveCount(0);

      /* And the route refuses, so the hidden tab is not what withholds it. */
      await qa.page.goto(`${base}/sprints`);
      await expect(qa.page.locator(".prio-notfound")).toBeVisible();
    } finally {
      await qa.close();
    }

    /* A full stack developer builds, and developers read sprints. */
    const theirs = await prisma.project.findFirst({
      where: {
        isArchived: false,
        members: { some: { userId: await userIdOf(FSD1) } },
      },
      select: { key: true },
    });
    if (!theirs) return;

    const fsd = await pageAs(browser, FSD1);
    try {
      await fsd.page.goto(`/projects/${theirs.key.toLowerCase()}/summary`);
      await expect(
        fsd.page.locator(".prio-projectnav__tab", { hasText: "Sprints" }),
      ).toHaveCount(1);
    } finally {
      await fsd.close();
    }
  });
});

test.describe("a personal figure and the list it opens", () => {
  /*
   * The invariant, read off the running application rather than computed: the
   * tile says a number, the list it opens holds that many rows, and the URL it
   * went to carries the reader's own id.
   *
   * The list pages at 25, so an exact comparison is only made where the figure
   * fits on one page; a larger figure still has to fill one.
   */
  for (const [who, email] of [
    ["a QA member", QA1],
    ["a developer", DEV1],
    ["a full stack developer", FSD1],
  ] as const) {
    test(`${who}: every My work tile counts what it opens`, async ({
      browser,
    }) => {
      const { page, close } = await pageAs(browser, email);
      const id = await userIdOf(email);

      try {
        for (const label of [
          "Assigned",
          "In progress",
          "Ready for QA",
          "In QA",
          "Completed",
        ]) {
          await page.goto("/");

          const shown = await tileValue(page, label);

          const tile = page
            .locator(".prio-worktile")
            .filter({
              has: page.locator(".prio-worktile__label", { hasText: label }),
            })
            .first();
          /*
           * The tile's own destination, before following it.
           *
           * Read from the anchor rather than inferred, so this asserts the
           * deep link the interface actually offers: scoped to this person,
           * not to their team or their project.
           */
          const href = await tile.getAttribute("href");
          expect(
            href,
            `${label} link carries the reader's own assignee`,
          ).toContain(`assignee=${id}`);

          /* Then follow it for real. Waiting on the URL rather than on network
             idle, because an App Router soft navigation settles the network
             before the address bar catches up and `page.url()` would still be
             the dashboard. */
          await tile.click();
          await page.waitForURL(/\/issues\?/, { timeout: 30_000 });
          await page.waitForLoadState("networkidle");

          expect(page.url()).toContain(`assignee=${id}`);

          /*
           * The list's own total, not the rows on screen.
           *
           * A page holds 25, so counting rows would compare a figure against
           * one page of it and call any larger queue a mismatch. The list
           * prints "N results", which is the number the tile has to equal.
           */
          const listed = await listTotal(page);

          expect(
            listed,
            `${label}: tile said ${shown}, list reported ${listed}`,
          ).toBe(shown);
        }
      } finally {
        await close();
      }
    });
  }
});

test.describe("cross-user isolation", () => {
  test("a personal list holds nobody else's work", async ({ browser }) => {
    /*
     * Read from the database rather than the page: every key the list showed
     * must belong to an issue actually assigned to the reader. Counting rows
     * would pass a list that showed the right number of the wrong issues.
     */
    const { page, close } = await pageAs(browser, QA1);
    const qaId = await userIdOf(QA1);

    try {
      await page.goto(`/issues?assignee=${qaId}&resolution=open`);
      await page.waitForLoadState("networkidle");

      const keys = (await page.locator(".prio-key").allTextContents()).map((k) =>
        k.trim(),
      );
      if (keys.length === 0) return;

      const shown = await prisma.issue.findMany({
        where: { key: { in: keys } },
        select: { key: true, assigneeId: true },
      });

      for (const issue of shown) {
        expect(
          issue.assigneeId,
          `${issue.key} is not this person's work`,
        ).toBe(qaId);
      }
    } finally {
      await close();
    }
  });

  test("naming somebody else in the URL cannot widen what is visible", async ({
    browser,
  }) => {
    /*
     * `assignee` is an ordinary filter — colleagues share projects, and seeing
     * who holds what inside a project you can already open is not a leak. What
     * must hold is that the filter cannot reach *outside* the reader's project
     * scope: every row it returns is still from a project they may open.
     *
     * Checked against the database, so the claim is about the rows the server
     * was willing to return rather than about what the page chose to draw.
     */
    const devId = await userIdOf(DEV1);
    const qaId = await userIdOf(QA1);

    const qaProjects = await prisma.projectMember.findMany({
      where: { userId: qaId },
      select: { projectId: true },
    });
    const visible = new Set(qaProjects.map((p) => p.projectId));

    const { page, close } = await pageAs(browser, QA1);
    try {
      await page.goto(`/issues?assignee=${devId}`);
      await page.waitForLoadState("networkidle");

      const keys = (await page.locator(".prio-key").allTextContents()).map((k) =>
        k.trim(),
      );
      if (keys.length === 0) return; // nothing shared; nothing to assert

      const shown = await prisma.issue.findMany({
        where: { key: { in: keys } },
        select: { key: true, projectId: true },
      });

      for (const issue of shown) {
        expect(
          visible.has(issue.projectId),
          `${issue.key} came from a project the reader cannot open`,
        ).toBe(true);
      }
    } finally {
      await close();
    }
  });

  test("a project the reader does not belong to stays shut", async ({
    browser,
  }) => {
    const qaId = await userIdOf(QA1);
    const foreign = await prisma.project.findFirst({
      where: { isArchived: false, members: { none: { userId: qaId } } },
      select: { key: true },
    });
    if (!foreign) return;

    const { page, close } = await pageAs(browser, QA1);
    try {
      await page.goto(`/projects/${foreign.key.toLowerCase()}/summary`);
      await expect(page.locator(".prio-notfound")).toBeVisible();
    } finally {
      await close();
    }
  });
});
