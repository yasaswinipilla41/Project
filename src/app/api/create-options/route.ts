import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { canAccessProject, projectScope } from "@/lib/authz";
import { getCurrentUser } from "@/lib/session";
import { issueTextSearch } from "@/server/queries/issues";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Feeds the global Create dialog.
 *
 * Without `projectId` it returns the projects the caller may write to. With
 * one, it adds that project's members, labels and eligible parent issues.
 * Access is resolved from the session on every call — the client never says
 * which projects it is allowed to see.
 */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const projects = await prisma.project.findMany({
    where: { ...projectScope(user), isArchived: false },
    select: { id: true, key: true, name: true },
    orderBy: { name: "asc" },
  });

  const projectId = request.nextUrl.searchParams.get("projectId");
  const parentQuery = request.nextUrl.searchParams.get("q")?.trim() || null;
  if (!projectId) {
    return NextResponse.json(
      { projects, viewerId: user.id },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  if (!(await canAccessProject(user, projectId))) {
    return NextResponse.json(
      { error: "You do not have access to this project." },
      { status: 403 },
    );
  }

  const [members, labels, parents] = await Promise.all([
    prisma.projectMember.findMany({
      where: { projectId },
      select: {
        user: { select: { id: true, name: true, email: true, image: true } },
      },
      orderBy: { user: { name: "asc" } },
    }),
    prisma.label.findMany({
      where: { projectId },
      select: { id: true, name: true, color: true },
      orderBy: { name: "asc" },
    }),
    /*
     * Only top-level issues can be parents — Prio allows one level (§24).
     *
     * With no `q` this is the most recently touched handful, which is what a
     * picker should open on. With one it is a search, matched by the same
     * `issueTextSearch` the Issues page and global search use rather than a
     * second set of rules — so an issue key matches as a key here too, and a
     * project with thousands of issues never ships them all to the browser.
     */
    prisma.issue.findMany({
      where: {
        projectId,
        parentId: null,
        ...(parentQuery ? issueTextSearch(parentQuery) : {}),
      },
      select: { id: true, key: true, title: true, type: true },
      orderBy: { updatedAt: "desc" },
      take: 20,
    }),
  ]);

  return NextResponse.json(
    {
      projects,
      viewerId: user.id,
      members: members.map((m) => m.user),
      labels,
      parents,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
