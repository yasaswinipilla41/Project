import { getCurrentUser } from "@/lib/session";
import { issueScope, projectScope } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { issueTextSearch } from "@/server/queries/issues";

/**
 * Suggestions for the search box, as somebody types.
 *
 * The same three things the search page itself finds — issues, projects and
 * people — matched by the same predicates and, more importantly, restricted by
 * the same scopes. `issueTextSearch` is the search page's own matcher, and
 * `issueScope` / `projectScope` are the same guards it applies, so a
 * suggestion can never name something its own results page would refuse to
 * show. This adds no new way of searching; it answers earlier and shorter.
 *
 * Deliberately small: a handful of each, enough to fill a dropdown. Anyone who
 * wants the whole answer presses Enter and gets the results page.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface Suggestion {
  kind: "issue" | "project" | "person";
  label: string;
  hint: string;
  href: string;
}

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ error: "Not signed in." }, { status: 401 });
  }

  const query = (new URL(request.url).searchParams.get("q") ?? "").trim();
  if (query.length === 0) {
    return Response.json({ suggestions: [] as Suggestion[] });
  }

  const insensitive = { contains: query, mode: "insensitive" as const };

  const [issues, projects, people] = await Promise.all([
    prisma.issue.findMany({
      where: { AND: [issueScope(user), issueTextSearch(query)] },
      orderBy: { updatedAt: "desc" },
      take: 5,
      select: { key: true, title: true, project: { select: { name: true } } },
    }),
    prisma.project.findMany({
      where: {
        ...projectScope(user),
        OR: [{ name: insensitive }, { key: insensitive }],
      },
      orderBy: { name: "asc" },
      take: 4,
      select: { key: true, name: true },
    }),
    prisma.user.findMany({
      where: {
        isActive: true,
        OR: [{ name: insensitive }, { email: insensitive }],
        /* Only people who share a project with the caller — the same rule the
           search page applies, so this cannot be used to enumerate the
           organization. */
        ...(user.role === "ADMIN"
          ? {}
          : {
              projectMemberships: {
                some: { project: { members: { some: { userId: user.id } } } },
              },
            }),
      },
      orderBy: { name: "asc" },
      take: 4,
      select: { id: true, name: true, email: true },
    }),
  ]);

  /* Issues first: a search box in an issue tracker is usually looking for an
     issue, and the key match is the most precise thing here. */
  const suggestions: Suggestion[] = [
    ...issues.map((issue) => ({
      kind: "issue" as const,
      label: `${issue.key} — ${issue.title}`,
      hint: issue.project.name,
      href: `/issues/${issue.key.toLowerCase()}`,
    })),
    ...projects.map((project) => ({
      kind: "project" as const,
      label: project.name,
      hint: project.key,
      href: `/projects/${project.key.toLowerCase()}`,
    })),
    ...people.map((person) => ({
      kind: "person" as const,
      label: person.name,
      hint: person.email,
      /* People have no page of their own, so a person leads to the search
         results for their name — which is what the search page already shows
         for a person, rather than a link that goes nowhere. */
      href: `/search?q=${encodeURIComponent(person.name)}`,
    })),
  ];

  return Response.json({ suggestions }, { headers: { "Cache-Control": "no-store" } });
}
