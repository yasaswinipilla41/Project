import { expect, test } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { formatDate } from "@/lib/format";

/**
 * Moving an issue out of a sprint, from the card it is read on.
 *
 * The menu's own "next sprint" is worked out the same way it always was —
 * the soonest open sprint on or after the one the issue is in — but it is no
 * longer a generic "Next sprint" entry: it is named and dated like every
 * other destination the menu offers, so a project with more than one
 * candidate is never asked to guess which "Next sprint" it would have been.
 *
 * The first case is the point the naming used to get wrong: two boards over
 * the same fortnight, where a strict "later than" comparison found nothing
 * and reported "No future Sprint is available." while the project's own
 * Sprints page listed the sprint it should have offered. This drives the real
 * menu and then checks three things the move has to leave true: the issue is
 * in the other sprint, its status is untouched, and both sprints' figures
 * have followed it.
 *
 * The second describe covers the other half of the same question: a project
 * with nowhere to move to should not offer a sprint destination at all —
 * only Restore (when there is somewhere to restore to) and Backlog, neither
 * of which can ever fail the way a phantom "next sprint" entry did.
 */

const createdProjects: string[] = [];

test.afterAll(async () => {
  for (const id of createdProjects) {
    await prisma.issue.deleteMany({ where: { projectId: id } });
    await prisma.sprint.deleteMany({ where: { projectId: id } });
    await prisma.project.deleteMany({ where: { id } });
  }
});

/**
 * A project with two open sprints **on the same dates** and one in-progress
 * issue in the first of them.
 *
 * The shared dates are the point: a fixture whose sprints ran one after the
 * other passed while the bug was there.
 */
async function seedSameDaySprints() {
  const admin = await prisma.user.findFirstOrThrow({
    where: { role: "ADMIN" },
    select: { id: true },
  });
  const key = `MV${Date.now().toString(36).toUpperCase()}`.slice(0, 10);
  const project = await prisma.project.create({
    data: {
      key,
      name: `Sprint move fixture ${key}`,
      createdById: admin.id,
      members: { create: { userId: admin.id } },
      issueSequence: 1,
    },
    select: { id: true, key: true },
  });
  createdProjects.push(project.id);

  const dates = {
    startDate: new Date(),
    endDate: new Date(Date.now() + 13 * 86_400_000),
  };
  const [from, to] = await Promise.all([
    prisma.sprint.create({
      data: {
        name: `E2E move source ${Date.now()}`,
        ...dates,
        projectId: project.id,
        createdById: admin.id,
      },
      select: { id: true, name: true },
    }),
    prisma.sprint.create({
      data: {
        name: `E2E move destination ${Date.now()}`,
        ...dates,
        projectId: project.id,
        createdById: admin.id,
      },
      select: { id: true, name: true },
    }),
  ]);

  const issue = await prisma.issue.create({
    data: {
      projectId: project.id,
      key: `${project.key}-1`,
      number: 1,
      title: "Work that outlives its sprint",
      type: "TASK",
      status: "IN_PROGRESS",
      reporterId: admin.id,
      sprintId: from.id,
    },
    select: { id: true, key: true },
  });

  return { key: project.key.toLowerCase(), from, to, issue, dates };
}

/** A project with one sprint and one issue in it: nowhere to move on to. */
async function seedLonelySprint() {
  const admin = await prisma.user.findFirstOrThrow({
    where: { role: "ADMIN" },
    select: { id: true },
  });
  const key = `LN${Date.now().toString(36).toUpperCase()}`.slice(0, 10);
  const project = await prisma.project.create({
    data: {
      key,
      name: `Lonely sprint fixture ${key}`,
      createdById: admin.id,
      members: { create: { userId: admin.id } },
      issueSequence: 1,
    },
    select: { id: true, key: true },
  });
  createdProjects.push(project.id);

  const sprint = await prisma.sprint.create({
    data: {
      name: `E2E only sprint ${Date.now()}`,
      startDate: new Date(),
      endDate: new Date(Date.now() + 13 * 86_400_000),
      projectId: project.id,
      createdById: admin.id,
      status: "ACTIVE",
    },
    select: { id: true, name: true },
  });

  const issue = await prisma.issue.create({
    data: {
      projectId: project.id,
      key: `${project.key}-1`,
      number: 1,
      title: "Work with nowhere to go",
      type: "TASK",
      status: "IN_PROGRESS",
      reporterId: admin.id,
      sprintId: sprint.id,
    },
    select: { id: true, key: true },
  });

  return { key: project.key.toLowerCase(), sprint, issue };
}

/**
 * A sprint with one Done issue and one still in progress, and a second open
 * sprint either of them could otherwise be sent to.
 */
async function seedDoneAndOpen() {
  const admin = await prisma.user.findFirstOrThrow({
    where: { role: "ADMIN" },
    select: { id: true },
  });
  const key = `DN${Date.now().toString(36).toUpperCase()}`.slice(0, 10);
  const project = await prisma.project.create({
    data: {
      key,
      name: `Done move fixture ${key}`,
      createdById: admin.id,
      members: { create: { userId: admin.id } },
      issueSequence: 2,
    },
    select: { id: true, key: true },
  });
  createdProjects.push(project.id);

  const dates = {
    startDate: new Date(),
    endDate: new Date(Date.now() + 13 * 86_400_000),
  };
  const sprint = await prisma.sprint.create({
    data: {
      name: `E2E done source ${Date.now()}`,
      ...dates,
      projectId: project.id,
      createdById: admin.id,
      status: "ACTIVE",
      startedAt: dates.startDate,
    },
    select: { id: true },
  });
  await prisma.sprint.create({
    data: {
      name: `E2E done elsewhere ${Date.now()}`,
      startDate: new Date(Date.now() + 14 * 86_400_000),
      endDate: new Date(Date.now() + 27 * 86_400_000),
      projectId: project.id,
      createdById: admin.id,
    },
  });

  const issue = (number: number, status: "DONE" | "IN_PROGRESS") =>
    prisma.issue.create({
      data: {
        projectId: project.id,
        key: `${project.key}-${number}`,
        number,
        title: status === "DONE" ? "Finished here" : "Still going",
        type: "TASK",
        status,
        reporterId: admin.id,
        sprintId: sprint.id,
      },
      select: { id: true, key: true },
    });

  return {
    key: project.key.toLowerCase(),
    sprintId: sprint.id,
    done: await issue(1, "DONE"),
    open: await issue(2, "IN_PROGRESS"),
  };
}

test.describe("Move to · the sprints it lists", () => {
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ] as const) {
    for (const theme of ["light", "dark"] as const) {
      test(`show each sprint's name and both dates in full (${width}px, ${theme})`, async ({
        page,
      }) => {
        /*
         * The menu was a fixed 220px with one ellipsised line per row, so a
         * sprint's dates were cut off. Each row is the sprint's name, then its
         * start and end dates — "Sep 28, 2026 – Oct 5, 2026" — and nothing in
         * it may be clipped: not the dates, and not a very long name either.
         */
        const admin = await prisma.user.findFirstOrThrow({
          where: { role: "ADMIN" },
          select: { id: true },
        });
        const key = `MD${Date.now().toString(36).toUpperCase()}`.slice(0, 10);
        const project = await prisma.project.create({
          data: {
            key,
            name: `Move dates fixture ${key}`,
            createdById: admin.id,
            members: { create: { userId: admin.id } },
            issueSequence: 1,
          },
          select: { id: true, key: true },
        });
        createdProjects.push(project.id);
        const day = 86_400_000;
        const current = await prisma.sprint.create({
          data: {
            name: `Current ${Date.now()}`,
            startDate: new Date(Date.now() - 2 * day),
            endDate: new Date(Date.now() + 11 * day),
            projectId: project.id,
            createdById: admin.id,
            status: "ACTIVE",
            startedAt: new Date(Date.now() - 2 * day),
          },
          select: { id: true },
        });
        const next = await prisma.sprint.create({
          data: {
            name: "Payments reconciliation and ledger export hardening sprint",
            startDate: new Date(Date.now() + 12 * day),
            endDate: new Date(Date.now() + 25 * day),
            projectId: project.id,
            createdById: admin.id,
          },
          select: { name: true, startDate: true, endDate: true },
        });
        const issue = await prisma.issue.create({
          data: {
            projectId: project.id,
            key: `${project.key}-1`,
            number: 1,
            title: "Work to move",
            type: "TASK",
            status: "IN_PROGRESS",
            reporterId: admin.id,
            sprintId: current.id,
          },
          select: { key: true },
        });

        await page.setViewportSize({ width, height });
        await page.goto(
          `/projects/${project.key.toLowerCase()}/sprints/${current.id}`,
        );
        await page.evaluate(
          (value) => document.documentElement.setAttribute("data-theme", value),
          theme,
        );
        const card = page
          .locator(".prio-board__card")
          .filter({ hasText: issue.key });
        await card.hover();
        await card
          .getByRole("button", {
            name: new RegExp(`Move ${issue.key} to another`),
          })
          .click();
        const menu = page.getByRole("menu", { name: `Move ${issue.key}` });

        /* The row, named in words: the sprint, then its two dates. */
        const dates = `${formatDate(next.startDate)} – ${formatDate(next.endDate)}`;
        await expect(
          menu.getByRole("menuitem", { name: `${next.name} ${dates}` }),
        ).toBeVisible();

        const seen = await menu.evaluate((node) => {
          const panel = node.getBoundingClientRect();
          const contentRight = panel.left + node.clientLeft + node.clientWidth;
          const row = node
            .querySelector(".prio-movesprint__dates")!
            .closest(".prio-menu__itemlabel") as HTMLElement;
          const datesEl = row.querySelector(".prio-movesprint__dates")!;
          const range = document.createRange();
          range.selectNodeContents(datesEl);
          const lines = Array.from(range.getClientRects()).filter(
            (r) => r.width > 0,
          );
          return {
            text: datesEl.textContent!.trim(),
            clipped: row.scrollWidth > row.clientWidth + 1,
            oneLine: new Set(lines.map((r) => Math.round(r.top))).size === 1,
            inside: Math.max(...lines.map((r) => r.right)) <= contentRight,
            sideways: node.scrollWidth > node.clientWidth,
            onScreen: panel.left >= 0 && panel.right <= window.innerWidth,
            colour: getComputedStyle(datesEl).color,
            background: getComputedStyle(node).backgroundColor,
          };
        });

        expect(seen.text).toBe(dates);
        expect(seen.clipped, "row is cut off").toBe(false);
        expect(seen.oneLine, "the dates break across lines").toBe(true);
        expect(seen.inside, "the dates run past the menu").toBe(true);
        expect(seen.sideways, "the menu scrolls sideways").toBe(false);
        expect(seen.onScreen, "the menu is off the screen").toBe(true);
        /* Readable in this theme: the dates are not drawn in the menu's own
           background colour. */
        expect(seen.colour).not.toBe(seen.background);
      });
    }
  }
});

test.describe("Move to · a Done issue", () => {
  test("is not shown for Done, and unchanged for every other status", async ({
    page,
  }) => {
    const { key, sprintId, done, open } = await seedDoneAndOpen();
    await page.goto(`/projects/${key}/sprints/${sprintId}`);

    /* The Done card has no Move control at all — while its ⋮ menu, and the
       actions in it, are still there. */
    const doneCard = page
      .locator(".prio-board__card")
      .filter({ hasText: done.key });
    await doneCard.hover();
    const doneActions = doneCard.getByRole("button", {
      name: `Actions for ${done.key}`,
    });
    await expect(doneActions).toBeVisible();
    await expect(doneCard.getByRole("button", { name: /^Move / })).toHaveCount(
      0,
    );
    await doneActions.click();
    await expect(page.getByRole("menuitem").first()).toBeVisible();
    await page.keyboard.press("Escape");

    /* Every other status keeps the control exactly as it was. */
    const openCard = page
      .locator(".prio-board__card")
      .filter({ hasText: open.key });
    await openCard.hover();
    const openMove = openCard.getByRole("button", {
      name: new RegExp(`Move ${open.key} to another`),
    });
    await expect(openMove).toBeEnabled();
    await openMove.click();
    await expect(
      page
        .getByRole("menu", { name: `Move ${open.key}` })
        .getByRole("menuitem", { name: /E2E done elsewhere/ }),
    ).toBeVisible();

    /* And nothing about the Done issue changed. */
    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: done.id },
        select: { sprintId: true, status: true },
      }),
    ).toMatchObject({ sprintId, status: "DONE" });
  });
});

test.describe("Move to · when there is no next sprint", () => {
  test("says so, and never offers the backlog", async ({ page }) => {
    const { key, sprint, issue } = await seedLonelySprint();

    await page.goto(`/projects/${key}/sprints/${sprint.id}`);

    const card = page
      .locator(".prio-board__card")
      .filter({ hasText: issue.key });
    await card.hover();
    await card
      .getByRole("button", { name: new RegExp(`Move ${issue.key} to another`) })
      .click();

    const menu = page.getByRole("menu", { name: `Move ${issue.key}` });

    /* Nowhere to send it: the project's only sprint is the one on screen, so
       no sprint destination is offered at all — not the phantom entry that
       used to sit here regardless, and not the sprint itself. */
    await expect(menu.getByRole("menuitem", { name: sprint.name })).toHaveCount(
      0,
    );

    /* It says so rather than opening onto nothing — and the backlog is not
       offered in the sprints' place: this menu moves work between sprints
       only. */
    await expect(menu).toContainText("No upcoming sprints available");
    await expect(menu.getByRole("menuitem", { name: /Backlog/ })).toHaveCount(
      0,
    );
    await expect(menu.getByRole("menuitem")).toHaveCount(0);

    /* Nothing was moved by opening it. */
    expect(
      (
        await prisma.issue.findUniqueOrThrow({
          where: { id: issue.id },
          select: { sprintId: true },
        })
      ).sprintId,
    ).toBe(sprint.id);
  });
});

test.describe("Move to · next sprint", () => {
  test("moves the issue to the next sprint even when both sprints run the same dates", async ({
    page,
  }) => {
    const { key, from, to, issue, dates } = await seedSameDaySprints();

    await page.goto(`/projects/${key}/sprints/${from.id}`);
    await expect(page.locator(".prio-sprint__total")).toHaveText(
      "Total Issues: 1",
    );

    const card = page
      .locator(".prio-board__card")
      .filter({ hasText: issue.key });
    await card.hover();
    await card
      .getByRole("button", { name: new RegExp(`Move ${issue.key} to another`) })
      .click();

    /* Named and dated, not a generic "Next sprint" that could only ever say
       so much — and proof on its own that the same-day comparison still
       finds it: an entry that insisted on a strictly later date would have
       nothing here to be named after. */
    const menu = page.getByRole("menu", { name: `Move ${issue.key}` });
    await expect(
      menu.getByRole("menuitem", {
        name: `${to.name} ${formatDate(dates.startDate)} – ${formatDate(dates.endDate)}`,
      }),
    ).toBeVisible();
    await menu.getByRole("menuitem", { name: to.name }).click();

    /* Where it went, said in the words the person gets — and never "No
       future Sprint is available." */
    await expect(page.getByText(`moved to ${to.name}`)).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("No future Sprint is available.")).toHaveCount(
      0,
    );

    /* Out of this sprint, into that one, with the status it had. */
    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: issue.id },
        select: { sprintId: true, status: true },
      }),
    ).toMatchObject({ sprintId: to.id, status: "IN_PROGRESS" });

    /* And both sprints' own figures have followed it, because nothing
       stores them. */
    await expect(page.locator(".prio-sprint__total")).toHaveText(
      "Total Issues: 0",
    );
    await page.goto(`/projects/${key}/sprints/${to.id}`);
    await expect(page.locator(".prio-sprint__total")).toHaveText(
      "Total Issues: 1",
    );
    await expect(
      page.locator(".prio-board__card").filter({ hasText: issue.key }),
    ).toBeVisible();
  });
});
