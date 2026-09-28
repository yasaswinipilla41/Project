import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { meetsPasswordPolicy, WEAK_PASSWORD_MESSAGE } from "@/lib/passwordPolicy";
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
/**
 * The better-auth endpoints that take a password somebody is *choosing*.
 *
 * Prio's own actions validate a new password through `newPasswordSchema`, but
 * better-auth also serves `/api/auth/change-password` over plain HTTP, and it
 * only knows the length limits below. Without this hook that endpoint would be
 * a way around the strength rule for anyone holding a session. Sign-up and
 * reset are closed or unconfigured today; they are listed so that turning one
 * on later cannot quietly open a second way round.
 */
const NEW_PASSWORD_FIELD: Record<string, string> = {
  "/change-password": "newPassword",
  "/reset-password": "newPassword",
  "/set-password": "newPassword",
  "/sign-up/email": "password",
};

export const auth = betterAuth({
  appName: "Prio",
  secret: process.env.AUTH_SECRET,
  baseURL: process.env.BASE_URL ?? "http://localhost:3000",

  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),

  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      const field = NEW_PASSWORD_FIELD[ctx.path];
      if (!field) return;
      const body = (ctx.body ?? {}) as Record<string, unknown>;
      if (!meetsPasswordPolicy(body[field])) {
        throw new APIError("BAD_REQUEST", { message: WEAK_PASSWORD_MESSAGE });
      }
    }),
  },

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
