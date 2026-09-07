import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Avatar, AvatarStack, ButtonLink } from "@/components/ui/primitives";
import {
  IconActivity,
  IconCheck,
  IconIssues,
  IconReports,
  IconUsers,
} from "@/components/ui/Icon";
import { WelcomeCreateProject } from "@/components/projects/WelcomeCreateProject";
import { projectScope } from "@/lib/authz";
import { OPEN_STATUSES } from "@/lib/domain";
import { percent } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { requireUser, type CurrentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * The step between picking a project and working in it.
 *
 * Choosing a project out of the sidebar, the switcher, the dashboard, the
 * directory or search used to drop straight into that project's Summary — six
 * charts and twenty numbers, with nothing in between to say which project had
 * just been opened, or what the person opening it is to that project. This
 * page is that sentence: the project's name, the reader's own role in it, who
 * leads it, how much is open, and who else is on it. Then one way onward.
 *
 * Every figure is read here, from this project's rows, under the same
 * `projectScope` every other project route uses — a project the reader is not
 * a member of is not found rather than introduced, exactly as its Summary
 * would answer. Nothing on the page is an example: there is no fallback name,
 * no placeholder lead and no invented count.
 *
 * The shell's project header and tab strip are deliberately absent (see
 * `ProjectShellChrome`): this is the doorway to the workspace, not one of the
 * views inside it, and showing the tabs here would offer five ways past the
 * one step that is meant to be taken.
 */

async function loadProject(rawKey: string, user: CurrentUser) {
  return prisma.project.findFirst({
    where: { key: rawKey.toUpperCase(), ...projectScope(user) },
    select: {
      id: true,
      key: true,
      name: true,
      description: true,
      createdById: true,
      createdBy: {
        select: { id: true, name: true, image: true, jobTitle: true },
      },
      members: {
        orderBy: { createdAt: "asc" },
        select: {
          userId: true,
          user: { select: { id: true, name: true, image: true } },
        },
      },
      _count: { select: { members: true } },
    },
  });
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ key: string }>;
}): Promise<Metadata> {
  const { key } = await params;
  const user = await requireUser();
  const project = await loadProject(key, user);
  if (!project) notFound();

  return { title: `Welcome to ${project.name}` };
}

/**
 * What this person is *to this project*, said in one phrase.
 *
 * Three facts, in the order that outranks: `createdById` for the person who
 * owns this project, Prio's own `Role` for an administrator, and
 * `ProjectMember` for everybody else. An administrator who is not a member
 * still reads as an administrator rather than as nothing, because that is why
 * they can see the page at all — `projectScope` let them through on the role.
 *
 * No new vocabulary is invented, and no new permission is implied: these are
 * the same three claims `authz.ts` already decides access on, said in words
 * instead of in booleans.
 */
function roleInProject({
  user,
  isMember,
  isLead,
}: {
  user: CurrentUser;
  isMember: boolean;
  isLead: boolean;
}): { label: string; detail: string } {
  if (isLead) {
    return {
      label: "Project lead",
      detail: "You created this project and can rename, archive or delete it.",
    };
  }
  if (user.role === "ADMIN") {
    return {
      label: "Administrator",
      detail: isMember
        ? "You are a member of this project, and you administer Prio."
        : "You can see every project in Prio.",
    };
  }
  if (isMember) {
    return {
      label: user.jobTitle ?? "Member",
      detail: "You can create and work on issues in this project.",
    };
  }
  return {
    label: "Guest",
    detail: "You have been given access to this project.",
  };
}

export default async function ProjectWelcomePage({
  params,
}: {
  params: Promise<{ key: string }>;
}) {
  const { key } = await params;
  const user = await requireUser();

  const project = await loadProject(key, user);
  if (!project) notFound();

  const base = `/projects/${project.key.toLowerCase()}`;
  const workspaceHref = `${base}/summary`;

  const [openIssues, totalIssues, doneIssues, assignedToMe, lastActivity] =
    await Promise.all([
      prisma.issue.count({
        where: { projectId: project.id, status: { in: [...OPEN_STATUSES] } },
      }),
      prisma.issue.count({ where: { projectId: project.id } }),
      prisma.issue.count({ where: { projectId: project.id, status: "DONE" } }),
      prisma.issue.count({
        where: {
          projectId: project.id,
          assigneeId: user.id,
          status: { in: [...OPEN_STATUSES] },
        },
      }),
      prisma.activityLogEntry.findFirst({
        where: { issue: { projectId: project.id } },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }),
    ]);

  const isMember = project.members.some((m) => m.userId === user.id);
  const isLead = project.createdById === user.id;
  const role = roleInProject({ user, isMember, isLead });
  const members = project.members.map((m) => m.user);
  const complete = percent(doneIssues, totalIssues);

  /* Creating a project is an administrator's action — the same rule the
     directory's "New project" button follows, and the same rule `createProject`
     enforces on the server. Members are not offered what they cannot do. */
  const canCreateProject = user.role === "ADMIN";
  const creatableUsers = canCreateProject
    ? await prisma.user.findMany({
        where: { isActive: true },
        select: {
          id: true,
          name: true,
          email: true,
          image: true,
          jobTitle: true,
        },
        orderBy: { name: "asc" },
      })
    : [];

  return (
    <div className="prio-welcome">
      <header className="prio-welcome__intro">
        <p className="prio-welcome__eyebrow">
          Welcome back, {user.name.split(" ")[0] ?? user.name}
        </p>
        <h1 className="prio-welcome__title">Welcome to {project.name}</h1>
        <p className="prio-welcome__lede">
          {project.description ??
            "This project has no description yet — what it holds is summarised below."}
        </p>
      </header>

      {/*
       * One card, holding the five things the transition has to say: which
       * project this is, what the reader is to it, who leads it, how much is
       * open, and how many people are on it. Every one of them is a value read
       * from this project's own rows.
       */}
      <section
        className="prio-welcome__card"
        aria-labelledby="prio-welcome-project"
      >
        <div className="prio-welcome__identity">
          {/* The project's own monogram, from its key — the same two letters
              the directory, the sidebar and the project header already use. */}
          <span className="prio-welcome__badge" aria-hidden>
            {project.key.slice(0, 2)}
          </span>
          <div className="prio-welcome__identity-text">
            <h2 className="prio-welcome__project" id="prio-welcome-project">
              {project.name}
            </h2>
            <span className="prio-key">{project.key}</span>
          </div>
        </div>

        <dl className="prio-welcome__facts">
          <div className="prio-welcome__fact">
            <dt>
              <IconUsers size={13} />
              Your role
            </dt>
            <dd>{role.label}</dd>
            <p className="prio-welcome__facthint">{role.detail}</p>
          </div>

          <div className="prio-welcome__fact">
            <dt>
              <IconReports size={13} />
              Project lead
            </dt>
            <dd className="prio-welcome__lead">
              <Avatar
                name={project.createdBy.name}
                image={project.createdBy.image}
                size="xs"
              />
              <span className="prio-truncate">{project.createdBy.name}</span>
            </dd>
            <p className="prio-welcome__facthint">
              {project.createdBy.jobTitle ?? "Created this project."}
            </p>
          </div>

          <div className="prio-welcome__fact">
            <dt>
              <IconIssues size={13} />
              Open issues
            </dt>
            <dd>{openIssues}</dd>
            <p className="prio-welcome__facthint">
              {totalIssues === 0
                ? "Nothing has been filed yet."
                : `${totalIssues} in total · ${complete}% complete`}
            </p>
          </div>

          <div className="prio-welcome__fact">
            <dt>
              <IconUsers size={13} />
              Team members
            </dt>
            <dd>{project._count.members}</dd>
            <p className="prio-welcome__facthint">
              {members.length === 0
                ? "Nobody has been added yet."
                : members.length === 1
                  ? members[0]!.name
                  : `${members[0]!.name} and ${members.length - 1} other${
                      members.length > 2 ? "s" : ""
                    }`}
            </p>
          </div>
        </dl>

        {members.length > 0 ? (
          <div className="prio-welcome__members">
            {/* Real members, their own images, initials where there is no
                image, and `+N` once there are more of them than fit. */}
            <AvatarStack people={members} max={6} />
            <span className="prio-welcome__memberslabel">
              {project._count.members === 1
                ? "1 person works here"
                : `${project._count.members} people work here`}
            </span>
          </div>
        ) : null}

        <div className="prio-welcome__actions">
          <ButtonLink
            href={workspaceHref}
            variant="brand"
            size="lg"
            className="prio-welcome__cta"
          >
            Go to Project
          </ButtonLink>
          <span className="prio-welcome__actionhint">
            {assignedToMe > 0
              ? `${assignedToMe} open ${
                  assignedToMe === 1 ? "issue is" : "issues are"
                } assigned to you here.`
              : "Nothing here is assigned to you right now."}
          </span>
        </div>
      </section>

      {/*
       * Where the workspace leads, named rather than duplicated. Each of these
       * is one of the project's existing views — the tab strip's destinations
       * said once in prose, so the doorway explains what is behind it.
       */}
      <section className="prio-welcome__views" aria-label="Project views">
        <Link className="prio-welcome__view" href={workspaceHref}>
          <IconReports size={15} />
          <span className="prio-welcome__viewname">Summary</span>
          <span className="prio-welcome__viewhint">
            Status, priorities, workload and epics
          </span>
        </Link>
        <Link className="prio-welcome__view" href={`${base}/board`}>
          <IconCheck size={15} />
          <span className="prio-welcome__viewname">Flow Board</span>
          <span className="prio-welcome__viewhint">
            {openIssues} open {openIssues === 1 ? "issue" : "issues"} in flight
          </span>
        </Link>
        <Link className="prio-welcome__view" href={`${base}/timeline`}>
          <IconActivity size={15} />
          <span className="prio-welcome__viewname">Timeline</span>
          <span className="prio-welcome__viewhint">
            {lastActivity ? "Scheduled work, by date" : "Nothing scheduled yet"}
          </span>
        </Link>
      </section>

      {canCreateProject ? (
        <p className="prio-welcome__elsewhere">
          Looking for something else?{" "}
          <WelcomeCreateProject users={creatableUsers} currentUserId={user.id} />{" "}
          or <Link href="/projects">browse all projects</Link>.
        </p>
      ) : (
        <p className="prio-welcome__elsewhere">
          Looking for something else?{" "}
          <Link href="/projects">Browse all projects</Link>.
        </p>
      )}
    </div>
  );
}
