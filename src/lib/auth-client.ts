"use client";

import { createAuthClient } from "better-auth/react";

/**
 * Browser-side auth client. Only sign-in, sign-out and session reads are used —
 * there is no sign-up call anywhere in the app by design (§17).
 */
export const authClient = createAuthClient({
  baseURL:
    typeof window === "undefined" ? undefined : window.location.origin,
});

export const { signIn, signOut, useSession } = authClient;
