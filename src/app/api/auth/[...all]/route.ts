import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * better-auth mounts sign-in, sign-out and session endpoints here.
 * `/api/auth/sign-up/email` is present but always rejects: sign-up is disabled
 * in the auth config, so there is no public registration path.
 */
export const { GET, POST } = toNextJsHandler(auth);
