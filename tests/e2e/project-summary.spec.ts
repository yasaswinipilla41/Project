import { expect, test, type Page } from "@playwright/test";
import type { IssueStatus } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ISSUE_TYPES, OPEN_STATUSES } from "@/lib/domain";
import { dueWindow } from "@/lib/format";

/**
 * The project Summary, checked against the project's own rows.
 *
 * Every figure on the page is asserted against a query this file runs itself,
 * scoped to the same project — so a number is only correct here if it matches
 * what the database says about *that* project. Two projects are checked, and
 * the second is checked for the failure that matters most on a page like this:
 * a figure that quietly describes the whole organisation instead of the
 * project whose page it is on.
 */

/**
 * The number in a summary card, by its label.
 *
 * Matched on the card's own label element, not on the card's whole text: the
 * "Total issues" tile's hint reads "N still open", so a substring match for
 * "Open" would read the total and quietly assert the wrong number.
 */
async function card(page: Page, label: string): Promise<number> {
  const tile = page.locator(".prio-stat").filter({
    has: page.locator(".prio-stat__label", {
      hasText: new RegExp(String.raw`^\s*${label}\s*$`, "i"),
    }),
  });
  await expect(tile, `one card labelled ${label}`).toHaveCount(1);
  return firstNumber(await tile.locator(".prio-stat__value").innerText());
}

/** The first whole number in a cell, however the text around it is laid out. */
function firstNumber(text: string): number {
  const match = /-?\d+/.exec(text.replace(/[, ]/g, ""));
  return match ? Number(match[0]) : Number.NaN;
}

/** The counts the donut's legend is reporting, keyed by status label. */
async function legend(page: Page): Promise<Map<string, number>> {
  const rows = page.locator(".prio-donut__legenditem");
  const out = new Map<string, number>();
  for (let i = 0; i < (await rows.count()); i += 1) {
    const row = rows.nth(i);
    const name = (await row.locator(".prio-donut__legendlabel").innerText()).trim();
    const value = await row.locator(".prio-donut__legendvalue").innerText();
    out.set(name, firstNumber(value));
  }
  return out;
}

/** A named breakdown section's rows, as label -> count. */
async function breakdown(page: Page, title: string): Promise<Map<string, number>> {
  /* Section titles are uppercased by the stylesheet, and `innerText` reflects
     that — matched case-insensitively so the test reads the name the code
     uses rather than the one the CSS renders. */
  const section = page
    .locator(".prio-issue__section")
    .filter({
      has: page.locator(".prio-issue__section-title", {
        hasText: new RegExp(`^${title}$`, "i"),
      }),
    })
    .first();
  const rows = section.locator(".prio-breakdown__row");
  // A section that was not found would produce an empty map and assertions
  // that pass by comparing undefined with undefined.
  await expect(rows.first(), `${title} section has rows`).toBeVisible();
  const out = new Map<string, number>();
  for (let i = 0; i < (await rows.count()); i += 1) {
    const row = rows.nth(i);
    /* A label that carries an icon reads as "Epic" twice — the icon supplies
       its own accessible name. The last line is the visible text either way. */
    const raw = await row.locator(".prio-breakdown__label").innerText();
    const label = raw
      .split(/\r?\n/)
      .map((part) => part.trim())
      .filter(Boolean)
      .pop()!;
    const value = await row.locator(".prio-breakdown__value").innerText();
    out.set(label, firstNumber(value));
  }
  return out;
}

async function truthFor(key: string) {
  const project = await prisma.project.findUniqueOrThrow({
    where: { key },
    select: { id: true, name: true },
  });
  const open = { in: [...OPEN_STATUSES] };
  const { startOfToday, endOfToday, endOfWeek } = dueWindow();

  /** This project's issues in one status, straight from the database. */
  const count = (status?: IssueStatus) =>
    prisma.issue.count({
      where: { projectId: project.id, ...(status ? { status } : {}) },
    });

  const [total, done, inProgress, readyForQa, inQa, cancelled, rejected, reopened] =
    await Promise.all([
      count(),
      count("DONE"),
      count("IN_PROGRESS"),
      count("IN_REVIEW"),
      count("IN_QA"),
      count("CANCELLED"),
      count("REJECTED"),
      count("REOPENED"),
    ]);

  const [openCount, overdue, dueThisWeek, dueToday, noDueDate] = await Promise.all([
    prisma.issue.count({ where: { projectId: project.id, status: open } }),
    prisma.issue.count({
      where: { projectId: project.id, status: open, dueDate: { lt: startOfToday } },
    }),
    prisma.issue.count({
      where: {
        projectId: project.id,
        status: open,
        dueDate: { gte: startOfToday, lt: endOfWeek },
      },
    }),
    prisma.issue.count({
      where: {
        projectId: project.id,
        status: open,
        dueDate: { gte: startOfToday, lt: endOfToday },
      },
    }),
    prisma.issue.count({ where: { projectId: project.id, dueDate: null } }),
  ]);

  const byType = new Map<string, number>();
  for (const type of ISSUE_TYPES) {
    byType.set(
      type,
      await prisma.issue.count({ where: { projectId: project.id, type } }),
    );
  }

  return {
    project,
    total,
    done,
    inProgress,
    readyForQa,
    inQa,
    cancelled,
    rejected,
    reopened,
    openCount,
    overdue,
    dueThisWeek,
    dueToday,
    noDueDate,
    byType,
  };
}

for (const key of ["ENG", "WEB"]) {
  test.describe(`Project ${key} Summary`, () => {
    test("every card matches that project's own rows", async ({ page }) => {
      const truth = await truthFor(key);
      await page.goto(`/projects/${key.toLowerCase()}`);
      await expect(page.locator(".prio-stat").first()).toBeVisible();

      expect(await card(page, "Total issues")).toBe(truth.total);
      expect(await card(page, "Completed")).toBe(truth.done);
      expect(await card(page, "In Progress")).toBe(truth.inProgress);
      expect(await card(page, "Ready for QA")).toBe(truth.readyForQa);
      expect(await card(page, "Due this week")).toBe(truth.dueThisWeek);
      expect(await card(page, "Overdue")).toBe(truth.overdue);
      expect(await card(page, "Open")).toBe(truth.openCount);

      /* Completed is DONE alone. Cancelled and Rejected are closed too, and
         are reported apart from it so the completion rate cannot be flattered
         by work that was abandoned or turned out not to be work. */
      expect(await card(page, "Closed, not completed")).toBe(
        truth.cancelled + truth.rejected,
      );
    });

    test("the status ring reconciles with the project's issues", async ({
      page,
    }) => {
      await page.goto(`/projects/${key.toLowerCase()}`);
      await expect(page.locator(".prio-stat").first()).toBeVisible();

      /* Read after the page has rendered, so the figures compared are the ones
         the page could have seen. Earlier this was read first, which left a
         window in which the two could describe different moments. */
      const truth = await truthFor(key);

      if (truth.total === 0) {
        await expect(page.getByText("No issues yet.").first()).toBeVisible();
        return;
      }

      const shown = await legend(page);

      /* The ring is internally consistent: its centre is the sum of its own
         legend. True whatever the data is, so it holds even if the project
         gained an issue between the render and this assertion. */
      const sum = [...shown.values()].reduce((a, b) => a + b, 0);
      const centre = Number(
        await page.locator(".prio-donut__total").innerText(),
      );
      expect(sum).toBe(centre);

      // And what it is describing is this project's issue count.
      expect(centre).toBe(truth.total);

      if (truth.done > 0) expect(shown.get("Done")).toBe(truth.done);
      if (truth.inProgress > 0)
        expect(shown.get("In Progress")).toBe(truth.inProgress);
      if (truth.cancelled > 0) expect(shown.get("Cancelled")).toBe(truth.cancelled);
      if (truth.rejected > 0)
        expect(shown.get("Reject / Not an Issue")).toBe(truth.rejected);
      if (truth.reopened > 0) expect(shown.get("Reopen")).toBe(truth.reopened);
    });

    test("issue types, QA, workload and due dates are this project's", async ({
      page,
    }) => {
      const truth = await truthFor(key);
      await page.goto(`/projects/${key.toLowerCase()}`);
      if (truth.total === 0) return;

      // Types — the canonical five, each with the project's own count.
      const types = await breakdown(page, "Issue types");
      for (const type of ISSUE_TYPES) {
        const label = type.charAt(0) + type.slice(1).toLowerCase();
        expect(types.get(label), `${label} count`).toBe(truth.byType.get(type));
      }
      expect([...types.values()].reduce((a, b) => a + b, 0)).toBe(truth.total);

      // QA states.
      const qa = await breakdown(page, "QA");
      expect(qa.get("Ready for QA")).toBe(truth.readyForQa);
      expect(qa.get("In QA")).toBe(truth.inQa);
      expect(qa.get("Reopened")).toBe(truth.reopened);

      // Due dates, and the rule that matters: this week excludes overdue.
      const due = await breakdown(page, "Due dates");
      expect(due.get("Overdue")).toBe(truth.overdue);
      expect(due.get("Due this week")).toBe(truth.dueThisWeek);
      expect(due.get("Due today")).toBe(truth.dueToday);
      expect(due.get("No due date")).toBe(truth.noDueDate);

      /* Overdue work is not in the week's bucket. Asserted as the property,
         not as two numbers that happen to differ. */
      const overdueAlsoThisWeek = await prisma.issue.count({
        where: {
          projectId: truth.project.id,
          status: { in: [...OPEN_STATUSES] },
          dueDate: { lt: dueWindow().startOfToday, gte: dueWindow().startOfToday },
        },
      });
      expect(overdueAlsoThisWeek).toBe(0);

      // Workload names only people who hold this project's open work.
      const assigneeIds = await prisma.issue.findMany({
        where: {
          projectId: truth.project.id,
          status: { in: [...OPEN_STATUSES] },
          assigneeId: { not: null },
        },
        select: { assigneeId: true },
        distinct: ["assigneeId"],
      });
      const allowed = new Set(
        (
          await prisma.user.findMany({
            where: { id: { in: assigneeIds.map((r) => r.assigneeId!) } },
            select: { name: true },
          })
        ).map((u) => u.name),
      );
      allowed.add("Unassigned");

      const workload = await breakdown(page, "Open work by assignee");
      for (const name of workload.keys()) {
        expect(allowed.has(name), `${name} must hold open work here`).toBe(true);
      }
    });
  });
}

test.describe("Summary scoping", () => {
  test("two projects report different, project-specific totals", async ({
    page,
  }) => {
    const eng = await truthFor("ENG");
    const web = await truthFor("WEB");

    await page.goto("/projects/eng");
    expect(await card(page, "Total issues")).toBe(eng.total);

    await page.goto("/projects/web");
    expect(await card(page, "Total issues")).toBe(web.total);

    /* Neither page shows a global figure. The organisation-wide total is the
       number a leaked query would produce, so it is the one to rule out. */
    const everything = await prisma.issue.count();
    expect(eng.total).not.toBe(everything);
    expect(web.total).not.toBe(everything);
    expect(eng.total).not.toBe(web.total);
  });

  test("a project with no issues shows an empty state, not a fake chart", async ({
    page,
  }) => {
    const empty = await prisma.project.create({
      data: {
        name: `Summary empty ${Math.random().toString(36).slice(2, 7)}`,
        key: `SE${Date.now().toString(36).slice(-6)}`.slice(0, 10).toUpperCase(),
        createdById: (
          await prisma.user.findFirstOrThrow({
            where: { role: "ADMIN" },
            select: { id: true },
            orderBy: { createdAt: "asc" },
          })
        ).id,
      },
      select: { id: true, key: true },
    });

    try {
      await page.goto(`/projects/${empty.key.toLowerCase()}`);
      await expect(page.locator(".prio-stat").first()).toBeVisible();

      expect(await card(page, "Total issues")).toBe(0);
      expect(await card(page, "Completed")).toBe(0);

      // No ring is drawn for nothing, and the page says so instead.
      await expect(page.locator(".prio-donut")).toHaveCount(0);
      await expect(page.getByText("No issues yet.").first()).toBeVisible();
    } finally {
      await prisma.project.delete({ where: { id: empty.id } });
    }
  });
});
