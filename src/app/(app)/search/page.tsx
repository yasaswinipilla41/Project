import type { Metadata } from "next";
import Link from "next/link";
import type { IssueStatus, IssueType } from "@prisma/client";
import { Card, CardBody, EmptyState } from "@/components/ui/primitives";
import {
  IssueKey,
  IssueTypeIcon,
  PriorityIndicator,
  StatusPill,
} from "@/components/ui/Indicators";
import {
  IconBug,
  IconEmptyBox,
  IconIssues,
  IconProjects,
  IconSearch,
  IconUsers,
} from "@/components/ui/Icon";
import { SearchForm } from "@/components/search/SearchForm";
import { issueScope, projectScope } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { issueTextSearch } from "@/server/queries/issues";
import { formatRelative } from "@/lib/format";

export const metadata: Metadata = { title: "Search" };
export const dynamic = "force-dynamic";

/**
 * Global search (§34), grouped by what was found.
 *
 * Every match is shown here, in this section. Nothing navigates away on the
 * strength of a query looking like something in particular.
 */
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; scope?: string }>;
}) {
  const user = await requireUser();
  const { q, scope } = await searchParams;
  const query = q?.trim() ?? "";

  /*
   * The top bar searches projects and nothing else, so it arrives with
   * `scope=projects`. The Search page in the sidebar carries no scope and
   * keeps searching everything — one page, two entry points, and the narrower
   * one does not take the broader one down with it.
   */
  const projectsOnly = scope === "projects";

  /*
   * Searching an issue key used to jump straight to that issue. It no longer
   * does: results belong in the search results, and being thrown onto another
   * page is not an answer to "what matches this?" -- it also gave no way back
   * to the rest of what matched, and no way to tell a key from a word that
   * happened to look like one.
   *
   * Nothing is lost by staying: `issueTextSearch` matches a whole key exactly,
   * so the issue that used to be jumped to is the first result instead, one
   * click away rather than none.
   */
  const hasQuery = query.length >= 1;

  const [issues, projects, people] = hasQuery
    ? await Promise.all([
        prisma.issue.findMany({
          where: { AND: [issueScope(user), issueTextSearch(query)] },
          orderBy: { updatedAt: "desc" },
          take: 40,
          select: {
            id: true,
            key: true,
            type: true,
            title: true,
            status: true,
            priority: true,
            updatedAt: true,
            project: { select: { name: true } },
            assignee: { select: { name: true } },
          },
        }),
        prisma.project.findMany({
          where: {
            ...projectScope(user),
            OR: [
              { name: { contains: query, mode: "insensitive" } },
              { key: { contains: query, mode: "insensitive" } },
              { description: { contains: query, mode: "insensitive" } },
            ],
          },
          take: 10,
          select: {
            id: true,
            key: true,
            name: true,
            description: true,
            _count: { select: { issues: true } },
          },
        }),
        prisma.user.findMany({
          where: {
            isActive: true,
            OR: [
              { name: { contains: query, mode: "insensitive" } },
              { email: { contains: query, mode: "insensitive" } },
            ],
            // Only people who share a project with the caller.
            ...(user.role === "ADMIN"
              ? {}
              : {
                  projectMemberships: {
                    some: { project: { members: { some: { userId: user.id } } } },
                  },
                }),
          },
          take: 10,
          select: {
            id: true,
            name: true,
            email: true,
            jobTitle: true,
            _count: { select: { assignedIssues: true } },
          },
        }),
      ])
    : [[], [], []];

  /* Scoped searches keep only what they asked for. The groups below render
     nothing when their list is empty, so this is all the gating needed. */
  const issueResults = projectsOnly ? [] : issues;
  const peopleResults = projectsOnly ? [] : people;

  const bugs = issueResults.filter((i) => i.type === "BUG");
  const others = issueResults.filter((i) => i.type !== "BUG");
  const totalResults =
    issueResults.length + projects.length + peopleResults.length;

  return (
    <>
      <div className="prio-page-header">
        <div className="prio-page-header__text">
          <h1 className="prio-page-header__title">
            <IconSearch />
            Search
          </h1>
          <p className="prio-page-header__subtitle">
            {projectsOnly
              ? "Projects matching what you typed."
              : "Issues, bugs, projects and people."}{" "}
            {projectsOnly ? null : <>Enter an issue key such as{" "}</>}
            <span className="prio-key">ENG-1</span> to jump straight to it.
          </p>
        </div>
      </div>

      <SearchForm initialQuery={query} />

      {!hasQuery ? (
        <Card>
          <EmptyState
            icon={<IconSearch size={24} />}
            title={query.length === 0 ? "Search Prio" : "Keep typing"}
            body={
              query.length === 0
                ? "Search across issue keys, titles, descriptions, environments, labels, people and projects."
                : "Enter at least two characters to search."
            }
          />
        </Card>
      ) : totalResults === 0 ? (
        <Card>
          <EmptyState
            icon={<IconEmptyBox />}
            title="No results found"
            body={`Nothing matches “${query}”. Try a different term, or check that you have access to the project it belongs to.`}
          />
        </Card>
      ) : (
        <div className="prio-searchresults">
          {bugs.length > 0 ? (
            <ResultGroup
              icon={<IconBug />}
              title="Bugs"
              count={bugs.length}
            >
              {bugs.map((issue) => (
                <IssueResult key={issue.id} issue={issue} />
              ))}
            </ResultGroup>
          ) : null}

          {others.length > 0 ? (
            <ResultGroup
              icon={<IconIssues />}
              title="Issues"
              count={others.length}
            >
              {others.map((issue) => (
                <IssueResult key={issue.id} issue={issue} />
              ))}
            </ResultGroup>
          ) : null}

          {projects.length > 0 ? (
            <ResultGroup
              icon={<IconProjects />}
              title="Projects"
              count={projects.length}
            >
              {projects.map((project) => (
                <Link
                  key={project.id}
                  href={`/projects/${project.key.toLowerCase()}/welcome`}
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
                </Link>
              ))}
            </ResultGroup>
          ) : null}

          {peopleResults.length > 0 ? (
            <ResultGroup icon={<IconUsers />} title="People" count={peopleResults.length}>
              {peopleResults.map((person) => (
                <Link
                  key={person.id}
                  href={`/issues?assignee=${person.id}`}
                  className="prio-relatedrow"
                >
                  <span className="prio-relatedrow__title">{person.name}</span>
                  <span className="prio-text-muted">
                    {person.jobTitle ?? person.email}
                  </span>
                  <span className="prio-text-muted">
                    {person._count.assignedIssues} assigned
                  </span>
                </Link>
              ))}
            </ResultGroup>
          ) : null}
        </div>
      )}
    </>
  );
}

function ResultGroup({
  icon,
  title,
  count,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <Card className="prio-issue__section">
      <CardBody>
        <h2 className="prio-issue__section-title">
          {icon}
          {title}
          <span className="prio-text-muted">{count}</span>
        </h2>
        {children}
      </CardBody>
    </Card>
  );
}

function IssueResult({
  issue,
}: {
  issue: {
    key: string;
    type: IssueType;
    title: string;
    status: IssueStatus;
    priority: "URGENT" | "HIGH" | "MEDIUM" | "LOW" | "NONE";
    updatedAt: Date;
    project: { name: string };
    assignee: { name: string } | null;
  };
}) {
  return (
    <Link href={`/issues/${issue.key.toLowerCase()}`} className="prio-relatedrow">
      <IssueTypeIcon type={issue.type} size={17} />
      <IssueKey issueKey={issue.key} />
      <span className="prio-relatedrow__title prio-truncate">{issue.title}</span>
      <PriorityIndicator priority={issue.priority} showLabel={false} />
      <StatusPill status={issue.status} />
      <span className="prio-text-muted prio-searchresults__project">
        {issue.project.name} · {formatRelative(issue.updatedAt)}
      </span>
    </Link>
  );
}
