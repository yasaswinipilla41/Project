import { expect, test, type Page } from "@playwright/test";
import { prisma } from "@/lib/prisma";

/**
 * A project's Sprints page, read as three groups.
 *
 * The page exists to answer two questions — what is being worked now, and what
 * comes next — and every sprint the team has ever closed used to sit in the
 * same column underneath them. The live sprints are now their own groups, each
 * with its own empty state, and the record is behind a control.
 *
 * What is asserted here is the behaviour rather than the markup: which sprint
 * is under which heading, that a closed sprint is out of the way until asked
 * for and whole when it is, that the empty states say what is actually empty,
 * and that a project with no history is offered no control at all — a dropdown
 * that opens onto nothing is worse than no dropdown.
 */

const createdProjects: string[] = [];

test.afterAll(async () => {
  for (const id of createdProjects) {
    await prisma.issue.deleteMany({ where: { projectId: id } });
    await prisma.sprint.deleteMany({ where: { projectId: id } });
    await prisma.projectMember.deleteMany({ where: { projectId: id } });
    await prisma.project.deleteMany({ where: { id } });
  }
});

function dates(offsetDays: number) {
  const start = new Date();
  start.setDate(start.getDate() + offsetDays);
  const end = new Date(start);
  end.setDate(end.getDate() + 13);
  return { startDate: start, endDate: end };
}

type Want = "active" | "upcoming" | "completed";

/** A project of this spec's own, holding exactly the sprints asked for. */
async function seedProject(wanted: readonly Want[]) {
  const admin = await prisma.user.findFirstOrThrow({
    where: { role: "ADMIN" },
    select: { id: true },
  });

  const stamp = Date.now().toString(36).toUpperCase();
  const project = await prisma.project.create({
    data: {
      key: `GRP${stamp}`.slice(0, 10),
      name: `Sprint groups fixture ${stamp}`,
      createdById: admin.id,
      members: { create: { userId: admin.id } },
    },
    select: { id: true, key: true },
  });
  createdProjects.push(project.id);

  const names: Record<Want, string> = {
    active: `E2E running ${stamp}`,
    upcoming: `E2E next ${stamp}`,
    completed: `E2E closed ${stamp}`,
  };

  for (const want of wanted) {
    await prisma.sprint.create({
      data: {
        projectId: project.id,
        createdById: admin.id,
        name: names[want],
        ...(want === "active"
          ? { status: "ACTIVE" as const, startedAt: new Date(), ...dates(0) }
          : want === "completed"
            ? {
                status: "COMPLETED" as const,
                completedAt: new Date(),
                ...dates(-28),
              }
            : dates(14)),
      },
    });
  }

  return { key: project.key.toLowerCase(), names };
}

/** The sprint card carrying this name. */
function sprintCard(page: Page, name: string) {
  return page.locator(".prio-sprint").filter({ hasText: name });
}

test.describe("The Sprints page groups", () => {
  test("puts the running sprint under Active and the planned one under Upcoming", async ({
    page,
  }) => {
    const { key, names } = await seedProject(["active", "upcoming"]);
    await page.goto(`/projects/${key}/sprints`);

    await expect(
      page.locator(".prio-sprints__section", { hasText: /Active sprint/i }),
    ).toBeVisible();
    await expect(
      page.locator(".prio-sprints__section", { hasText: /Upcoming sprints/i }),
    ).toBeVisible();

    /* Both live sprints are on the page, in the document order the groups put
       them in: the running one first, the planned one after it. */
    const cards = page.locator(".prio-sprint");
    await expect(cards.nth(0)).toContainText(names.active);
    await expect(cards.nth(1)).toContainText(names.upcoming);

    // Neither group is behind anything: no control to press, nothing hidden.
    await expect(sprintCard(page, names.active)).toBeVisible();
    await expect(sprintCard(page, names.upcoming)).toBeVisible();
  });

  test("says so when nothing is running, and when nothing is planned", async ({
    page,
  }) => {
    // Nothing running: one planned sprint and no active one.
    const planned = await seedProject(["upcoming"]);
    await page.goto(`/projects/${planned.key}/sprints`);
    await expect(page.getByText("No active sprint")).toBeVisible();
    await expect(sprintCard(page, planned.names.upcoming)).toBeVisible();
    /* The empty state is an answer, not a failure: no error, no retry. */
    await expect(page.getByText(/Unable to load/i)).toHaveCount(0);

    // Nothing planned: one running sprint and nothing after it.
    const running = await seedProject(["active"]);
    await page.goto(`/projects/${running.key}/sprints`);
    await expect(page.getByText("No upcoming sprints")).toBeVisible();
    await expect(sprintCard(page, running.names.active)).toBeVisible();
    await expect(page.getByText("No active sprint")).toHaveCount(0);
  });

  test("keeps the whole-page empty state for a project with no sprints at all", async ({
    page,
  }) => {
    /* Unchanged behaviour, asserted so the new group empty states cannot
       quietly replace it: a project that has never had a sprint gets one
       message, not three. */
    const { key } = await seedProject([]);
    await page.goto(`/projects/${key}/sprints`);

    await expect(page.getByText("No sprints yet")).toBeVisible();
    await expect(page.getByText("No active sprint")).toHaveCount(0);
    await expect(page.getByText("No upcoming sprints")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /Completed sprints/i }),
    ).toHaveCount(0);
  });
});

test.describe("Completed sprints", () => {
  test("are hidden until the control is opened, and whole when it is", async ({
    page,
  }) => {
    const { key, names } = await seedProject(["active", "completed"]);
    await page.goto(`/projects/${key}/sprints`);

    const control = page.getByRole("button", { name: /Completed sprints/i });
    await expect(control).toBeVisible();
    // The count says there is something behind it.
    await expect(control).toContainText("1");
    await expect(control).toHaveAttribute("aria-expanded", "false");

    // Collapsed: the record is not on screen, and the live sprint still is.
    await expect(sprintCard(page, names.completed)).toBeHidden();
    await expect(sprintCard(page, names.active)).toBeVisible();

    await control.click();
    await expect(control).toHaveAttribute("aria-expanded", "true");

    /* Expanded: the completed sprint is there, keeps its status, and is still
       openable — its own page is where its record is read. */
    const closed = sprintCard(page, names.completed);
    await expect(closed).toBeVisible();
    await expect(closed.locator(".prio-sprint__status")).toHaveText(
      /completed/i,
    );

    await closed.locator(".prio-sprint__identitylink").click();
    await expect(page).toHaveURL(/\/sprints\/[a-z0-9]+$/i);
    await expect(
      page.getByRole("heading", { name: "Issues in this sprint" }),
    ).toBeVisible();
  });

  test("open and close from the keyboard alone", async ({ page }) => {
    const { key, names } = await seedProject(["completed"]);
    await page.goto(`/projects/${key}/sprints`);

    const control = page.getByRole("button", { name: /Completed sprints/i });
    await control.focus();
    await expect(control).toBeFocused();

    await page.keyboard.press("Enter");
    await expect(control).toHaveAttribute("aria-expanded", "true");
    await expect(sprintCard(page, names.completed)).toBeVisible();

    await page.keyboard.press(" ");
    await expect(control).toHaveAttribute("aria-expanded", "false");
    await expect(sprintCard(page, names.completed)).toBeHidden();
  });

  for (const theme of ["light", "dark"] as const) {
    test(`sit behind a control at the top right, and open above the active sprint (${theme})`, async ({
      page,
    }) => {
      const { key, names } = await seedProject([
        "active",
        "upcoming",
        "completed",
      ]);
      await page.goto(`/projects/${key}/sprints`);
      await page.evaluate(
        (value) => document.documentElement.setAttribute("data-theme", value),
        theme,
      );

      /* The control is in the page's header actions, on the same row as
         Iterations / Sprints and directly beside it. */
      const control = page.getByRole("button", { name: /Completed sprints/i });
      const iterations = page.getByRole("link", {
        name: /Iterations \/ Sprints/,
      });
      const place = await page.evaluate(() => {
        const control = document.querySelector(".prio-sprints__disclosure")!;
        const actions = control.closest(".prio-sprints__headactions");
        const link = actions?.querySelector("a");
        const a = control.getBoundingClientRect();
        const b = link!.getBoundingClientRect();
        return {
          inHeader: actions !== null,
          besideIterations: control.nextElementSibling === link,
          sameRow: Math.abs(a.top + a.height / 2 - (b.top + b.height / 2)) <= 1,
          sameHeight: Math.round(a.height) === Math.round(b.height),
        };
      });
      expect(place).toEqual({
        inHeader: true,
        besideIterations: true,
        sameRow: true,
        sameHeight: true,
      });
      await expect(iterations).toBeVisible();

      /* By default: the active sprint and the upcoming one, and no completed
         sprint on the page. */
      await expect(sprintCard(page, names.active)).toBeVisible();
      await expect(sprintCard(page, names.upcoming)).toBeVisible();
      await expect(sprintCard(page, names.completed)).toBeHidden();

      /* Opened: the completed sprint, under a heading of its own, above the
         Active sprint group — and the live sprints are still there below. */
      await control.click();
      const closed = sprintCard(page, names.completed);
      await expect(closed).toBeVisible();
      const order = await page.evaluate(() => {
        const top = (node: Element | null) =>
          node ? node.getBoundingClientRect().top : Number.NaN;
        const headings = Array.from(
          document.querySelectorAll(".prio-sprints__section"),
        );
        const heading = (text: string) =>
          headings.find((node) => node.textContent!.trim().startsWith(text)) ??
          null;
        return {
          completedHeading: top(heading("Completed sprints")),
          completedCard: top(
            document.querySelector('.prio-sprint[data-status="COMPLETED"]'),
          ),
          activeHeading: top(heading("Active sprint")),
          upcomingHeading: top(heading("Upcoming sprints")),
        };
      });
      expect(order.completedHeading).toBeLessThan(order.completedCard);
      expect(order.completedCard).toBeLessThan(order.activeHeading);
      expect(order.activeHeading).toBeLessThan(order.upcomingHeading);
      await expect(sprintCard(page, names.active)).toBeVisible();
      await expect(sprintCard(page, names.upcoming)).toBeVisible();

      /* And closes cleanly again. */
      await control.click();
      await expect(closed).toBeHidden();
    });
  }

  test("keep the page within a phone's width, open or closed", async ({
    page,
  }) => {
    const { key } = await seedProject(["active", "upcoming", "completed"]);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/projects/${key}/sprints`);
    const overflow = () =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
      );
    expect(await overflow()).toBeLessThanOrEqual(0);
    await page.getByRole("button", { name: /Completed sprints/i }).click();
    expect(await overflow()).toBeLessThanOrEqual(0);
  });

  test("offer no control at all on a project that has closed none", async ({
    page,
  }) => {
    const { key } = await seedProject(["active", "upcoming"]);
    await page.goto(`/projects/${key}/sprints`);

    await expect(
      page.getByRole("button", { name: /Completed sprints/i }),
    ).toHaveCount(0);
  });
});

test.describe("Sprint blocks on the details page", () => {
  test("give the statistics panel and the figure it opens their own borders", async ({
    page,
  }) => {
    /*
     * The blocks nested inside a sprint's card. The top-level blocks — the
     * sprint's card, the burndown panel, Issues in this sprint and its status
     * blocks, Issues by status — are covered by
     * `sprint-burndown-disclosure.spec.ts`; these two sit inside the sprint's
     * own card, where they used to be marked out by a single rule rather than
     * an edge of their own.
     */
    const { key, names } = await seedProject(["active"]);
    await page.goto(`/projects/${key}/sprints`);
    await sprintCard(page, names.active)
      .locator(".prio-sprint__identitylink")
      .click();
    await expect(page.locator(".prio-sprint__summary")).toBeVisible();

    // Opening a figure is what draws the panel below the strip.
    await page.locator(".prio-sprint__stat--button").first().click();
    await expect(page.locator(".prio-summaryview")).toBeVisible();

    const edges = await page.evaluate(() =>
      [".prio-sprint__summary", ".prio-summaryview"].map((selector) => {
        const node = document.querySelector(selector)!;
        const style = getComputedStyle(node);
        return {
          selector,
          top: style.borderTopWidth,
          right: style.borderRightWidth,
          bottom: style.borderBottomWidth,
          left: style.borderLeftWidth,
          radius: style.borderTopLeftRadius,
          style: style.borderTopStyle,
        };
      }),
    );

    for (const edge of edges) {
      expect(edge.style, `${edge.selector} border style`).toBe("solid");
      // All four sides, not a rule above and below.
      for (const side of ["top", "right", "bottom", "left"] as const) {
        expect(
          Number.parseFloat(edge[side]),
          `${edge.selector} ${side} border`,
        ).toBeGreaterThanOrEqual(1);
      }
      expect(
        Number.parseFloat(edge.radius),
        `${edge.selector} corner radius`,
      ).toBeGreaterThan(0);
    }
  });
});
