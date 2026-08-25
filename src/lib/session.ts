import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { Role } from "@prisma/client";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/**
 * Server-side session access.
 *
 * Everything that needs to know who is acting goes through here — never
 * through a client-supplied user id. `cache()` deduplicates the lookup within
 * a single request so a page rendering ten server components hits the session
 * store once.
 */

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
  role: Role;
  jobTitle: string | null;
  isActive: boolean;
}

export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.id) return null;

  // Read the authoritative row: role and isActive can change mid-session and
  // the cached session cookie must never be the source of truth for either.
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      name: true,
      email: true,
      image: true,
      role: true,
      jobTitle: true,
      isActive: true,
    },
  });

  if (!user || !user.isActive) return null;
  return user;
});

/** Redirects to sign-in when there is no active session. */
export async function requireUser(returnTo?: string): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) {
    const target = returnTo
      ? `/sign-in?next=${encodeURIComponent(returnTo)}`
      : "/sign-in";
    redirect(target);
  }
  return user;
}

/** Redirects members away from admin-only surfaces. */
export async function requireAdmin(): Promise<CurrentUser> {
  const user = await requireUser();
  if (user.role !== "ADMIN") {
    redirect("/?error=forbidden");
  }
  return user;
}

export function isAdmin(user: { role: Role } | null | undefined): boolean {
  return user?.role === "ADMIN";
}
