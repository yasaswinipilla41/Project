import { expect, test } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { TESTING_TEAM_SLUG } from "@/lib/authz";
import { ADMIN_STATE, MEMBER_EMAIL, MEMBER_STATE } from "./support";

/**
 * The three roles, as the interface presents them.
 *
 * Prio has two account roles and three jobs: an administrator, a tester — a
 * member on the Testing team — and a developer, which is a member who is not.
 * The server rules are asserted directly in `tests/role-permissions.test.ts`
 * and `tests/issue-claim-takeover.test.ts`; hiding a control is never the
 * protection. What this walks is the other half: that each of the three is
 * shown the work they are actually allowed to do, and told which they are.
 */

async function testingTeamId(): Promise<string> {
  const team =
    (await prisma.team.findUnique({
      where: { slug: TESTING_TEAM_SLUG },
      select: { id: true },
    })) ??
    (await prisma.team.create({
      data: { slug: TESTING_TEAM_SLUG, name: "Testing" },
      select: { id: true },
    }));
  return team.id;
}

async function memberId(): Promise<string> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { email: MEMBER_EMAIL },
    select: { id: true },
  });
  return user.id;
}

/** An open issue in a project the member belongs to. */
async function anOpenIssueOfTheirs(): Promise<string> {
  const issue = await prisma.issue.findFirstOrThrow({
    where: {
      project: { members: { some: { userId: await memberId() } } },
      status: { in: ["BACKLOG", "TODO", "IN_PROGRESS"] },
    },
    orderBy: { createdAt: "desc" },
    select: { key: true },
  });
  return issue.key.toLowerCase();
}

/* ------------------------------------------------------------- developer */

test.describe("A developer", () => {
  test.use({ storageState: MEMBER_STATE });

  /* The seed puts nobody on the Testing team, so a member is a developer as
     found. The membership is removed anyway in case an earlier spec left one
     behind — these run in one worker, in order, against one database. */
  test.beforeAll(async () => {
    await prisma.teamMember.deleteMany({
      where: { teamId: await testingTeamId(), userId: await memberId() },
    });
  });

  test("is named as one on their dashboard, and is not offered the create control", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator(".prio-dash__heroaside .prio-rolebadge")).toHaveText(
      "Developer",
    );

    // Raising work is an administrator's or a tester's act.
    await expect(page.locator(".prio-create")).toHaveCount(0);
  });

  test("sees the team list, without the controls that act on people", async ({
    page,
  }) => {
    await page.goto("/");

    /* The list itself is everybody's — who is on the projects you can see, and
       how much each of them is holding. The detail control is not: what it
       opens is an administrator's read, and handing somebody work is an
       administrator's act. */
    await expect(page.getByRole("heading", { name: "Team members" })).toBeVisible();
    await expect(page.locator(".prio-team__member").first()).toBeVisible();
    await expect(
      page.locator('button[aria-label^="View details for"]'),
    ).toHaveCount(0);
  });

  test("is offered Start on an issue, and cannot hand it to somebody else", async ({
    page,
  }) => {
    await page.goto(`/issues/${await anOpenIssueOfTheirs()}`);

    /* Picking work up is theirs to do — the same control says "Take over" when
       somebody else is holding it, because they are the same act. */
    await expect(
      page.getByRole("button", { name: /^(Start|Take over)$/ }),
    ).toBeVisible();

    // Deciding who does a piece of work is not, so the assignee does not open.
    const assignee = page
      .locator(".prio-fieldtrigger:has(.prio-fieldtrigger__person)")
      .first();
    await expect(assignee).toHaveAttribute("data-readonly", /.*/);
  });
});

/* ---------------------------------------------------------------- tester */

test.describe("A tester", () => {
  test.use({ storageState: MEMBER_STATE });

  let joined: string | null = null;

  test.beforeAll(async () => {
    const [teamId, userId] = [await testingTeamId(), await memberId()];
    const already = await prisma.teamMember.findFirst({
      where: { teamId, userId },
      select: { id: true },
    });
    if (already) return;
    const added = await prisma.teamMember.create({
      data: { teamId, userId },
      select: { id: true },
    });
    joined = added.id;
  });

  test.afterAll(async () => {
    if (joined) await prisma.teamMember.deleteMany({ where: { id: joined } });
  });

  test("is named as one, may raise work, and has a queue of what is waiting", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator(".prio-dash__heroaside .prio-rolebadge")).toHaveText(
      "QA member",
    );

    await expect(page.locator(".prio-create__main")).toBeVisible();

    /* Two of these on the page by design: the quick action in the hero, and
       the queue's own count in the QA panel. This is the hero's. */
    const queue = page
      .locator(".prio-dash__actions")
      .getByRole("link", { name: "Ready for QA" });
    await expect(queue).toBeVisible();
    await queue.click();
    await expect(page).toHaveURL(/\/issues\?status=IN_REVIEW/);
  });

  test("is not offered Start — verifying is the job, not building", async ({
    page,
  }) => {
    await page.goto(`/issues/${await anOpenIssueOfTheirs()}`);
    await expect(page.getByRole("button", { name: "Start" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Take over" })).toHaveCount(0);
  });
});

/* --------------------------------------------------------- administrator */

test.describe("An administrator", () => {
  test.use({ storageState: ADMIN_STATE });

  test("is named as one, may raise work, and may decide who does it", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator(".prio-dash__heroaside .prio-rolebadge")).toHaveText("Admin");
    await expect(page.locator(".prio-create__main")).toBeVisible();

    await page.goto(`/issues/${await anOpenIssueOfTheirs()}`);
    const assignee = page
      .locator(".prio-fieldtrigger:has(.prio-fieldtrigger__person)")
      .first();
    await expect(assignee).not.toHaveAttribute("data-readonly", /.*/);
    await assignee.click();
    await expect(page.getByRole("menuitemradio").first()).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("may hand a colleague work from the team list", async ({ page }) => {
    await page.goto("/");
    await page
      .locator('button[aria-label^="View details for"]')
      .first()
      .click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Assign task / bug")).toBeVisible();
  });
});
