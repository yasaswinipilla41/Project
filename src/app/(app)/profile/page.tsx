import type { Metadata } from "next";
import Link from "next/link";
import { ProfileForm } from "@/components/profile/ProfileForm";
import { Avatar, Card, CardBody, Stat } from "@/components/ui/primitives";
import { IconUser } from "@/components/ui/Icon";
import { OPEN_STATUSES, ROLE_DESCRIPTION, ROLE_LABEL } from "@/lib/domain";
import { formatDate } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "Profile" };
export const dynamic = "force-dynamic";

/**
 * The signed-in person's own profile (§37).
 *
 * Reads only their own row, and never selects anything sensitive — no password
 * hashes, no session tokens, no other account.
 */
export default async function ProfilePage() {
  const user = await requireUser();

  const [profile, memberships, assignedOpen, reported, resolved] =
    await Promise.all([
      prisma.user.findUniqueOrThrow({
        where: { id: user.id },
        select: {
          name: true,
          email: true,
          image: true,
          jobTitle: true,
          role: true,
          isActive: true,
          createdAt: true,
          emailNotificationsEnabled: true,
        },
      }),
      prisma.projectMember.findMany({
        where: { userId: user.id },
        select: {
          createdAt: true,
          project: {
            select: {
              id: true,
              key: true,
              name: true,
              _count: { select: { issues: true } },
            },
          },
        },
        orderBy: { project: { name: "asc" } },
      }),
      prisma.issue.count({
        where: { assigneeId: user.id, status: { in: [...OPEN_STATUSES] } },
      }),
      prisma.issue.count({ where: { reporterId: user.id } }),
      prisma.issue.count({ where: { assigneeId: user.id, status: "DONE" } }),
    ]);

  return (
    <>
      <div className="prio-page-header">
        <div className="prio-page-header__text">
          <h1 className="prio-page-header__title">
            <IconUser />
            Profile
          </h1>
          <p className="prio-page-header__subtitle">
            Your Prio account and the projects you belong to.
          </p>
        </div>
      </div>

      <div className="row g-4">
        <div className="col-12 col-xl-4">
          <Card className="prio-issue__section">
            <CardBody>
              <div className="prio-profile__identity">
                <Avatar name={profile.name} image={profile.image} size="xl" />
                <div style={{ minWidth: 0 }}>
                  <h2 className="prio-profile__name">{profile.name}</h2>
                  <p className="prio-profile__email">{profile.email}</p>
                  <span className="prio-badge">{ROLE_LABEL[profile.role]}</span>
                </div>
              </div>

              <p className="prio-hint" style={{ marginTop: "var(--prio-space-5)" }}>
                {ROLE_DESCRIPTION[profile.role]}
              </p>

              <hr className="prio-divider" />

              <div className="prio-meta-row">
                <span className="prio-meta-row__label">Account</span>
                <span className="prio-meta-row__value">
                  <span
                    className="prio-status"
                    data-status={profile.isActive ? "DONE" : "CANCELLED"}
                  >
                    <span className="prio-status__dot" aria-hidden />
                    {profile.isActive ? "Active" : "Deactivated"}
                  </span>
                </span>
              </div>

              <div className="prio-meta-row">
                <span className="prio-meta-row__label">Member since</span>
                <span className="prio-meta-row__value">
                  {formatDate(profile.createdAt)}
                </span>
              </div>

              <p className="prio-hint" style={{ marginTop: "var(--prio-space-4)" }}>
                Your email address and role are managed by an administrator.
              </p>
            </CardBody>
          </Card>
        </div>

        <div className="col-12 col-xl-8">
          <div className="row g-3" style={{ marginBottom: "var(--prio-space-4)" }}>
            <div className="col-4">
              <Stat
                label="Open work"
                value={assignedOpen}
                tone="brand"
                hint="Assigned to me"
              />
            </div>
            <div className="col-4">
              <Stat
                label="Completed"
                value={resolved}
                tone="success"
                hint="Marked Done"
              />
            </div>
            <div className="col-4">
              <Stat
                label="Reported"
                value={reported}
                hint="Issues and bugs I raised"
              />
            </div>
          </div>

          <Card className="prio-issue__section">
            <CardBody>
              <h2 className="prio-issue__section-title">Profile settings</h2>
              <ProfileForm
                initialName={profile.name}
                initialJobTitle={profile.jobTitle ?? ""}
                initialEmailNotifications={profile.emailNotificationsEnabled}
              />
            </CardBody>
          </Card>

          <Card className="prio-issue__section">
            <CardBody>
              <h2 className="prio-issue__section-title">
                My projects
                <span className="prio-text-muted">{memberships.length}</span>
              </h2>

              {memberships.length === 0 ? (
                <p className="prio-text-muted">
                  You are not a member of any project yet. Ask an administrator
                  for access.
                </p>
              ) : (
                memberships.map(({ project, createdAt }) => (
                  <Link
                    key={project.id}
                    href={`/projects/${project.key.toLowerCase()}`}
                    className="prio-relatedrow"
                  >
                    <span className="prio-project-chip" aria-hidden>
                      {project.key.slice(0, 2)}
                    </span>
                    <span className="prio-relatedrow__title">{project.name}</span>
                    <span className="prio-key">{project.key}</span>
                    <span className="prio-text-muted">
                      {project._count.issues} issues
                    </span>
                    <span className="prio-text-muted prio-searchresults__project">
                      joined {formatDate(createdAt)}
                    </span>
                  </Link>
                ))
              )}
            </CardBody>
          </Card>
        </div>
      </div>
    </>
  );
}
