import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { type NameLookup } from "@/components/issues/ActivityFeed";
import { BackLink } from "@/components/shell/BackLink";
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
  EditableDescription,
  EditableTitle,
  ParentControl,
} from "@/components/issues/EditableIssueFields";
import { IssueDetailActions } from "@/components/issues/IssueDetailActions";
import { SubmitWorkButton } from "@/components/issues/SubmitWorkButton";
import { TestResultPanel } from "@/components/issues/TestResultPanel";
import { ReportBugDialog } from "@/components/issues/ReportBugDialog";
import { ClaimIssueButton } from "@/components/issues/ClaimIssueButton";
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
  PriorityIndicator,
  SeverityChip,
  StatusPill,
} from "@/components/ui/Indicators";
import {
  IconActivity,
  IconCalendar,
  IconEdit,
  IconParent,
  IconSubIssue,
  IconWarning,
} from "@/components/ui/Icon";
import { issueScope, workRoleOf } from "@/lib/authz";
import { ISSUE_TYPE_LABEL, isClosedStatus } from "@/lib/domain";
import { formatDate, formatDateTime, formatRelative, isOverdue } from "@/lib/format";
import { prisma } from "@/lib/prisma";
import { requireUser, type CurrentUser } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Issue detail.
 *
 * One route, and now one *shape*, for every type. A Story, a Task and a Bug
 * are the same record — summary, description, priority, severity, assignee,
 * attachments, parent, links — and this page renders all of them the same way.
 * There is no bug-only section any more: what a bug used to be asked for
 * separately is written in the description, which every type has.
 *
 * The retired columns (`stepsToReproduce`, `expectedResult`, `actualResult`
 * and the environment group) are untouched in the database and still reached
 * by search; they are simply no longer a panel that appears for one type and
 * not the others.
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
      description: true,
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
      parentId: true,
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
          parentId: true,
          author: { select: { id: true, name: true, image: true } },
          attachments: {
            orderBy: { createdAt: "asc" },
            select: ATTACHMENT_SELECT,
          },
          reactions: {
            select: { emoji: true, userId: true },
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

/**
 * The list this issue was opened from, if it says so and the claim is safe.
 *
 * `from` is user-controlled — it arrives in the query string and is rendered
 * into an `href` — so only a plain internal path is accepted. A protocol-
 * relative `//evil.example` is a path as far as `startsWith("/")` is concerned
 * and a browser reads it as another origin, which is why the second character
 * is checked too. Anything else is ignored and the reader simply gets no back
 * link, which is what they had before.
 */
function listReturnPath(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  return value;
}

/** "Back to Issues" for the global list, "Back to <Project>" for a project's. */
function returnLabel(path: string, projectName: string): string {
  return path.startsWith("/projects/") ? `Back to ${projectName}` : "Back to Issues";
}

export default async function IssueDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ key: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { key } = await params;
  const returnTo = listReturnPath((await searchParams).from);
  const user = await requireUser();
  /* What this reader does here, so the page offers only what is theirs
     to do. Every action it leads to re-checks on the server. */
  const workRole = await workRoleOf(user);

  const issue = await loadIssue(key, user);
  if (!issue) notFound();

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
          {/*
            * Back to the list that was open, not to the project's summary.
            * Only shown when the reader actually arrived from one — opening an
            * issue from a notification or a pasted key has no list to return
            * to, and the breadcrumb below still leads to the project.
            */}
          {returnTo ? (
            <div className="prio-issue__return">
              <BackLink
                href={returnTo}
                label={returnLabel(returnTo, issue.project.name)}
              />
            </div>
          ) : null}

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
            {/* Filing a defect off this issue is raising work, which is a
                tester's or an administrator's act. */}
            {workRole === "DEVELOPER" ? null : (
              <ReportBugDialog
                issueId={issue.id}
                issueKey={issue.key}
                assigneeId={issue.assignee?.id ?? null}
                currentUserId={user.id}
              />
            )}

            {/* Picking the work up — for themselves, never for anyone else. */}
            {workRole === "DEVELOPER" ? (
              <ClaimIssueButton
                issueId={issue.id}
                issueKey={issue.key}
                status={issue.status}
                assigneeId={issue.assignee?.id ?? null}
                assigneeName={issue.assignee?.name ?? null}
                currentUserId={user.id}
              />
            ) : null}

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
          {/* Severity is a standard field, offered for every type — the same
              control a bug has always had, no longer hidden on the others. */}
          <SeverityControl issueId={issue.id} severity={issue.severity} />
          <AssigneeControl
            issueId={issue.id}
            assignee={issue.assignee}
            members={members.map((m) => m.user)}
            canAssign={workRole === "ADMIN"}
          />
          {/*
            * Due date sits with the other things that get changed about an
            * issue, next to who it is on. The calendar icon is what makes it
            * legible at a glance among the pills either side of it, and it
            * shows even with no date set -- "No due date" is a state worth
            * being able to see and click, not an absence to leave blank.
            */}
          <DueDateField issueId={issue.id} dueDate={issue.dueDate}>
            <span
              className={overdue ? "prio-due prio-due--overdue" : "prio-due"}
            >
              {overdue ? <IconWarning size={13} /> : <IconCalendar size={13} />}
              {issue.dueDate ? formatDate(issue.dueDate) : "No due date"}
              {overdue ? " · overdue" : null}
            </span>
          </DueDateField>
        </div>
      </header>

      <div className="row g-4">
        {/* --------------------------------------------------- main column */}
        <div className="col-12 col-xl-8">
          {/* --------------------------------------------- description */}
          <Card className="prio-issue__section">
            <CardBody>
              <h2 className="prio-issue__section-title">
                <IconEdit size={14} />
                Description
              </h2>
              <EditableDescription
                issueId={issue.id}
                description={issue.description}
              />
            </CardBody>
          </Card>

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
                reporterId={issue.reporter.id}
                currentUserId={user.id}
              />
            </CardBody>
          </Card>

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

          {/* ------------------------------- comments and activity */}
          <Card className="prio-issue__section">
            <CardBody>
              {/*
               * Named for the discussion, because that is what people open an
               * issue to read and write — the audit trail is the tab beside
               * it. This is the section's heading only: the Activity tab, the
               * /activity page and the audit records behind both are
               * untouched, and nothing else in the app was renamed.
               */}
              <h2 className="prio-issue__section-title">
                <IconActivity size={14} />
                Comments
                <span className="prio-issue__section-note">
                  Comments can be edited by their author; every edit, and every
                  system event, is recorded under Activity.
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
              {/*
               * Details reads; it does not edit.
               *
               * Status, priority, severity, assignee and the due date are all
               * changed from the header above, and every one of them used to
               * appear here a second time as a second control for the same
               * field. Two live controls for one value is how a page ends up
               * disagreeing with itself mid-save. What is left is the summary
               * this panel was for.
               */}
              <h2 className="prio-issue__section-title">Details</h2>

              <MetaRow label="Status">
                <StatusPill status={issue.status} />
              </MetaRow>

              <MetaRow label="Priority">
                <PriorityIndicator priority={issue.priority} />
              </MetaRow>

              {/*
               * Severity, read-only here like the rest of Details, editable
               * from the header. Shown for whatever type carries one — it is a
               * standard field now, not a bug's field, so the row appears
               * because a severity was set and not because of the type.
               */}
              {issue.severity ? (
                <MetaRow label="Severity">
                  <SeverityChip severity={issue.severity} />
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

              {/*
               * Two different relationships, deliberately adjacent and
               * deliberately distinct: Parent is the **issue** this one is
               * filed under, Project is where both of them live. Neither is
               * ever derived from the other, and the project never appears as
               * an issue's parent.
               */}
              <MetaRow label="Parent">
                <ParentControl
                  issueId={issue.id}
                  projectId={issue.project.id}
                  parent={issue.parent}
                />
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

              {/*
               * What the retired columns still hold.
               *
               * Nothing collects these any more — there is no Environment box
               * on the form and no bug-only panel on this page — but nine
               * issues recorded before that change still carry real values,
               * and Module is still written today by the QA report-bug flow.
               * Deleting the data was never on the table; hiding it would have
               * been the same loss by a slower route.
               *
               * Each row appears because a value exists, never because of the
               * issue's type, so the page keeps one shape for a story, a task
               * and a bug alike.
               */}
              {issue.affectedModule ? (
                <MetaRow label="Module">{issue.affectedModule}</MetaRow>
              ) : null}

              {issue.environment ? (
                <MetaRow label="Environment">{issue.environment}</MetaRow>
              ) : null}

              {issue.browser ? (
                <MetaRow label="Browser">{issue.browser}</MetaRow>
              ) : null}

              {issue.operatingSystem ? (
                <MetaRow label="Operating system">
                  {issue.operatingSystem}
                </MetaRow>
              ) : null}

              {issue.versionBuild ? (
                <MetaRow label="Version / build">
                  <span className="prio-mono">{issue.versionBuild}</span>
                </MetaRow>
              ) : null}

              <MetaRow label="Due date">
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
                  <span className="prio-due prio-due--none">
                    <IconCalendar size={13} />
                    None
                  </span>
                )}
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

              {/* The persisted `completedAt`, never "now" — and its own row,
                  so it can never be mistaken for the due date above it. */}
              {issue.completedAt ? (
                <MetaRow label="Completed date">
                  <span title={formatDateTime(issue.completedAt)}>
                    {formatDate(issue.completedAt)}
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
