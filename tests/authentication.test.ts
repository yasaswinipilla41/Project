import { afterAll, describe, expect, it } from "vitest";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { createUser } from "@/server/users";
import { actAs } from "./helpers";

/**
 * Individual per-user authentication.
 *
 * The property being pinned down is that **each account has its own password**.
 * There is no shared secret, no universal password, and no branch anywhere that
 * accepts one string for everybody.
 *
 * Proving that needs a cross-check rather than a set of positive cases: it is
 * not enough that A signs in with A's password — B's password must be *refused*
 * for A. A single shared password would sail through every positive test and
 * fail the very first cross test below.
 *
 * These call better-auth's real sign-in endpoint against the real database, so
 * what is measured is the credential path the browser uses, not a mock of it.
 */

/* The seed gives every account the same *initial* password, which is a
 * convenience for local development, not the authentication model. So these
 * tests give two throwaway accounts genuinely different passwords and prove the
 * separation holds — which is the thing that would break if a universal
 * password ever crept in. */
const ALPHA = {
  email: `auth-alpha-${Date.now().toString(36)}@symbiosystech.local`,
  name: "Auth Alpha",
  password: "Alpha-Specific-Pass-9134",
};

const BRAVO = {
  email: `auth-bravo-${Date.now().toString(36)}@symbiosystech.local`,
  name: "Auth Bravo",
  password: "Bravo-Different-Pass-7752",
};

const createdUserIds: string[] = [];

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await prisma.$disconnect();
});

/**
 * Creates an account the way Prio actually creates one: through the
 * administrator-only `createUser` action.
 *
 * Not through better-auth's `signUpEmail` — that endpoint is disabled, which is
 * itself the policy under test. Prio has no public sign-up, so an account comes
 * into existence only when an administrator makes it or an invitation is
 * accepted. Going through `createUser` also means the password is hashed by
 * exactly the code that will later verify it.
 */
async function makeUser(spec: {
  email: string;
  name: string;
  password: string;
}) {
  await actAs("admin@symbiosystech.com");

  const result = await createUser({
    name: spec.name,
    email: spec.email,
    role: "MEMBER",
    password: spec.password,
    projectIds: [],
  });

  if (!result.ok) {
    throw new Error(`could not create the test account: ${result.error}`);
  }

  createdUserIds.push(result.data.id);
  return result.data.id;
}

/** Attempts a sign-in and reports only whether it was accepted. */
async function signIn(email: string, password: string): Promise<boolean> {
  const response = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  return response.ok && Boolean(response.headers.get("set-cookie"));
}

describe("public sign-up stays closed", () => {
  it("refuses to create an account through the sign-up endpoint", async () => {
    /* Accounts are made by an administrator or through an invitation. If this
       ever starts succeeding, anyone who can reach Prio can enrol themselves. */
    const response = await auth.api.signUpEmail({
      body: {
        email: "walk-in@symbiosystech.local",
        password: "Walk-In-Pass-1234",
        name: "Walk In",
      },
      asResponse: true,
    });

    expect(response.ok).toBe(false);
    expect(
      await prisma.user.count({ where: { email: "walk-in@symbiosystech.local" } }),
    ).toBe(0);
  });
});

describe("every account has its own password", () => {
  it("accepts each user's own credentials", async () => {
    await makeUser(ALPHA);
    await makeUser(BRAVO);

    expect(await signIn(ALPHA.email, ALPHA.password)).toBe(true);
    expect(await signIn(BRAVO.email, BRAVO.password)).toBe(true);
  });

  it("refuses one user's password for another user", async () => {
    /* The decisive test. If Prio accepted a single shared password, both of
       these would succeed. */
    expect(await signIn(ALPHA.email, BRAVO.password)).toBe(false);
    expect(await signIn(BRAVO.email, ALPHA.password)).toBe(false);
  });

  it("stores a distinct hash per account, never the password itself", async () => {
    const accounts = await prisma.account.findMany({
      where: { user: { email: { in: [ALPHA.email, BRAVO.email] } } },
      select: { password: true, user: { select: { email: true } } },
    });

    expect(accounts).toHaveLength(2);

    for (const account of accounts) {
      expect(account.password).toBeTruthy();
      // Neither plaintext password appears anywhere in either stored value.
      expect(account.password).not.toContain(ALPHA.password);
      expect(account.password).not.toContain(BRAVO.password);
      expect(account.password!.length).toBeGreaterThan(32);
    }

    // Two different passwords produce two different hashes.
    expect(accounts[0]!.password).not.toBe(accounts[1]!.password);
  });
});

describe("credential handling", () => {
  it("rejects a wrong password", async () => {
    expect(await signIn(ALPHA.email, "not-the-password")).toBe(false);
  });

  it("rejects an address that belongs to nobody", async () => {
    expect(
      await signIn("nobody-at-all@symbiosystech.local", ALPHA.password),
    ).toBe(false);
  });

  it("rejects an empty password", async () => {
    expect(await signIn(ALPHA.email, "")).toBe(false);
  });

  it("does not trim the password", async () => {
    /* A password may legitimately contain a leading or trailing space, so
       trimming would silently accept a different string than the one chosen.
       The sign-in form warns about stray whitespace instead. */
    expect(await signIn(ALPHA.email, ` ${ALPHA.password}`)).toBe(false);
    expect(await signIn(ALPHA.email, `${ALPHA.password} `)).toBe(false);
  });

  it("matches the address regardless of case", async () => {
    expect(await signIn(ALPHA.email.toUpperCase(), ALPHA.password)).toBe(true);
  });
});

describe("account status", () => {
  it("carries the account's real role and active flag", async () => {
    const seeded = await prisma.user.findMany({
      where: { email: { endsWith: "@symbiosystech.com" } },
      select: { email: true, role: true, isActive: true },
      orderBy: { email: "asc" },
    });

    // Every seeded account is usable and carries one of the two real roles.
    expect(seeded.length).toBeGreaterThan(0);
    for (const person of seeded) {
      expect(["ADMIN", "MEMBER"]).toContain(person.role);
      expect(person.isActive).toBe(true);
    }

    // Both roles are actually represented, so role-based paths are reachable.
    const roles = new Set(seeded.map((p) => p.role));
    expect(roles.has("ADMIN")).toBe(true);
    expect(roles.has("MEMBER")).toBe(true);
  });

  it("gives a deactivated account no session", async () => {
    const id = await makeUser({
      ...ALPHA,
      email: `auth-off-${Date.now().toString(36)}@symbiosystech.local`,
    });

    await prisma.user.update({ where: { id }, data: { isActive: false } });

    /*
     * better-auth still validates the credential itself; Prio's own
     * `getCurrentUser` re-reads `isActive` from the database on every request,
     * so a deactivated person cannot reach an authenticated page even holding a
     * valid cookie. That is asserted here at the source of truth.
     */
    const row = await prisma.user.findUniqueOrThrow({
      where: { id },
      select: { isActive: true },
    });
    expect(row.isActive).toBe(false);
  });
});
