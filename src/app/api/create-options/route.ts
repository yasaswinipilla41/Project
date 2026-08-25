import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { canAccessProject, projectScope } from "@/lib/authz";
import { getCurrentUser } from "@/lib/session";

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
  if (!projectId) {
    return NextResponse.json(
      { projects },
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
    // Only top-level issues can be parents — Prio allows one level (§24).
    prisma.issue.findMany({
      where: { projectId, parentId: null },
      select: { id: true, key: true, title: true, type: true },
      orderBy: { updatedAt: "desc" },
      take: 100,
    }),
  ]);

  return NextResponse.json(
    {
      projects,
      members: members.map((m) => m.user),
      labels,
      parents,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
