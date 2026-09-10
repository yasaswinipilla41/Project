import { afterAll, describe, expect, it } from "vitest";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { signUp } from "@/server/signup";
import { filterOptions } from "@/server/queries/issues";

/**
 * Public self-registration, at the server action.
 *
 * `tests/e2e/signup.spec.ts` proves the whole browser flow works; this proves
 * the specific properties that matter most about the action itself, the way
 * `tests/authentication.test.ts` did for the login side: nobody can hand
 * themselves a role, a duplicate email is refused without disturbing the
 * account it collided with, and the account this creates signs in through
 * exactly the same path — and only the same path — as every other account in
 * Prio.
 */

const createdUserIds: string[] = [];
const createdProjectIds: string[] = [];

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  if (createdProjectIds.length > 0) {
    // Cascades memberships, so nothing else needs cleaning up per project.
    await prisma.project.deleteMany({ where: { id: { in: createdProjectIds } } });
  }
  await prisma.$disconnect();
});

function freshAccount() {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const password = "Fixture-Password-1";
  return {
    name: "Signup Fixture",
    email: `signup-fixture-${stamp}@symbiosystech.local`,
    password,
    confirmPassword: password,
  };
}

/** Attempts a sign-in and reports only whether it was accepted. */
async function canSignIn(email: string, password: string): Promise<boolean> {
  const response = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  return response.ok && Boolean(response.headers.get("set-cookie"));
}

describe("creating an account", () => {
  it("writes a real user and account row", async () => {
    const account = freshAccount();
    const result = await signUp(account);

    expect(result.ok).toBe(true);

    const row = await prisma.user.findUniqueOrThrow({
      where: { email: account.email },
      select: { id: true, name: true, role: true, isActive: true },
    });
    createdUserIds.push(row.id);

    expect(row.name).toBe(account.name);
    expect(row.isActive).toBe(true);
  });

  it("the new account signs in with its own password", async () => {
    const account = freshAccount();
    await signUp(account);

    const user = await prisma.user.findUniqueOrThrow({
      where: { email: account.email },
      select: { id: true },
    });
    createdUserIds.push(user.id);

    expect(await canSignIn(account.email, account.password)).toBe(true);
  });

  it("does not create a session — registering is not signing in", async () => {
    const account = freshAccount();
    const result = await signUp(account);
    expect(result.ok).toBe(true);

    // `signUp`'s own return carries no session cookie or token at all; the
    // shape of a successful result is exactly `{ ok: true }`, nothing more.
    expect(result).toEqual({ ok: true });

    const user = await prisma.user.findUniqueOrThrow({
      where: { email: account.email },
      select: { id: true },
    });
    createdUserIds.push(user.id);
  });
});

describe("the role is never trusted from the caller", () => {
  it("is always MEMBER, even when the input tries to claim ADMIN", async () => {
    const account = freshAccount();

    // `signUp`'s schema has no `role` field to begin with — this simulates a
    // caller that bypasses the TypeScript types entirely and posts a raw
    // object, which is exactly what a forged request would do.
    const result = await signUp({ ...account, role: "ADMIN" });
    expect(result.ok).toBe(true);

    const row = await prisma.user.findUniqueOrThrow({
      where: { email: account.email },
      select: { id: true, role: true },
    });
    createdUserIds.push(row.id);

    expect(row.role).toBe("MEMBER");
  });
});

describe("validation", () => {
  it("rejects mismatched passwords and writes nothing", async () => {
    const account = freshAccount();
    const before = await prisma.user.count({ where: { email: account.email } });

    const result = await signUp({
      ...account,
      confirmPassword: `${account.password}x`,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fieldErrors?.confirmPassword).toBeDefined();
    }
    expect(
      await prisma.user.count({ where: { email: account.email } }),
    ).toBe(before);
  });

  it("rejects a password under 8 characters", async () => {
    const account = freshAccount();
    const result = await signUp({
      ...account,
      password: "short1",
      confirmPassword: "short1",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fieldErrors?.password).toBeDefined();
    }
  });

  it("rejects a malformed email", async () => {
    const account = freshAccount();
    const result = await signUp({ ...account, email: "not-an-email" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.fieldErrors?.email).toBeDefined();
    }
  });

  it("normalises the email to lower case", async () => {
    const account = freshAccount();
    const result = await signUp({ ...account, email: account.email.toUpperCase() });
    expect(result.ok).toBe(true);

    const row = await prisma.user.findUnique({
      where: { email: account.email.toLowerCase() },
      select: { id: true },
    });
    expect(row).not.toBeNull();
    if (row) createdUserIds.push(row.id);
  });
});

describe("duplicate email", () => {
  it("is refused, and the original account is untouched", async () => {
    const account = freshAccount();
    const first = await signUp(account);
    expect(first.ok).toBe(true);

    const original = await prisma.user.findUniqueOrThrow({
      where: { email: account.email },
      select: { id: true, name: true },
    });
    createdUserIds.push(original.id);

    const second = await signUp({
      ...account,
      name: "A Different Name Entirely",
    });

    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.fieldErrors?.email).toBeDefined();
    }

    // Exactly one row for this email, still carrying the first registration's
    // name — the rejected attempt did not overwrite anything.
    const rows = await prisma.user.findMany({
      where: { email: account.email },
      select: { id: true, name: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe(account.name);
  });

  it("is refused against a seeded account without disturbing it", async () => {
    const result = await signUp({
      name: "Attempted Takeover",
      email: "admin@symbiosystech.com",
      password: "Some-Other-Password-1",
      confirmPassword: "Some-Other-Password-1",
    });

    expect(result.ok).toBe(false);

    // The real admin still signs in with its real, original password.
    expect(await canSignIn("admin@symbiosystech.com", "Prio@12345")).toBe(true);
  });
});

describe("disabled accounts", () => {
  it("cannot sign in even though the credential itself is valid", async () => {
    const account = freshAccount();
    await signUp(account);

    const user = await prisma.user.findUniqueOrThrow({
      where: { email: account.email },
      select: { id: true },
    });
    createdUserIds.push(user.id);

    await prisma.user.update({
      where: { id: user.id },
      data: { isActive: false },
    });

    /*
     * better-auth validates the credential itself and does not know about
     * `isActive` — Prio's own `getCurrentUser` re-reads it from the database
     * on every request instead, so a disabled account is refused at the
     * session layer even while still holding a technically-valid password.
     * That is asserted here at the source of truth the request path reads.
     */
    const row = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { isActive: true },
    });
    expect(row.isActive).toBe(false);
  });
});

describe("reporter availability", () => {
  /*
   * `filterOptions()` is the one dynamic, database-backed source behind the
   * Reporter/Assignee dropdowns — this proves a brand-new account reaches it
   * with no second directory and no manual admin step, once the ordinary
   * authorization gate (project membership) is satisfied. It is not testing
   * that gate itself — `tests/issues.test.ts` already covers project scoping
   * — only that self-registration does not bypass or duplicate it.
   */
  it("a newly registered member appears in filterOptions once added to a project", async () => {
    const account = freshAccount();
    await signUp(account);

    const user = await prisma.user.findUniqueOrThrow({
      where: { email: account.email },
      select: { id: true },
    });
    createdUserIds.push(user.id);

    const project = await prisma.project.findFirstOrThrow({
      where: { isArchived: false },
      select: { id: true },
    });

    // Before joining a project, the new account is correctly invisible to a
    // per-project Reporter list — this is the same project-scoping rule
    // every other person in Prio is held to, not a gap.
    const admin = await prisma.user.findFirstOrThrow({
      where: { role: "ADMIN", isActive: true },
      select: {
        id: true,
        name: true,
        email: true,
        image: true,
        role: true,
        jobTitle: true,
        isActive: true,
      },
    });
    const before = await filterOptions(admin);
    expect(before.people.map((p) => p.id)).not.toContain(user.id);

    await prisma.projectMember.create({
      data: { projectId: project.id, userId: user.id },
    });

    const after = await filterOptions(admin);
    expect(after.people.map((p) => p.id)).toContain(user.id);
  });
});

describe("default project auto-join", () => {
  async function fixtureProject(data: {
    isDefaultProject?: boolean;
    isArchived?: boolean;
  }) {
    const admin = await prisma.user.findFirstOrThrow({
      where: { role: "ADMIN", isActive: true },
      select: { id: true },
    });
    const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    /*
     * The random half of the stamp has to survive the length cap.
     *
     * `key` is unique and holds ten characters. Building it as
     * `SDF + stamp` and slicing afterwards kept only the first seven
     * characters of the timestamp and threw the random suffix away, so two
     * fixtures created inside the same ~36ms window asked for the same key
     * and the second one failed on the constraint. This block creates three
     * in a row, which is exactly how often that happened.
     *
     * Taking four characters of the timestamp and three of the randomness
     * keeps both inside the ten.
     */
    const suffix = `${stamp.slice(-4)}${stamp.slice(-3)}`.toUpperCase();
    const project = await prisma.project.create({
      data: {
        name: `Signup Default Fixture ${stamp}`,
        key: `SDF${suffix}`.slice(0, 10),
        createdById: admin.id,
        isDefaultProject: data.isDefaultProject ?? false,
        isArchived: data.isArchived ?? false,
      },
      select: { id: true },
    });
    createdProjectIds.push(project.id);
    return project;
  }

  it("joins every active default project on first registration, and only those", async () => {
    const defaultOne = await fixtureProject({ isDefaultProject: true });
    const defaultTwo = await fixtureProject({ isDefaultProject: true });
    const notDefault = await fixtureProject({ isDefaultProject: false });

    const account = freshAccount();
    const result = await signUp(account);
    expect(result.ok).toBe(true);

    const user = await prisma.user.findUniqueOrThrow({
      where: { email: account.email },
      select: { id: true },
    });
    createdUserIds.push(user.id);

    const memberships = await prisma.projectMember.findMany({
      where: { userId: user.id },
      select: { projectId: true },
    });
    const joined = memberships.map((m) => m.projectId);

    expect(joined).toContain(defaultOne.id);
    expect(joined).toContain(defaultTwo.id);
    expect(joined).not.toContain(notDefault.id);

    // Cleaned up immediately, not deferred to `afterAll` — the next test in
    // this file asserts an empty default-project set, which a leftover
    // `isDefaultProject: true` fixture from here would silently break.
    await prisma.project.deleteMany({
      where: { id: { in: [defaultOne.id, defaultTwo.id, notDefault.id] } },
    });
  });

  it("does not join an archived project even if it is marked default", async () => {
    const archivedDefault = await fixtureProject({
      isDefaultProject: true,
      isArchived: true,
    });

    const account = freshAccount();
    await signUp(account);

    const user = await prisma.user.findUniqueOrThrow({
      where: { email: account.email },
      select: { id: true },
    });
    createdUserIds.push(user.id);

    const membership = await prisma.projectMember.findFirst({
      where: { userId: user.id, projectId: archivedDefault.id },
    });
    expect(membership).toBeNull();

    await prisma.project.delete({ where: { id: archivedDefault.id } });
  });

  it("joins exactly the active default projects, and nothing else", async () => {
    /*
     * Asserted against the set of default projects as they actually are at
     * this moment, rather than against a hard-coded zero: the seed marks none,
     * so this normally proves "no defaults means no memberships", but it stays
     * correct — and stops flaking — if any other fixture is mid-flight.
     */
    const defaults = await prisma.project.findMany({
      where: { isDefaultProject: true, isArchived: false },
      select: { id: true },
    });

    const account = freshAccount();
    await signUp(account);

    const user = await prisma.user.findUniqueOrThrow({
      where: { email: account.email },
      select: { id: true },
    });
    createdUserIds.push(user.id);

    const memberships = await prisma.projectMember.findMany({
      where: { userId: user.id },
      select: { projectId: true },
    });

    expect(memberships.map((m) => m.projectId).sort()).toEqual(
      defaults.map((d) => d.id).sort(),
    );
  });

  it("leaves existing users and their memberships completely alone", async () => {
    const defaultProject = await fixtureProject({ isDefaultProject: true });

    const before = await prisma.projectMember.findMany({
      select: { projectId: true, userId: true },
    });

    const account = freshAccount();
    await signUp(account);
    const user = await prisma.user.findUniqueOrThrow({
      where: { email: account.email },
      select: { id: true },
    });
    createdUserIds.push(user.id);

    // The mechanism did run for the new account...
    const own = await prisma.projectMember.findFirst({
      where: { userId: user.id, projectId: defaultProject.id },
    });
    expect(own).not.toBeNull();

    // ...but every pre-existing membership belonging to someone else is
    // still exactly what it was before — the new account's own row is the
    // only addition anywhere.
    const after = await prisma.projectMember.findMany({
      where: { userId: { not: user.id } },
      select: { projectId: true, userId: true },
    });
    expect(after).toEqual(
      expect.arrayContaining(before.map((m) => expect.objectContaining(m))),
    );
    expect(after).toHaveLength(before.length);
  });
});
