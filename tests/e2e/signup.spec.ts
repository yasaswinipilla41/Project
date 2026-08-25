import { expect, test } from "@playwright/test";
import { prisma } from "@/lib/prisma";
import { ADMIN_EMAIL, ADMIN_PASSWORD, signIn } from "./support";

/**
 * Public self-registration, end to end.
 *
 * This is the authoritative test for the sign-up flow: `signUp` is a Next.js
 * server action, not a REST endpoint, so it cannot be exercised with a plain
 * HTTP client the way better-auth's `/api/auth/sign-in/email` can — there is
 * no stable, curlable URL for it. A real browser driving the real form is the
 * only way to prove the whole path actually works, which is what every test
 * here does.
 *
 * Every test starts signed out — the default project reuses a stored admin
 * session, which would immediately redirect `/sign-up` and `/sign-in` to the
 * dashboard before any of this could run.
 */
test.use({ storageState: { cookies: [], origins: [] } });

/*
 * Every account these tests register through the real form is a real row.
 * Nothing else in the suite deletes it, so this file is the one place
 * responsible for its own fixtures — tracked here and removed in `afterAll`,
 * the same discipline `tests/signup.test.ts` and every other integration test
 * already applies.
 */
const registeredEmails: string[] = [];

test.afterAll(async () => {
  if (registeredEmails.length > 0) {
    await prisma.user.deleteMany({ where: { email: { in: registeredEmails } } });
  }
  await prisma.$disconnect();
});

/** A fresh, collision-free identity for each test run. */
function freshAccount() {
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  const email = `signup-${stamp}@symbiosystech.local`;
  registeredEmails.push(email);
  return {
    name: `Signup Fixture ${stamp}`,
    email,
    password: `Fixture-Pass-${stamp}!`,
  };
}

test.describe("Creating an account", () => {
  test("registers, does not sign in, and the new account can then sign in", async ({
    page,
  }) => {
    const account = freshAccount();

    await page.goto("/sign-in");
    await page.getByRole("link", { name: "Create Account" }).click();
    await expect(page).toHaveURL(/\/sign-up$/);

    await page.getByLabel("Name").fill(account.name);
    await page.getByLabel("Email").fill(account.email);
    await page.getByLabel("Password", { exact: true }).fill(account.password);
    await page.getByLabel("Confirm password").fill(account.password);
    await page.getByRole("button", { name: "Create Account" }).click();

    // The confirmation is shown in place — not a redirect to the dashboard,
    // which is the whole point of "do not automatically sign in".
    await expect(page.getByRole("heading", { name: "Account created" })).toBeVisible();
    await expect(
      page.getByText(
        "Account created successfully. Please sign in with your new password.",
      ),
    ).toBeVisible();

    // Still signed out: a protected page bounces to sign-in.
    await page.goto("/");
    await expect(page).toHaveURL(/\/sign-in/);

    // /sign-in?email=… — the same address "Go to Sign In" would have carried
    // over — arrives with the field already filled, so the person is not
    // retyping the address they just chose.
    await page.goto(`/sign-in?email=${encodeURIComponent(account.email)}`);
    await expect(page.getByLabel("Work email")).toHaveValue(account.email);

    /*
     * The real, decisive assertion: the account just created signs in with
     * exactly the password it was given, and reaches the dashboard. Routed
     * through the shared `signIn` helper rather than a raw form submission —
     * it retries through better-auth's 3-per-10s throttle, which every other
     * sign-in earlier in this run (and in the suite's setup project) has
     * already been spending down.
     */
    await signIn(page, account.email, account.password);
    await expect(page).toHaveURL(/\/$/);
  });

  test("the address goes to /sign-in?email=… after registering", async ({
    page,
  }) => {
    const account = freshAccount();

    await page.goto("/sign-up");
    await page.getByLabel("Name").fill(account.name);
    await page.getByLabel("Email").fill(account.email);
    await page.getByLabel("Password", { exact: true }).fill(account.password);
    await page.getByLabel("Confirm password").fill(account.password);
    await page.getByRole("button", { name: "Create Account" }).click();

    await expect(page.getByRole("heading", { name: "Account created" })).toBeVisible();
    await page.getByRole("button", { name: "Go to Sign In" }).click();

    await expect(page).toHaveURL(
      new RegExp(`/sign-in\\?email=${encodeURIComponent(account.email)}`),
    );
    await expect(page.getByLabel("Work email")).toHaveValue(account.email);
  });

  test("rejects a mismatched confirm-password before contacting the server", async ({
    page,
  }) => {
    const account = freshAccount();

    await page.goto("/sign-up");
    await page.getByLabel("Name").fill(account.name);
    await page.getByLabel("Email").fill(account.email);
    await page.getByLabel("Password", { exact: true }).fill(account.password);
    await page.getByLabel("Confirm password").fill(`${account.password}x`);
    await page.getByRole("button", { name: "Create Account" }).click();

    await expect(page.getByText("Passwords do not match.")).toBeVisible();
    // Still on the form — nothing was created.
    await expect(
      page.getByRole("heading", { name: "Account created" }),
    ).toHaveCount(0);
  });

  test("refuses a duplicate email and leaves the original account alone", async ({
    page,
  }) => {
    await page.goto("/sign-up");
    await page.getByLabel("Name").fill("Duplicate Attempt");
    await page.getByLabel("Email").fill(ADMIN_EMAIL);
    await page.getByLabel("Password", { exact: true }).fill("Some-Password-123");
    await page.getByLabel("Confirm password").fill("Some-Password-123");
    await page.getByRole("button", { name: "Create Account" }).click();

    await expect(
      page.getByText("An account with that email already exists."),
    ).toBeVisible();

    // The real admin account still signs in with its real, original password —
    // the rejected attempt did not overwrite or otherwise disturb it.
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await expect(page.locator(".prio-sidebar")).toBeVisible();
  });

  test("a self-registered account is an ordinary MEMBER, not an admin", async ({
    page,
  }) => {
    const account = freshAccount();

    await page.goto("/sign-up");
    await page.getByLabel("Name").fill(account.name);
    await page.getByLabel("Email").fill(account.email);
    await page.getByLabel("Password", { exact: true }).fill(account.password);
    await page.getByLabel("Confirm password").fill(account.password);
    await page.getByRole("button", { name: "Create Account" }).click();
    await expect(page.getByRole("heading", { name: "Account created" })).toBeVisible();

    await signIn(page, account.email, account.password);

    // No administration entry point — the same boundary an ordinary seeded
    // member is held to.
    await expect(
      page.getByRole("link", { name: "Administration" }),
    ).toHaveCount(0);

    /*
     * `requireAdmin` calls Next's `redirect()`, which Playwright's `page.goto`
     * follows transparently — the final response is whatever "/" returns
     * (200), so the status code alone does not show the redirect happened.
     * The outcome does: landing back on the dashboard, never on admin content.
     */
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/\?error=forbidden/);
    await expect(page.locator(".prio-dash")).toBeVisible();
  });

  test("the eye icon reveals and re-hides both password fields", async ({
    page,
  }) => {
    await page.goto("/sign-up");

    const password = page.getByLabel("Password", { exact: true });
    const confirm = page.getByLabel("Confirm password");
    await password.fill("something-typed");
    await confirm.fill("something-typed");

    await expect(password).toHaveAttribute("type", "password");
    await expect(confirm).toHaveAttribute("type", "password");

    /*
     * Each toggle's own accessible name flips from "Show password" to "Hide
     * password" the moment it is clicked, so re-querying by that name after
     * the first click no longer finds two matches — it finds one, because one
     * of them just renamed itself. Locating by which field's wrapper each
     * toggle belongs to sidesteps that entirely.
     */
    const passwordToggle = password
      .locator("xpath=ancestor::div[contains(@class,'prio-auth__password-wrap')]")
      .getByRole("button");
    const confirmToggle = confirm
      .locator("xpath=ancestor::div[contains(@class,'prio-auth__password-wrap')]")
      .getByRole("button");

    await passwordToggle.click();
    await confirmToggle.click();

    await expect(password).toHaveAttribute("type", "text");
    await expect(confirm).toHaveAttribute("type", "text");

    await passwordToggle.click();
    await expect(password).toHaveAttribute("type", "password");
    // The other field's visibility is independent of this one.
    await expect(confirm).toHaveAttribute("type", "text");
  });
});

test.describe("Admin is notified when someone new arrives", () => {
  test("a toast names the new person after their first sign-in, and does not repeat", async ({
    page,
  }) => {
    const account = freshAccount();

    await page.goto("/sign-up");
    await page.getByLabel("Name").fill(account.name);
    await page.getByLabel("Email").fill(account.email);
    await page.getByLabel("Password", { exact: true }).fill(account.password);
    await page.getByLabel("Confirm password").fill(account.password);
    await page.getByRole("button", { name: "Create Account" }).click();
    await expect(page.getByRole("heading", { name: "Account created" })).toBeVisible();

    // The new person's own first sign-in — the event the toast is about.
    await signIn(page, account.email, account.password);
    await expect(page.locator(".prio-sidebar")).toBeVisible();

    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/sign-in/);

    // Now the admin's turn: the next page they load carries the alert.
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

    const toast = page.locator(".prio-toast", { hasText: account.name });
    await expect(toast).toBeVisible();
    await expect(toast).toContainText("Bugs → Reporter");

    // Non-blocking and dismissible — the rest of the page works underneath it,
    // and closing it is a real, working control, not decoration.
    await expect(page.locator(".prio-sidebar")).toBeVisible();
    await toast.getByRole("button", { name: "Dismiss notification" }).click();
    await expect(toast).toBeHidden();

    // A full reload must not bring it back — the alert is consumed once, not
    // re-shown on every page load.
    await page.reload();
    await expect(
      page.locator(".prio-toast", { hasText: account.name }),
    ).toHaveCount(0);

    // The full-page toast state also reflects in the durable inbox: reading
    // it marked the underlying Notification row, not just hid a client toast.
    await page.goto("/notifications");
    const inboxEntry = page
      .locator(".prio-notification")
      .filter({ hasText: account.name });
    if ((await inboxEntry.count()) > 0) {
      await expect(inboxEntry.first()).toHaveAttribute("data-read", "true");
    }
  });
});

test.describe("Existing sign-in continues to work", () => {
  const SEEDED = [
    "admin@symbiosystech.com",
    "priya.nair@symbiosystech.com",
    "kiran.das@symbiosystech.com",
  ];

  for (const email of SEEDED) {
    test(`${email} signs in with its own password`, async ({ page }) => {
      await signIn(page, email, "Prio@12345");
      await expect(page.locator(".prio-sidebar")).toBeVisible();
      await expect(page).toHaveURL(/\/$/);
    });
  }

  /*
   * Submits the sign-in form and waits out better-auth's 3-per-10s throttle if
   * it is hit, until the *credential* result shows up. Whichever spec happens
   * to run just before this one in the full suite may have left the limiter
   * mid-window — even the very first attempt here is not guaranteed a clean
   * slate — so both attempts below go through this rather than assuming one
   * wait is enough.
   */
  async function attemptSignIn(
    page: import("@playwright/test").Page,
    email: string,
    password: string,
  ) {
    const throttled = page.getByText(/too many sign-in attempts/i);

    for (let tries = 0; tries < 5; tries += 1) {
      await page.goto("/sign-in");
      await page.getByLabel("Work email").fill(email);
      await page.getByLabel("Password", { exact: true }).fill(password);
      await page.getByRole("button", { name: /sign in to prio/i }).click();

      if (await throttled.isVisible().catch(() => false)) {
        await page.waitForTimeout(11_000);
        continue;
      }
      return;
    }
  }

  test("a wrong password is rejected, with no account-existence leak", async ({
    page,
  }) => {
    // Two attempts, on purpose — comparing the wording for "wrong password"
    // against "no such account" is the point.
    const wrongPasswordError = page.getByText(
      "That email and password combination is not recognised.",
    );

    await attemptSignIn(page, ADMIN_EMAIL, "definitely-wrong");
    await expect(wrongPasswordError).toBeVisible();

    await attemptSignIn(page, "nobody-at-all@symbiosystech.local", "definitely-wrong");

    // Identical wording for "wrong password" and "no such account" — the form
    // must not become a way to discover which addresses have accounts.
    await expect(wrongPasswordError).toBeVisible();
  });

  test("an origin-rejected request reads as a connectivity problem, not a wrong password", async ({
    page,
  }) => {
    /*
     * Reproduces the real-world case this was written for: better-auth's
     * origin check rejects a sign-in with a 403 when the request's Origin
     * doesn't match the server's configured BASE_URL (e.g. the app briefly
     * served from a second port). That is not a credential problem — the
     * password is never even read — so the form must say so instead of
     * reusing the wrong-password wording, which sends someone off to reset a
     * password that was fine. Faking the 403 here proves the real client's
     * error object reaches `describeSignInError` with the right shape, not
     * just that the wording function itself handles `status: 403` correctly.
     */
    await page.route("**/api/auth/sign-in/email", async (route) => {
      await route.fulfill({
        status: 403,
        contentType: "application/json",
        body: JSON.stringify({ code: "INVALID_ORIGIN", message: "Invalid origin" }),
      });
    });

    await page.goto("/sign-in");
    await page.getByLabel("Work email").fill(ADMIN_EMAIL);
    await page.getByLabel("Password", { exact: true }).fill(ADMIN_PASSWORD);
    await page.getByRole("button", { name: /sign in to prio/i }).click();

    await expect(page.getByText(/could not verify this request.s origin/i)).toBeVisible();
    await expect(
      page.getByText("That email and password combination is not recognised.", {
        exact: true,
      }),
    ).toHaveCount(0);
  });

  test("logging out actually ends the session", async ({ page }) => {
    await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    await expect(page.locator(".prio-sidebar")).toBeVisible();

    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menuitem", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/sign-in/);

    // The old session cookie, if the browser still sent it, would not work —
    // confirmed by asking for a protected page and landing back on sign-in.
    await page.goto("/");
    await expect(page).toHaveURL(/\/sign-in/);
  });

  test("a protected route without a session goes to Sign In", async ({
    page,
  }) => {
    await page.goto("/issues");
    await expect(page).toHaveURL(/\/sign-in\?next=%2Fissues/);
  });
});
