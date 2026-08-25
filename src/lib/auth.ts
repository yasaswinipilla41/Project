import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";
import { prisma } from "@/lib/prisma";
import { notifyAdminsOfNewUser } from "@/server/activity";

/**
 * Prio authentication.
 *
 * Email + password only. `disableSignUp: true` keeps the raw endpoint,
 * `/api/auth/sign-up/email`, closed — every account still goes through code
 * Prio controls, never through better-auth's own sign-up validation. Three
 * paths lead to an account existing, all server-side:
 *   1. an admin creates the account directly (`src/server/users.ts`),
 *   2. an admin sends an invitation and the recipient sets their own password,
 *      or
 *   3. someone registers themselves through `/sign-up` (`src/server/signup.ts`)
 *      — a hand-written action, not this endpoint, and one that only ever
 *      writes `role: "MEMBER"`, hardcoded, never read from what they submit.
 */
export const auth = betterAuth({
  appName: "Prio",
  secret: process.env.AUTH_SECRET,
  baseURL: process.env.BASE_URL ?? "http://localhost:3000",

  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),

  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    minPasswordLength: 8,
    maxPasswordLength: 128,
    autoSignIn: false,
  },

  user: {
    modelName: "user",
    additionalFields: {
      role: {
        type: "string",
        required: false,
        defaultValue: "MEMBER",
        // Never settable through the auth API — only through admin actions.
        input: false,
      },
      jobTitle: {
        type: "string",
        required: false,
        input: false,
      },
      isActive: {
        type: "boolean",
        required: false,
        defaultValue: true,
        input: false,
      },
      lastSeenAt: {
        type: "date",
        required: false,
        input: false,
      },
      emailNotificationsEnabled: {
        type: "boolean",
        required: false,
        defaultValue: true,
        input: false,
      },
    },
  },

  session: {
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    updateAge: 60 * 60 * 24, // refresh once a day
    cookieCache: {
      enabled: true,
      maxAge: 60 * 5,
    },
  },

  databaseHooks: {
    session: {
      create: {
        /*
         * Fires once per real sign-in — a fresh Session row, not the cached
         * cookie most requests validate against — so this is the actual
         * "successful login" event, not a proxy for "has an open session".
         *
         * `lastSeenAt` was already declared on `User` (§ auth.ts additional
         * fields) but nothing ever wrote to it. Brought to life here as real
         * last-seen tracking, updated on every sign-in — and because it was
         * null exactly until someone's very first one, that same read also
         * doubles as first-sign-in detection, with no second field needed.
         */
        after: async (session) => {
          const user = await prisma.user.findUnique({
            where: { id: session.userId },
            select: { id: true, name: true, lastSeenAt: true },
          });
          if (!user) return;

          const firstSignIn = user.lastSeenAt === null;

          await prisma.user.update({
            where: { id: user.id },
            data: { lastSeenAt: new Date() },
          });

          if (firstSignIn) {
            await notifyAdminsOfNewUser(prisma, {
              newUserId: user.id,
              newUserName: user.name,
            });
          }
        },
      },
    },
  },

  advanced: {
    cookiePrefix: "prio",
    useSecureCookies: process.env.NODE_ENV === "production",
  },

  plugins: [nextCookies()],
});

export type Auth = typeof auth;
