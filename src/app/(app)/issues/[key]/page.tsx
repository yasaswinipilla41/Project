import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { type NameLookup } from "@/components/issues/ActivityFeed";
import { IssueConversation } from "@/components/issues/IssueConversation";
import { RelatedIssues } from "@/components/issues/RelatedIssues";
import { IssueAttachments } from "@/components/issues/IssueAttachments";
import {
  AssigneeControl,
  PriorityControl,
  SeverityControl,
  StatusControl,
} from "@/components/issues/IssueFieldControls";
import {
  DueDateField,
  EditableTitle,
} from "@/components/issues/EditableIssueFields";
import { IssueDetailActions } from "@/components/issues/IssueDetailActions";
import { SubmitWorkButton } from "@/components/issues/SubmitWorkButton";
import { TestResultPanel } from "@/components/issues/TestResultPanel";
import { ReportBugDialog } from "@/components/issues/ReportBugDialog";
import {
  Avatar,
  Card,
  CardBody,
  MetaRow,
} from "@/components/ui/primitives";
import {
  IssueKey,
  IssueTypeIcon,
  LabelChip,
  StatusPill,
} from "@/components/ui/Indicators";
import {
  IconActivity,
  IconCalendar,
  IconParent,
  IconSubIssue,
  IconWarning,
} from "@/components/ui/Icon";
import { issueScope } from "@/lib/authz";
import { ISSUE_TYPE_LABEL, isClosedStatus } from "@/lib/domain";
import { formatDate, formatDateTime, formatRelative, isOverdue } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { requireUser, type CurrentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Issue detail — and, for `type = BUG`, the bug detail experience of §11.
 *
 * One route serves all three issue types. A bug additionally renders its
 * environment block; a task
 * or story simply has nothing to show there, so those sections are omitted
 * rather than rendered empty.
 */

async function loadIssue(rawKey: string, user: CurrentUser) {
  const key = rawKey.toUpperCase();

  // The scope fragment is what keeps a member from reading another project's
  // issue by guessing its key — it is applied in the query, not after it.
  return prisma.issue.findFirst({
    where: {
      key,
      ...issueScope(user),
    },
    select: {
      id: true,
      key: true,
      type: true,
      title: true,
      status: true,
      priority: true,
      severity: true,
      dueDate: true,
      createdAt: true,
      updatedAt: true,
      completedAt: true,
      testResult: true,
      testedAt: true,
      testedBy: { select: { name: true } },
      environment: true,
      browser: true,
      operatingSystem: true,
      versionBuild: true,
      affectedModule: true,
      project: { select: { id: true, key: true, name: true } },
      assignee: { select: { id: true, name: true, image: true } },
      reporter: { select: { id: true, name: true, image: true } },
      parent: { select: { key: true, title: true, type: true, status: true } },
      children: {
        select: { key: true, title: true, type: true, status: true },
        orderBy: { number: "asc" },
      },
      labels: {
        select: { label: { select: { id: true, name: true, color: true } } },
      },
      activity: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          action: true,
          field: true,
          oldValue: true,
          newValue: true,
          createdAt: true,
          actor: { select: { id: true, name: true, image: true } },
        },
      },
      comments: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          body: true,
          createdAt: true,
          editedAt: true,
          author: { select: { id: true, name: true, image: true } },
          attachments: {
            orderBy: { createdAt: "asc" },
            select: ATTACHMENT_SELECT,
          },
        },
      },
      // Files attached to the issue itself, not to one of its comments.
      attachments: {
        where: { commentId: null },
        orderBy: { createdAt: "asc" },
        select: ATTACHMENT_SELECT,
      },
      linksFrom: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          type: true,
          target: {
            select: { key: true, title: true, type: true, status: true },
          },
        },
      },
    },
  });
}

/** Shared shape for every attachment read, so the two lists cannot drift. */
const ATTACHMENT_SELECT = {
  id: true,
  filename: true,
  mimeType: true,
  byteSize: true,
  createdAt: true,
  uploadedBy: { select: { id: true, name: true, image: true } },
} as const;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ key: string }>;
}): Promise<Metadata> {
  const { key } = await params;
  const user = await requireUser();
  const issue = await loadIssue(key, user);

  /*
   * Raised from metadata so the not-found page is decided before the body is
   * built. The response still carries HTTP 200 — see the same note on the
   * project page — so the reader gets the right page while the status code
   * does not reflect it.
   */
  if (!issue) notFound();

  return { title: `${issue.key} · ${issue.title}` };
}

export default async function IssueDetailPage({
  params,
}: {
  params: Promise<{ key: string }>;
}) {
  const { key } = await params;
  const user = await requireUser();

  const issue = await loadIssue(key, user);
  if (!issue) notFound();

  const isBug = issue.type === "BUG";
  const closed = isClosedStatus(issue.status);
  const overdue = isOverdue(issue.dueDate, closed);

  const members = await prisma.projectMember.findMany({
    where: { projectId: issue.project.id },
    select: { user: { select: { id: true, name: true, image: true } } },
    orderBy: { user: { name: "asc" } },
  });

  // Activity stores ids for relational fields; resolve them to names once.
  const names: NameLookup = {};
  for (const m of members) names[m.user.id] = m.user.name;
  names[issue.reporter.id] = issue.reporter.name;
  for (const entry of issue.activity) names[entry.actor.id] = entry.actor.name;

  /*
   * Who may be `@`-mentioned here: this project's members, plus administrators,
   * who can read every project. Derived on the server — the composer is handed
   * the finished list and never assembles one of its own.
   */
  const admins = await prisma.user.findMany({
    where: { role: "ADMIN", isActive: true },
    select: { id: true, name: true, image: true },
  });
  const mentionable = [
    ...new Map(
      [...members.map((m) => m.user), ...admins].map((person) => [
        person.id,
        person,
      ]),
    ).values(),
  ].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <article className="prio-issue">
      {/* ------------------------------------------------------- header */}
      <header className="prio-issue__header">
        <div className="prio-issue__headtop">
          <nav aria-label="Breadcrumb" className="prio-issue__crumbs">
            <Link href="/projects">Projects</Link>
            <span aria-hidden>/</span>
            <Link href={`/projects/${issue.project.key.toLowerCase()}`}>
              {issue.project.name}
            </Link>
            <span aria-hidden>/</span>
            <span className="prio-issue__crumb-current">
              <IssueTypeIcon type={issue.type} size={16} />
              <IssueKey issueKey={issue.key} />
            </span>
          </nav>

          <div className="prio-issue__headactions">
            <ReportBugDialog
              issueId={issue.id}
              issueKey={issue.key}
              assigneeId={issue.assignee?.id ?? null}
              currentUserId={user.id}
            />

            <SubmitWorkButton
              issueId={issue.id}
              issueKey={issue.key}
              status={issue.status}
              assigneeId={issue.assignee?.id ?? null}
              currentUserId={user.id}
            />

            <IssueDetailActions
              issueId={issue.id}
              issueKey={issue.key}
              reporterId={issue.reporter.id}
              currentUserId={user.id}
              isAdmin={user.role === "ADMIN"}
            />
          </div>
        </div>

        <EditableTitle issueId={issue.id} title={issue.title} />

        <div className="prio-issue__headmeta">
          <span className="prio-badge prio-badge--pill">
            <IssueTypeIcon type={issue.type} size={14} />
            {ISSUE_TYPE_LABEL[issue.type]}
          </span>
          <StatusControl issueId={issue.id} status={issue.status} />
          <PriorityControl issueId={issue.id} priority={issue.priority} />
          {isBug ? (
            <SeverityControl issueId={issue.id} severity={issue.severity} />
          ) : null}
          <AssigneeControl
            issueId={issue.id}
            assignee={issue.assignee}
            members={members.map((m) => m.user)}
          />
        </div>
      </header>

      <div className="row g-4">
        {/* --------------------------------------------------- main column */}
        <div className="col-12 col-xl-8">
          {/* ------------------------------------------- development + QA */}
          <Card className="prio-issue__section">
            <CardBody>
              <h2 className="prio-issue__section-title">Testing</h2>
              <TestResultPanel
                issueId={issue.id}
                status={issue.status}
                testResult={issue.testResult}
                testedBy={issue.testedBy}
                testedAt={issue.testedAt}
                assigneeId={issue.assignee?.id ?? null}
                currentUserId={user.id}
              />
            </CardBody>
          </Card>

          {/* --------------------------------------------- bug specifics */}
          {isBug ? (
            <>
              {issue.environment ||
              issue.browser ||
              issue.operatingSystem ||
              issue.versionBuild ? (
                <Card className="prio-issue__section">
                  <CardBody>
                    <h2 className="prio-issue__section-title prio-issue__section-title--environment">
                      Environment
                    </h2>
                    <dl className="prio-envgrid">
                      {issue.environment ? (
                        <div>
                          <dt>Environment</dt>
                          <dd>{issue.environment}</dd>
                        </div>
                      ) : null}
                      {issue.browser ? (
                        <div>
                          <dt>Browser</dt>
                          <dd>{issue.browser}</dd>
                        </div>
                      ) : null}
                      {issue.operatingSystem ? (
                        <div>
                          <dt>Operating system</dt>
                          <dd>{issue.operatingSystem}</dd>
                        </div>
                      ) : null}
                      {issue.versionBuild ? (
                        <div>
                          <dt>Version / build</dt>
                          <dd className="prio-mono">{issue.versionBuild}</dd>
                        </div>
                      ) : null}
                    </dl>
                  </CardBody>
                </Card>
              ) : null}
            </>
          ) : null}

          {/* ------------------------------------------- relationships */}
          {issue.parent || issue.children.length > 0 ? (
            <Card className="prio-issue__section">
              <CardBody>
                <h2 className="prio-issue__section-title">
                  {issue.parent ? "Parent issue" : "Sub-issues"}
                </h2>

                {issue.parent ? (
                  <Link
                    href={`/issues/${issue.parent.key.toLowerCase()}`}
                    className="prio-relatedrow"
                  >
                    <IconParent size={14} />
                    <IssueTypeIcon type={issue.parent.type} size={16} />
                    <IssueKey issueKey={issue.parent.key} />
                    <span className="prio-relatedrow__title prio-truncate">
                      {issue.parent.title}
                    </span>
                    <StatusPill status={issue.parent.status} />
                  </Link>
                ) : null}

                {issue.children.map((child) => (
                  <Link
                    key={child.key}
                    href={`/issues/${child.key.toLowerCase()}`}
                    className="prio-relatedrow"
                  >
                    <IconSubIssue size={14} />
                    <IssueTypeIcon type={child.type} size={16} />
                    <IssueKey issueKey={child.key} />
                    <span className="prio-relatedrow__title prio-truncate">
                      {child.title}
                    </span>
                    <StatusPill status={child.status} />
                  </Link>
                ))}
              </CardBody>
            </Card>
          ) : null}

          {/* ------------------------------------------ attachments */}
          <Card className="prio-issue__section">
            <CardBody>
              <IssueAttachments
                issueId={issue.id}
                attachments={issue.attachments}
                currentUserId={user.id}
                isAdmin={user.role === "ADMIN"}
              />
            </CardBody>
          </Card>

          {/* --------------------------------------- related issues */}
          <Card className="prio-issue__section">
            <CardBody>
              <RelatedIssues
                issueId={issue.id}
                links={issue.linksFrom.map((link) => ({
                  linkId: link.id,
                  type: link.type,
                  issue: link.target,
                }))}
              />
            </CardBody>
          </Card>

          {/* ------------------------------- activity and comments */}
          <Card className="prio-issue__section">
            <CardBody>
              <h2 className="prio-issue__section-title">
                <IconActivity size={14} />
                Activity
                <span className="prio-issue__section-note">
                  System events are permanent; comments can be edited by their
                  author, and every edit is recorded.
                </span>
              </h2>

              <IssueConversation
                issueId={issue.id}
                issueKey={issue.key}
                currentUser={{
                  id: user.id,
                  name: user.name,
                  image: user.image,
                  role: user.role,
                }}
                activity={issue.activity}
                comments={issue.comments}
                names={names}
                mentionable={mentionable}
              />
            </CardBody>
          </Card>
        </div>

        {/* ------------------------------------------------------ sidebar */}
        <div className="col-12 col-xl-4">
          <Card className="prio-issue__aside">
            <CardBody>
              <h2 className="prio-issue__section-title">Details</h2>

              <MetaRow label="Status">
                <StatusPill status={issue.status} />
              </MetaRow>

              <MetaRow label="Priority">
                <PriorityControl issueId={issue.id} priority={issue.priority} />
              </MetaRow>

              {isBug ? (
                <MetaRow label="Severity">
                  <SeverityControl issueId={issue.id} severity={issue.severity} />
                </MetaRow>
              ) : null}

              <MetaRow label="Assignee">
                {issue.assignee ? (
                  <span className="prio-person">
                    <Avatar
                      name={issue.assignee.name}
                      image={issue.assignee.image}
                      size="xs"
                    />
                    {issue.assignee.name}
                  </span>
                ) : (
                  <span className="prio-text-muted">Unassigned</span>
                )}
              </MetaRow>

              <MetaRow label="Reporter">
                <span className="prio-person">
                  <Avatar
                    name={issue.reporter.name}
                    image={issue.reporter.image}
                    size="xs"
                  />
                  {issue.reporter.name}
                </span>
              </MetaRow>

              <MetaRow label="Project">
                <Link href={`/projects/${issue.project.key.toLowerCase()}`}>
                  {issue.project.name}
                </Link>
              </MetaRow>

              {issue.labels.length > 0 ? (
                <MetaRow label="Labels">
                  <span className="prio-labelrow">
                    {issue.labels.map(({ label }) => (
                      <LabelChip
                        key={label.id}
                        name={label.name}
                        color={label.color}
                      />
                    ))}
                  </span>
                </MetaRow>
              ) : null}

              {isBug && issue.affectedModule ? (
                <MetaRow label="Module">{issue.affectedModule}</MetaRow>
              ) : null}

              <MetaRow label="Due date">
                <DueDateField issueId={issue.id} dueDate={issue.dueDate}>
                  {issue.dueDate ? (
                    <span
                      className={overdue ? "prio-due prio-due--overdue" : "prio-due"}
                    >
                      {overdue ? (
                        <IconWarning size={13} />
                      ) : (
                        <IconCalendar size={13} />
                      )}
                      {formatDate(issue.dueDate)}
                      {overdue ? " · overdue" : null}
                    </span>
                  ) : (
                    <span className="prio-text-muted">None</span>
                  )}
                </DueDateField>
              </MetaRow>

              <hr className="prio-divider" />

              <MetaRow label="Created">
                <span title={formatDateTime(issue.createdAt)}>
                  {formatRelative(issue.createdAt)}
                </span>
              </MetaRow>

              <MetaRow label="Updated">
                <span title={formatDateTime(issue.updatedAt)}>
                  {formatRelative(issue.updatedAt)}
                </span>
              </MetaRow>

              {issue.completedAt ? (
                <MetaRow label="Closed">
                  <span title={formatDateTime(issue.completedAt)}>
                    {formatRelative(issue.completedAt)}
                  </span>
                </MetaRow>
              ) : null}
            </CardBody>
          </Card>
        </div>
      </div>
    </article>
  );
}
