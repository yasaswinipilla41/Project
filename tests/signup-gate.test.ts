import { afterAll, afterEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  SELF_SIGNUP_DISABLED_MESSAGE,
  selfSignupEnabled,
} from "@/lib/signupPolicy";
import { signUp } from "@/server/signup";

/**
 * Self-registration is closed unless an operator opens it.
 *
 * An account gives its holder every project marked as a default, and sign-up
 * verifies nothing about who is asking, so the safe state is "off" — and it is
 * the action that refuses, not just the page that declines to draw a form.
 */

const created: string[] = [];
const original = process.env.ALLOW_SELF_SIGNUP;

afterEach(() => {
  if (original === undefined) delete process.env.ALLOW_SELF_SIGNUP;
  else process.env.ALLOW_SELF_SIGNUP = original;
});

afterAll(async () => {
  if (created.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: created } } });
  }
  await prisma.$disconnect();
});

function account() {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const password = "Gate#Fixture-3";
  return {
    name: "Gate Fixture",
    email: `signup-gate-${stamp}@symbiosystech.local`,
    password,
    confirmPassword: password,
  };
}

describe("the setting", () => {
  it('is off when unset, and for anything but exactly "true"', () => {
    for (const value of [undefined, "", "false", "0", "1", "TRUE", "yes", " true"]) {
      if (value === undefined) delete process.env.ALLOW_SELF_SIGNUP;
      else process.env.ALLOW_SELF_SIGNUP = value;
      expect(selfSignupEnabled(), String(value)).toBe(false);
    }
    process.env.ALLOW_SELF_SIGNUP = "true";
    expect(selfSignupEnabled()).toBe(true);
  });
});

describe("the action", () => {
  it("refuses when self-registration is off, and creates nothing", async () => {
    delete process.env.ALLOW_SELF_SIGNUP;
    const input = account();

    const result = await signUp(input);

    expect(result).toEqual({ ok: false, error: SELF_SIGNUP_DISABLED_MESSAGE });
    expect(await prisma.user.findUnique({ where: { email: input.email } })).toBeNull();
  });

  it("reveals nothing while closed, not even whether an email exists", async () => {
    delete process.env.ALLOW_SELF_SIGNUP;
    const existing = await signUp({
      name: "Existing",
      email: "admin@symbiosystech.com",
      password: "Gate#Fixture-3",
      confirmPassword: "Gate#Fixture-3",
    });
    const fresh = await signUp(account());
    expect(existing).toEqual(fresh);
  });

  it("refuses even a malformed request the same way while closed", async () => {
    delete process.env.ALLOW_SELF_SIGNUP;
    expect(await signUp({})).toEqual({ ok: false, error: SELF_SIGNUP_DISABLED_MESSAGE });
    expect(await signUp(null)).toEqual({ ok: false, error: SELF_SIGNUP_DISABLED_MESSAGE });
  });

  it("works as before once an operator turns it on", async () => {
    process.env.ALLOW_SELF_SIGNUP = "true";
    const input = account();

    const result = await signUp(input);
    expect(result.ok).toBe(true);

    const user = await prisma.user.findUniqueOrThrow({
      where: { email: input.email },
      select: { id: true, role: true },
    });
    created.push(user.id);
    // Whatever else is switched on, a self-registered account is never an admin.
    expect(user.role).toBe("MEMBER");
  });
});
