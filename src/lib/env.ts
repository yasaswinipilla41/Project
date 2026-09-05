import { z } from "zod";

/**
 * Server-side environment. Parsed once, lazily, so that importing this module
 * in a client bundle or during `next build` collection never throws.
 */

const serverSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().min(1).default("redis://localhost:6379"),
  AUTH_SECRET: z
    .string()
    .min(16, "AUTH_SECRET must be at least 16 characters"),
  BASE_URL: z.string().url().default("http://localhost:3000"),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  SMTP_USERNAME: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().default("Prio <no-reply@prio.local>"),
  SMTP_SECURE: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
});

export type ServerEnv = z.infer<typeof serverSchema>;

let cached: ServerEnv | null = null;

export function getEnv(): ServerEnv {
  if (cached) return cached;

  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${detail}`);
  }

  cached = parsed.data;
  return cached;
}

/** True when email delivery is configured; otherwise jobs log and no-op. */
export function isEmailConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST);
}

/**
 * Where Prio lives, for links that will be opened outside the application.
 *
 * `BASE_URL` above defaults to `http://localhost:3000` so that a developer can
 * run the app without configuring anything. That default is right for the
 * server talking to itself and wrong for anything durable: an Excel export
 * carrying `http://localhost:3000/api/attachments/...` is a file full of links
 * that open nothing on the reader's machine, and unlike an email it survives
 * to be opened weeks later on somebody else's laptop.
 *
 * So this reads `process.env` directly rather than `getEnv()`: the point is to
 * tell "configured as localhost, deliberately, in development" apart from "not
 * configured at all", which the schema default erases. The order is
 * most-specific first, and the last resort is the production host rather than
 * localhost — if nothing is set, a wrong-but-public URL is recoverable and a
 * loopback URL is not.
 *
 * Deliberately *not* derived from the request. Inside a container the request
 * reports the address the server bound to (`0.0.0.0:3000`), and `Host` /
 * `X-Forwarded-Host` are attacker-controlled — embedding either into a file
 * people are about to click would hand an attacker the link.
 */
export const PUBLIC_BASE_URL_FALLBACK = "https://prio.symbiosystech.in";

export function publicBaseUrl(): string {
  const configured =
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    process.env.APP_BASE_URL?.trim() ||
    process.env.BASE_URL?.trim();

  return (configured || PUBLIC_BASE_URL_FALLBACK).replace(/\/+$/, "");
}
