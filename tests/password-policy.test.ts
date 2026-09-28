import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyPassword } from "@better-auth/utils/password";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  meetsPasswordPolicy,
  PASSWORD_RULES,
  WEAK_PASSWORD_MESSAGE,
} from "@/lib/passwordPolicy";
import { createUser, changeOwnPassword, resetUserPassword } from "@/server/users";
import { signUp } from "@/server/signup";
import { actAs, actAsAnonymous } from "./helpers";
import { testHeaders } from "./setup";

/**
 * The new-password rule, at every place a password can be set.
 *
 * The rule: at least 8 characters, an uppercase letter, a lowercase letter, a
 * number and a special character. The UI shows it as a checklist, but the
 * checklist is a hint — everything below is about the server refusing, with the
 * one generic message, whichever way the request arrives.
 *
 * The fixtures are deliberately not the seed's default password.
 */

const ADMIN = "admin@symbiosystech.com";
const GOOD = "Fixture#Pass-7";

/** A password that breaks exactly one rule each. */
const WEAK: Record<string, string> = {
  "too short": "Ab1!xyz", // 7 characters
  "no uppercase": "fixture#pass-7",
  "no lowercase": "FIXTURE#PASS-7",
  "no number": "Fixture#Pass-x",
  "no special character": "FixturePass77",
};

const createdUserIds: string[] = [];

beforeAll(() => {
  process.env.ALLOW_SELF_SIGNUP = "true";
});

afterAll(async () => {
  delete process.env.ALLOW_SELF_SIGNUP;
  if (createdUserIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await prisma.$disconnect();
});

function stamp() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** A member with a known password, made the way an administrator makes one. */
async function makeMember(password = GOOD) {
  await actAs(ADMIN);
  const email = `pw-policy-${stamp()}@symbiosystech.local`;
  const created = await createUser({
    name: "Password Fixture",
    email,
    password,
    role: "MEMBER",
    projectIds: [],
  });
  if (!created.ok) throw new Error(`fixture failed: ${created.error}`);
  createdUserIds.push(created.data.id);
  return { id: created.data.id, email, password };
}

async function storedHash(userId: string): Promise<string> {
  const account = await prisma.account.findFirstOrThrow({
    where: { userId, providerId: "credential" },
    select: { password: true },
  });
  return account.password!;
}

describe("the rule itself", () => {
  it("accepts a password with all five parts", () => {
    expect(meetsPasswordPolicy(GOOD)).toBe(true);
    expect(meetsPasswordPolicy("Abcdef1!")).toBe(true); // exactly 8
  });

  for (const [name, password] of Object.entries(WEAK)) {
    it(`rejects a password with ${name}`, () => {
      expect(meetsPasswordPolicy(password)).toBe(false);
    });
  }

  it("names each rule, so the checklist and the check cannot disagree", () => {
    expect(PASSWORD_RULES.map((rule) => rule.id)).toEqual([
      "length",
      "upper",
      "lower",
      "number",
      "special",
    ]);
    // Each fixture fails precisely the rule its name says and no other.
    const failing = (password: string) =>
      PASSWORD_RULES.filter((rule) => !rule.test(password)).map((rule) => rule.id);
    expect(failing(WEAK["too short"]!)).toEqual(["length"]);
    expect(failing(WEAK["no uppercase"]!)).toEqual(["upper"]);
    expect(failing(WEAK["no lowercase"]!)).toEqual(["lower"]);
    expect(failing(WEAK["no number"]!)).toEqual(["number"]);
    expect(failing(WEAK["no special character"]!)).toEqual(["special"]);
  });

  it("does not count a space as the special character", () => {
    expect(meetsPasswordPolicy("Abcdefg 1")).toBe(false);
  });

  it("refuses non-strings and over-long passwords", () => {
    expect(meetsPasswordPolicy(undefined)).toBe(false);
    expect(meetsPasswordPolicy(12345678)).toBe(false);
    expect(meetsPasswordPolicy(`Aa1!${"x".repeat(200)}`)).toBe(false);
  });
});

describe("changing your own password", () => {
  it("accepts a password that meets every rule", async () => {
    const member = await makeMember();
    await actAs(member.email, member.password);

    const next = "Replacement#9Zed";
    const result = await changeOwnPassword({
      currentPassword: member.password,
      newPassword: next,
      confirmPassword: next,
    });

    expect(result.ok, result.ok ? "" : result.error).toBe(true);
    expect(await verifyPassword(await storedHash(member.id), next)).toBe(true);
  });

  for (const [name, weak] of Object.entries(WEAK)) {
    it(`refuses a new password with ${name}, on the New Password field`, async () => {
      const member = await makeMember();
      await actAs(member.email, member.password);
      const before = await storedHash(member.id);

      const result = await changeOwnPassword({
        currentPassword: member.password,
        newPassword: weak,
        confirmPassword: weak,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.fieldErrors?.newPassword).toBe(WEAK_PASSWORD_MESSAGE);
      expect(WEAK_PASSWORD_MESSAGE).toBe("Incorrect password");
      // The wrong-current-password error is a different field, and absent here.
      expect(result.fieldErrors?.currentPassword).toBeUndefined();
      // Nothing was written.
      expect(await storedHash(member.id)).toBe(before);
    });
  }

  it("does not say which rule failed", async () => {
    const member = await makeMember();
    await actAs(member.email, member.password);

    const messages = new Set<string | undefined>();
    for (const weak of Object.values(WEAK)) {
      const result = await changeOwnPassword({
        currentPassword: member.password,
        newPassword: weak,
        confirmPassword: weak,
      });
      if (!result.ok) messages.add(result.fieldErrors?.newPassword);
    }
    expect([...messages]).toEqual([WEAK_PASSWORD_MESSAGE]);
  });

  it("still checks the current password, as its own error", async () => {
    const member = await makeMember();
    await actAs(member.email, member.password);
    const before = await storedHash(member.id);

    const result = await changeOwnPassword({
      currentPassword: "Not#The-Password9",
      newPassword: "Replacement#9Zed",
      confirmPassword: "Replacement#9Zed",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fieldErrors?.currentPassword).toBeDefined();
    expect(result.fieldErrors?.newPassword).toBeUndefined();
    expect(await storedHash(member.id)).toBe(before);
  });

  it("never hands a hash or a password back", async () => {
    const member = await makeMember();
    await actAs(member.email, member.password);
    const hash = await storedHash(member.id);

    const results = [
      await changeOwnPassword({
        currentPassword: member.password,
        newPassword: WEAK["no number"]!,
        confirmPassword: WEAK["no number"]!,
      }),
      await changeOwnPassword({
        currentPassword: member.password,
        newPassword: "Replacement#9Zed",
        confirmPassword: "Replacement#9Zed",
      }),
    ];
    const text = JSON.stringify(results);
    expect(text).not.toContain(hash);
    expect(text).not.toContain(await storedHash(member.id));
    expect(text).not.toContain("Replacement#9Zed");
    expect(text).not.toContain(member.password);
  });

  it("refuses an unauthenticated caller", async () => {
    actAsAnonymous();
    const result = await changeOwnPassword({
      currentPassword: "x",
      newPassword: GOOD,
      confirmPassword: GOOD,
    });
    expect(result.ok).toBe(false);
  });
});

describe("an administrator setting a password", () => {
  for (const [name, weak] of Object.entries(WEAK)) {
    it(`createUser refuses a password with ${name}`, async () => {
      await actAs(ADMIN);
      const email = `pw-create-${stamp()}@symbiosystech.local`;

      const result = await createUser({
        name: "Should Not Exist",
        email,
        password: weak,
        role: "MEMBER",
        projectIds: [],
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.fieldErrors?.password).toBe(WEAK_PASSWORD_MESSAGE);
      // Refused before anything was written.
      expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
    });
  }

  it("resetUserPassword refuses a weak password and leaves the hash alone", async () => {
    const member = await makeMember();
    await actAs(ADMIN);
    const before = await storedHash(member.id);

    for (const weak of Object.values(WEAK)) {
      const result = await resetUserPassword({ userId: member.id, password: weak });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.fieldErrors?.password).toBe(WEAK_PASSWORD_MESSAGE);
    }
    expect(await storedHash(member.id)).toBe(before);

    const good = await resetUserPassword({ userId: member.id, password: "Reset#Fixture4" });
    expect(good.ok).toBe(true);
    expect(await storedHash(member.id)).not.toBe(before);
  });
});

describe("self-registration", () => {
  for (const [name, weak] of Object.entries(WEAK)) {
    it(`refuses a password with ${name}`, async () => {
      const email = `pw-signup-${stamp()}@symbiosystech.local`;
      const result = await signUp({
        name: "Signup Fixture",
        email,
        password: weak,
        confirmPassword: weak,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.fieldErrors?.password).toBe(WEAK_PASSWORD_MESSAGE);
      expect(await prisma.user.findUnique({ where: { email } })).toBeNull();
    });
  }

  it("accepts a password that meets every rule", async () => {
    const email = `pw-signup-${stamp()}@symbiosystech.local`;
    const result = await signUp({
      name: "Signup Fixture",
      email,
      password: GOOD,
      confirmPassword: GOOD,
    });
    expect(result.ok).toBe(true);

    const user = await prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
    createdUserIds.push(user.id);
  });
});

/**
 * better-auth serves its own change-password endpoint over plain HTTP. If it
 * enforced only length, it would be a way round every rule above for anybody
 * holding a session — which is what the hook in `src/lib/auth.ts` is for.
 */
describe("better-auth's own change-password endpoint", () => {
  /* Through `auth.handler` with a real Request: the same door a browser or a
     script uses, cookie and Origin header included. */
  async function callChangePassword(newPassword: string, currentPassword: string) {
    const base = process.env.BASE_URL ?? "http://localhost:3000";
    return auth.handler(
      new Request(`${base}/api/auth/change-password`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: base,
          cookie: testHeaders.current.get("cookie") ?? "",
        },
        body: JSON.stringify({ newPassword, currentPassword }),
      }),
    );
  }

  for (const [name, weak] of Object.entries(WEAK)) {
    it(`refuses a password with ${name} and changes nothing`, async () => {
      const member = await makeMember();
      await actAs(member.email, member.password);
      const before = await storedHash(member.id);

      const response = await callChangePassword(weak, member.password);

      expect(response.status).toBe(400);
      expect(JSON.stringify(await response.json())).toContain(WEAK_PASSWORD_MESSAGE);
      expect(await storedHash(member.id)).toBe(before);
    });
  }

  it("accepts a password that meets every rule", async () => {
    const member = await makeMember();
    await actAs(member.email, member.password);

    const response = await callChangePassword("Endpoint#Change5", member.password);

    expect(response.ok).toBe(true);
    expect(await verifyPassword(await storedHash(member.id), "Endpoint#Change5")).toBe(true);
  });

  it("still refuses a wrong current password", async () => {
    const member = await makeMember();
    await actAs(member.email, member.password);
    const before = await storedHash(member.id);

    const response = await callChangePassword("Endpoint#Change5", "Wrong#Current1");

    expect(response.ok).toBe(false);
    expect(await storedHash(member.id)).toBe(before);
  });
});
