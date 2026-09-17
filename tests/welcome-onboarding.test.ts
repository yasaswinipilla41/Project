import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createUser, changeOwnPassword } from "@/server/users";
import { setMailTransport } from "@/server/mailer";
import { actAs } from "./helpers";

/**
 * Onboarding an account somebody else created.
 *
 * The whole path in one place, because the parts only mean something together:
 * an administrator types a password, the person is told it, and the first thing
 * the application does with them is take it away again. If any link is missing
 * the result is either an account nobody can reach or a shared password that
 * stays live.
 *
 * The transport is stood in rather than mocked away, so what is asserted is the
 * message that would actually have been handed to a mail server — recipient,
 * subject and body included.
 */

const ADMIN = "admin@symbiosystech.com";
const PASSWORD = "Prio@12345";

/** Accounts made here, removed afterwards. Nothing seeded is touched. */
const createdUserIds: string[] = [];

/** The messages the stand-in transport was asked to send. */
interface SentMail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

function captureMail(): { sent: SentMail[]; restore: () => void } {
  const sent: SentMail[] = [];
  setMailTransport({
    sendMail: async (message: Record<string, unknown>) => {
      sent.push({
        to: String(message.to ?? ""),
        subject: String(message.subject ?? ""),
        text: String(message.text ?? ""),
        html: String(message.html ?? ""),
      });
      return { messageId: "test" };
    },
    // The rest of the Transporter surface is never reached by this path.
  } as never);
  return { sent, restore: () => setMailTransport(null) };
}

afterAll(async () => {
  setMailTransport(null);
  if (createdUserIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await prisma.$disconnect();
});

async function newAccount(overrides: {
  email: string;
  password: string;
  role?: "ADMIN" | "MEMBER";
  projectIds?: string[];
}) {
  await actAs(ADMIN);
  const result = await createUser({
    name: `Onboarded ${Date.now()}`,
    email: overrides.email,
    password: overrides.password,
    role: overrides.role ?? "MEMBER",
    projectIds: overrides.projectIds ?? [],
  });
  if (result.ok) createdUserIds.push(result.data.id);
  return result;
}

describe("an account an administrator creates", () => {
  it("is told its own address and password, and nothing else's", async () => {
    const mail = captureMail();
    try {
      const email = `welcome.${Date.now()}@symbiosystech.com`;
      const temporary = "Temporary@1234";

      const project = await prisma.project.findFirstOrThrow({
        select: { id: true, name: true },
      });

      const created = await newAccount({
        email,
        password: temporary,
        projectIds: [project.id],
      });
      expect(created.ok, created.ok ? "" : created.error).toBe(true);
      if (!created.ok) return;

      expect(created.data.welcomeEmailSent).toBe(true);
      expect(mail.sent).toHaveLength(1);

      const message = mail.sent[0]!;
      // Addressed to exactly what the administrator typed.
      expect(message.to).toContain(email);
      expect(message.subject).toMatch(/welcome to prio/i);

      // Carries the credentials, and the project actually saved against it.
      expect(message.text).toContain(email);
      expect(message.text).toContain(temporary);
      expect(message.text).toContain(project.name);
      expect(message.text).toMatch(/new password the first time/i);

      // And says nothing about anybody else.
      expect(message.text).not.toContain(ADMIN);
    } finally {
      mail.restore();
    }
  });

  it("stores a hash, never the password it emailed", async () => {
    const mail = captureMail();
    try {
      const email = `hashed.${Date.now()}@symbiosystech.com`;
      const temporary = "Temporary@5678";

      const created = await newAccount({ email, password: temporary });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const account = await prisma.account.findFirstOrThrow({
        where: { userId: created.data.id, providerId: "credential" },
        select: { password: true },
      });

      expect(account.password).toBeTruthy();
      /* The stored value is not the password, and does not contain it. */
      expect(account.password).not.toBe(temporary);
      expect(account.password).not.toContain(temporary);
    } finally {
      mail.restore();
    }
  });

  it("owes a password change, where every account before it does not", async () => {
    const mail = captureMail();
    try {
      const created = await newAccount({
        email: `owes.${Date.now()}@symbiosystech.com`,
        password: "Temporary@9012",
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const row = await prisma.user.findUniqueOrThrow({
        where: { id: created.data.id },
        select: { mustChangePassword: true },
      });
      expect(row.mustChangePassword).toBe(true);

      /*
       * The other half of the claim, and the one that matters to everybody who
       * already uses Prio: the seeded accounts are untouched. A migration that
       * defaulted this to true would have locked the whole organisation out of
       * their own application behind a password screen.
       */
      const seededForced = await prisma.user.count({
        where: {
          mustChangePassword: true,
          id: { notIn: createdUserIds },
        },
      });
      expect(seededForced).toBe(0);
    } finally {
      mail.restore();
    }
  });

  it("stops owing it once the password is replaced, and not before", async () => {
    const mail = captureMail();
    try {
      const email = `changes.${Date.now()}@symbiosystech.com`;
      const temporary = "Temporary@3456";

      const created = await newAccount({ email, password: temporary });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      await actAs(email, temporary);

      /* A refused attempt leaves them exactly where they were — still owing
         the change, and still on the password they were given. */
      const wrong = await changeOwnPassword({
        currentPassword: "not-the-temporary-one",
        newPassword: "Replaced@1234",
        confirmPassword: "Replaced@1234",
      });
      expect(wrong.ok).toBe(false);
      expect(
        (
          await prisma.user.findUniqueOrThrow({
            where: { id: created.data.id },
            select: { mustChangePassword: true },
          })
        ).mustChangePassword,
      ).toBe(true);

      const changed = await changeOwnPassword({
        currentPassword: temporary,
        newPassword: "Replaced@1234",
        confirmPassword: "Replaced@1234",
      });
      expect(changed.ok, changed.ok ? "" : changed.error).toBe(true);

      expect(
        (
          await prisma.user.findUniqueOrThrow({
            where: { id: created.data.id },
            select: { mustChangePassword: true },
          })
        ).mustChangePassword,
      ).toBe(false);

      // The new password signs in, which is what clearing the flag rests on.
      await expect(actAs(email, "Replaced@1234")).resolves.toBeTruthy();

      /* And the temporary one no longer does. `actAs` throws when sign-in
         returns no session cookie, which is what a refused password looks
         like from here. */
      await expect(actAs(email, temporary)).rejects.toThrow(/sign-in failed/i);
    } finally {
      mail.restore();
    }
  });

  it("is not created twice, and the second attempt tells nobody anything", async () => {
    const mail = captureMail();
    try {
      const email = `duplicate.${Date.now()}@symbiosystech.com`;

      const first = await newAccount({ email, password: "Temporary@7890" });
      expect(first.ok).toBe(true);
      expect(mail.sent).toHaveLength(1);

      const second = await newAccount({ email, password: "Different@7890" });
      expect(second.ok).toBe(false);

      // No second account, and no second message.
      expect(await prisma.user.count({ where: { email } })).toBe(1);
      expect(mail.sent).toHaveLength(1);
    } finally {
      mail.restore();
    }
  });

  it("exists even when the message could not be sent", async () => {
    /*
     * A mail server being down is not a reason to lose the account: it is
     * made, the administrator is told the message did not go, and they can
     * pass the details on themselves. Rolling back would leave them with
     * neither an account nor a way to make one, because the address would
     * still be taken.
     */
    setMailTransport({
      sendMail: async () => {
        throw new Error("smtp is down");
      },
    } as never);

    try {
      const email = `undeliverable.${Date.now()}@symbiosystech.com`;
      const created = await newAccount({ email, password: "Temporary@2345" });

      expect(created.ok, created.ok ? "" : created.error).toBe(true);
      if (!created.ok) return;

      expect(created.data.welcomeEmailSent).toBe(false);
      expect(await prisma.user.count({ where: { email } })).toBe(1);
    } finally {
      setMailTransport(null);
    }
  });
});

describe("everybody who was already here", () => {
  it("signs in with nothing in the way", async () => {
    /* The seeded administrator predates all of this. Nothing about the
       onboarding path should have reached them. */
    const admin = await prisma.user.findUniqueOrThrow({
      where: { email: ADMIN },
      select: { mustChangePassword: true },
    });
    expect(admin.mustChangePassword).toBe(false);

    await expect(actAs(ADMIN, PASSWORD)).resolves.toBeTruthy();
  });
});
