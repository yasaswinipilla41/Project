import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  addShareMember,
  removeShareMember,
  sharedSheetPathFor,
} from "@/server/shares";
import { actAs } from "./helpers";

/**
 * Sharing the Issues Sheet, and telling the people it was shared with.
 *
 * The share itself already existed — one org-wide `IssueSheetShare`, members
 * granted by an administrator, the `/shared/issues/[token]` route gated by
 * `assertShareAccess`. What is under test here is the part that was missing:
 * the person on the other end learning about it, and the notification leading
 * somewhere they can actually open and download.
 *
 * Every assertion reads the rows back rather than trusting a return value.
 */

const ADMIN = "admin@symbiosystech.com";

const notifiedUserIds: string[] = [];
const addedMemberIds: string[] = [];

afterAll(async () => {
  if (notifiedUserIds.length > 0) {
    await prisma.notification.deleteMany({
      where: { userId: { in: notifiedUserIds }, type: "INVITED" },
    });
  }
  if (addedMemberIds.length > 0) {
    await prisma.issueSheetShareMember.deleteMany({
      where: { id: { in: addedMemberIds } },
    });
  }
  await prisma.$disconnect();
});

/** Somebody not already on the share, so the grant is a real first grant. */
async function someoneNotShared(excludeEmail: string) {
  const shared = await prisma.issueSheetShareMember.findMany({
    select: { userId: true },
  });
  const taken = new Set(shared.map((m) => m.userId));

  const candidate = await prisma.user.findFirstOrThrow({
    where: {
      isActive: true,
      email: { not: excludeEmail },
      id: { notIn: [...taken] },
    },
    select: { id: true, name: true },
  });
  return candidate;
}

function invitesFor(userId: string) {
  return prisma.notification.findMany({
    where: { userId, type: "INVITED" },
    orderBy: { createdAt: "desc" },
    select: { id: true, message: true, actorId: true, issueId: true },
  });
}

describe("sharing the Issues Sheet with someone", () => {
  it("grants access and tells them, once", async () => {
    const admin = await actAs(ADMIN);
    const target = await someoneNotShared(ADMIN);
    notifiedUserIds.push(target.id);

    const result = await addShareMember({
      userId: target.id,
      permission: "VIEW",
    });
    expect(result.ok).toBe(true);
    if (result.ok) addedMemberIds.push(result.data.id);

    // The share record exists for them.
    const member = await prisma.issueSheetShareMember.findFirst({
      where: { userId: target.id },
      select: { id: true, permission: true },
    });
    expect(member).not.toBeNull();
    expect(member!.permission).toBe("VIEW");

    // And they were told, by the person who shared it.
    const invites = await invitesFor(target.id);
    expect(invites).toHaveLength(1);
    expect(invites[0]!.actorId).toBe(admin.id);
    expect(invites[0]!.message).toMatch(/Issues Sheet/i);
    // It hangs off no issue — the sheet is the whole list, not one row.
    expect(invites[0]!.issueId).toBeNull();

    /* Re-granting does not tell them again: the unique member row is the
       deduplication, and an admin adjusting an existing grant is not news. */
    const again = await addShareMember({
      userId: target.id,
      permission: "VIEW",
    });
    expect(again.ok).toBe(true);
    expect(await invitesFor(target.id)).toHaveLength(1);
  });

  it("gives the notification somewhere to open, and it is their own share", async () => {
    await actAs(ADMIN);
    const target = await someoneNotShared(ADMIN);
    notifiedUserIds.push(target.id);

    const result = await addShareMember({
      userId: target.id,
      permission: "VIEW",
    });
    if (result.ok) addedMemberIds.push(result.data.id);

    const path = await sharedSheetPathFor(target.id);
    expect(path).not.toBeNull();
    expect(path).toMatch(/^\/shared\/issues\/[A-Za-z0-9_-]+$/);

    // …and it is the token of the share they were actually added to.
    const member = await prisma.issueSheetShareMember.findFirstOrThrow({
      where: { userId: target.id },
      select: { share: { select: { token: true } } },
    });
    expect(path).toBe(`/shared/issues/${member.share.token}`);
  });

  it("notifies nobody who was not shared with", async () => {
    await actAs(ADMIN);
    const target = await someoneNotShared(ADMIN);
    notifiedUserIds.push(target.id);

    const before = await prisma.notification.count({ where: { type: "INVITED" } });

    const result = await addShareMember({
      userId: target.id,
      permission: "VIEW",
    });
    if (result.ok) addedMemberIds.push(result.data.id);

    const after = await prisma.notification.findMany({
      where: { type: "INVITED" },
      select: { userId: true },
    });
    // Exactly one new row, and it belongs to the person who was chosen.
    expect(after.length).toBe(before + 1);
    expect(after.filter((n) => n.userId === target.id).length).toBeGreaterThan(0);
  });

  it("leaves someone with no share without a destination", async () => {
    const nobody = await prisma.user.findFirstOrThrow({
      where: { isActive: true, sheetShareGrants: { none: {} } },
      select: { id: true },
    });
    expect(await sharedSheetPathFor(nobody.id)).toBeNull();
  });

  it("is refused to a member — sharing stays an administrator's action", async () => {
    await actAs("priya.nair@symbiosystech.com");
    const target = await someoneNotShared("priya.nair@symbiosystech.com");

    const result = await addShareMember({
      userId: target.id,
      permission: "VIEW",
    });

    expect(result.ok).toBe(false);
    // Refused means refused: no grant, and no notification either.
    expect(await invitesFor(target.id)).toHaveLength(0);
  });
});

describe("removing someone from the share", () => {
  it("revokes access, and their notification then leads nowhere", async () => {
    await actAs(ADMIN);
    const target = await someoneNotShared(ADMIN);
    notifiedUserIds.push(target.id);

    const added = await addShareMember({
      userId: target.id,
      permission: "VIEW",
    });
    expect(added.ok).toBe(true);
    expect(await sharedSheetPathFor(target.id)).not.toBeNull();

    if (added.ok) {
      const removed = await removeShareMember({ memberId: added.data.id });
      expect(removed.ok).toBe(true);
    }

    /* The notification row survives — it is a record of something that
       happened — but it no longer points at a sheet they cannot open. */
    expect(await sharedSheetPathFor(target.id)).toBeNull();
    expect((await invitesFor(target.id)).length).toBeGreaterThan(0);
  });
});
