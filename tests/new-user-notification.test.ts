import { afterAll, describe, expect, it } from "vitest";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { signUp } from "@/server/signup";

/**
 * The admin "someone new joined" notification.
 *
 * Fires from `databaseHooks.session.create.after` in `src/lib/auth.ts`, on a
 * real session creation — not at account creation, and not on every request a
 * cached session cookie satisfies. These tests go through the same
 * `auth.api.signInEmail` path `tests/signup.test.ts` already uses to prove a
 * self-registered account can sign in, so the notification is exercised
 * exactly the way an actual first sign-in would trigger it.
 */

const createdUserIds: string[] = [];

afterAll(async () => {
  if (createdUserIds.length > 0) {
    // `Notification.actorId` is SetNull on delete, not Cascade — deleting the
    // user first would orphan these rows in admins' inboxes instead of
    // removing them.
    await prisma.notification.deleteMany({
      where: { actorId: { in: createdUserIds } },
    });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await prisma.$disconnect();
});

function freshAccount() {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const password = "Fixture-Password-1";
  return {
    name: "New Notification Fixture",
    email: `new-user-notify-${stamp}@symbiosystech.local`,
    password,
    confirmPassword: password,
  };
}

async function signIn(email: string, password: string): Promise<void> {
  const response = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  if (!response.ok) {
    throw new Error(`Sign-in failed for ${email}: ${response.status}`);
  }
}

describe("first sign-in notifies admins", () => {
  it("creates one unread USER_JOINED notification per active admin", async () => {
    const account = freshAccount();
    await signUp(account);

    const user = await prisma.user.findUniqueOrThrow({
      where: { email: account.email },
      select: { id: true },
    });
    createdUserIds.push(user.id);

    const admins = await prisma.user.findMany({
      where: { role: "ADMIN", isActive: true },
      select: { id: true },
    });

    await signIn(account.email, account.password);

    const notifications = await prisma.notification.findMany({
      where: { type: "USER_JOINED", actorId: user.id },
      select: { userId: true, message: true, readAt: true, actorId: true },
    });

    expect(notifications).toHaveLength(admins.length);
    expect(new Set(notifications.map((n) => n.userId))).toEqual(
      new Set(admins.map((a) => a.id)),
    );
    for (const notification of notifications) {
      expect(notification.readAt).toBeNull();
      expect(notification.actorId).toBe(user.id);
      expect(notification.message).toContain("Bugs → Reporter");
    }
  });

  it("never notifies the new person about their own arrival", async () => {
    // A fresh admin account: if self-notification were possible, this is
    // exactly the case that would catch it — the actor is also the only
    // account that could have (wrongly) received the notification meant for
    // "everyone else".
    const account = freshAccount();
    await signUp(account);

    const user = await prisma.user.findUniqueOrThrow({
      where: { email: account.email },
      select: { id: true },
    });
    createdUserIds.push(user.id);
    await prisma.user.update({ where: { id: user.id }, data: { role: "ADMIN" } });

    await signIn(account.email, account.password);

    const selfNotified = await prisma.notification.count({
      where: { type: "USER_JOINED", actorId: user.id, userId: user.id },
    });
    expect(selfNotified).toBe(0);
  });

  it("does not repeat on a second sign-in", async () => {
    const account = freshAccount();
    await signUp(account);

    const user = await prisma.user.findUniqueOrThrow({
      where: { email: account.email },
      select: { id: true },
    });
    createdUserIds.push(user.id);

    await signIn(account.email, account.password);
    const afterFirst = await prisma.notification.count({
      where: { type: "USER_JOINED", actorId: user.id },
    });
    expect(afterFirst).toBeGreaterThan(0);

    await signIn(account.email, account.password);
    const afterSecond = await prisma.notification.count({
      where: { type: "USER_JOINED", actorId: user.id },
    });
    expect(afterSecond).toBe(afterFirst);
  });

  it("stamps lastSeenAt on first sign-in, previously null", async () => {
    const account = freshAccount();
    await signUp(account);

    const before = await prisma.user.findUniqueOrThrow({
      where: { email: account.email },
      select: { id: true, lastSeenAt: true },
    });
    createdUserIds.push(before.id);
    expect(before.lastSeenAt).toBeNull();

    await signIn(account.email, account.password);

    const after = await prisma.user.findUniqueOrThrow({
      where: { id: before.id },
      select: { lastSeenAt: true },
    });
    expect(after.lastSeenAt).not.toBeNull();
  });
});
