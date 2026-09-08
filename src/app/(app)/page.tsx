import Link from "next/link";
import { Card, CardBody, EmptyState } from "@/components/ui/primitives";
import {
  IconActivity,
  IconBug,
  IconCheck,
  IconEmptyBox,
  IconIssues,
  IconMyWork,
  IconProjects,
  IconUsers,
  IconWarning,
} from "@/components/ui/Icon";
import {
  ActivityList,
  AssignedRow,
  DueBar,
  IssueRow,
  KpiCard,
  PriorityDistribution,
  ProjectRow,
  RoleBadge,
  SectionHead,
  StatusDistribution,
  TeamMembers,
  TypeDistribution,
  WorkGrid,
  WorkloadList,
} from "@/components/dashboard/DashboardParts";
import { QuickActions } from "@/components/dashboard/QuickActions";
import { requireUser } from "@/lib/session";
import { workRoleOf } from "@/lib/authz";
import { loadDashboard } from "@/server/queries/dashboard";

export const dynamic = "force-dynamic";

/**
 * Home — the role-based dashboard.
 *
 * Two commitments hold this page together:
 *
 *  - **Every number is real.** All of it comes from `loadDashboard`, which
 *    aggregates rows the signed-in person is actually allowed to see. Nothing
 *    is padded with sample data; where a section has nothing to show, it says
 *    so plainly instead of inventing a figure.
 *  - **The role shapes the page, and the server enforces it.** Admins see
 *    org-wide sections; everyone else sees their own scope. The gating below is
 *    presentation — `loadDashboard` and every linked route authorize
 *    independently, so nothing here is load-bearing for access control.
 */
export default async function HomePage() {
  const user = await requireUser();
  const data = await loadDashboard(user);

  const firstName = user.name.split(" ")[0] ?? user.name;
  const isAdmin = data.scope.isAdmin;
  const workRole = await workRoleOf(user);

  /* Greeting and date are computed once, server-side, from the same request
     clock the aggregates used — so the copy can never disagree with the data. */
  const now = new Date();
  const hour = now.getHours();
  const greeting =
    hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const today = new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(now);

  const mine = `/issues?assignee=${user.id}`;

  return (
    <div className="prio-dash">
      {/* ------------------------------------------------------------ hero */}
      <header className="prio-dash__hero">
        <div>
          <h1 className="prio-dash__greeting">
            {greeting}, {firstName}
          </h1>
          <p className="prio-dash__subtitle">
            {data.myWork.assigned > 0
              ? `You have ${data.myWork.assigned} open ${
                  data.myWork.assigned === 1 ? "item" : "items"
                } assigned to you across ${data.kpi.projects} ${
                  data.kpi.projects === 1 ? "project" : "projects"
                }.`
              : data.kpi.projects > 0
                ? `Nothing is assigned to you right now across ${data.kpi.projects} ${
                    data.kpi.projects === 1 ? "project" : "projects"
                  }.`
                : "You are not a member of any project yet."}
          </p>
          <div className="prio-dash__herometa">
            <span className="prio-dash__date">{today}</span>
          </div>
        </div>

        {/*
          * The role, top-right, above the work below it.
          *
          * It used to sit beside the date under the greeting, where it read as
          * a detail of the sentence above rather than a statement about the
          * reader. A QA member arriving at this page is being told what they
          * are before being shown the two things that follow from it — My work
          * and their QA queue — so the badge heads the column those sit under.
          *
          * Same component, same derivation, same single place it comes from.
          * Only where it is drawn changed.
          */}
        <div className="prio-dash__heroaside">
          <RoleBadge role={workRole} />
          <QuickActions role={workRole} userId={user.id} />
        </div>
      </header>

      {data.kpi.projects === 0 ? (
        /* No project membership: one honest empty state, and nothing else.
           Rendering zeroed charts here would only be decoration. */
        <Card>
          <EmptyState
            icon={<IconEmptyBox />}
            title="No projects yet"
            body={
              isAdmin
                ? "Create your first project to start tracking work in Prio. Once it has issues, this page fills with your real data."
                : "You are not a member of any project yet. Ask an administrator to add you to one."
            }
            actions={
              isAdmin ? (
                <Link href="/projects" className="prio-btn prio-btn--primary">
                  Go to projects
                </Link>
              ) : null
            }
          />
        </Card>
      ) : (
        <>
          {/* --------------------------------------------------- due bar */}
          <DueBar
            overdue={data.due.overdue}
            today={data.due.today}
            thisWeek={data.due.thisWeek}
            userId={user.id}
          />

          {/* ------------------------------------------------ kpi cards */}
          <div className="row g-3">
            <div className="col-12 col-sm-6 col-xl-3">
              <KpiCard
                label="Assigned to me"
                value={data.myWork.assigned}
                icon={<IconMyWork size={13} />}
                tone="brand"
                hint="Open work in your name"
                href={`${mine}&resolution=open`}
              />
            </div>
            <div className="col-12 col-sm-6 col-xl-3">
              <KpiCard
                label="Open issues"
                value={data.kpi.openIssues}
                icon={<IconIssues size={13} />}
                hint={`${data.kpi.inProgress} in progress`}
                href="/issues?resolution=open"
              />
            </div>
            <div className="col-12 col-sm-6 col-xl-3">
              {/*
                * High priority rather than open bugs: what needs attention is
                * a question about urgency, not about issue type, and a
                * high-priority story is no less pressing than a bug. The
                * figure is `highPriorityOpen`, which the dashboard already
                * computed — Urgent and High, still open — and the link filters
                * the issue list to exactly that, so the count and the list it
                * opens can never disagree.
                */}
              <KpiCard
                label="High priority"
                value={data.kpi.highPriorityOpen}
                icon={<IconWarning size={13} />}
                tone={data.kpi.highPriorityOpen > 0 ? "danger" : "default"}
                hint={`${data.kpi.openBugs} of them ${data.kpi.openBugs === 1 ? "is a bug" : "are bugs"}`}
                href="/issues?priority=URGENT&priority=HIGH&resolution=open"
              />
            </div>
            <div className="col-12 col-sm-6 col-xl-3">
              {/*
                * One metric, said four times: the title, the number, the line
                * under it and the list it opens are all "issues at status
                * DONE, in the projects this person can see".
                *
                * It used to be "Completed this month" over the monthly count
                * with "N completed in total" beneath it — two different
                * figures on one card, which is how it could read 0 above 3.
                * A card whose parts disagree is worse than either figure
                * alone, so the card now answers one question.
                *
                * `completed` is scoped by `accessibleProjectIds`, and the
                * `/issues` list it opens is scoped by `issueScope` — the same
                * projects either way, so an administrator and a member each
                * see their own count and their own list, and clicking through
                * lands on exactly the issues that were counted.
                */}
              <KpiCard
                label="Completed issues"
                value={data.kpi.completed}
                icon={<IconCheck size={13} />}
                tone="success"
                hint={`${data.kpi.completed} completed in total`}
                href="/issues?status=DONE"
              />
            </div>
          </div>

          {/* ------------------------------------------ assigned to me */}
          {/* Personal queues, deliberately not shown to an administrator: an
              Admin Home answers "how is the organisation doing", and a
              personal list here competes with that. The data is unchanged and
              still reachable from Issues — this is what the page shows, not
              what anyone is allowed to see. */}
          {!isAdmin ? (
          <section>
            <SectionHead
              title="My assigned tasks"
              count={data.myWork.assigned}
              href={`${mine}&resolution=open`}
              linkLabel="View all assigned"
            />

            {data.assigned.length === 0 ? (
              <Card>
                <EmptyState
                  icon={<IconMyWork />}
                  title="Nothing assigned to you"
                  body="When someone assigns you an issue or a bug it appears here, sorted by how soon it is due."
                />
              </Card>
            ) : (
              <div className="prio-assignedlist">
                {data.assigned.map((issue) => (
                  <AssignedRow key={issue.id} issue={issue} />
                ))}
              </div>
            )}
          </section>
          ) : null}

          {/* -------------------------------------------- team members */}
          {/* Visible to every signed-in person by default, Member and Admin
              alike — not gated behind `isAdmin` like the Organisation section
              below. Scoped to the viewer's own accessible projects, so it
              never exposes org-wide or cross-project data to a Member. */}
          <section>
            <SectionHead
              title="Team members"
              count={data.teamMembers.length}
            />
            <Card>
              <CardBody>
                <TeamMembers members={data.teamMembers} isAdmin={isAdmin} />
              </CardBody>
            </Card>
          </section>

          {/* -------------------------------------------- my work + qa */}
          <div className="row g-3">
            {!isAdmin ? (
              <div className={data.qa ? "col-12 col-xl-7" : "col-12"}>
                <Card style={{ height: "100%" }}>
                  <CardBody>
                    <h2 className="prio-dash__section-title">My work</h2>
                    <div style={{ marginTop: "var(--prio-space-4)" }}>
                      <WorkGrid work={data.myWork} userId={user.id} />
                    </div>
                  </CardBody>
                </Card>
              </div>
            ) : null}

            {/* The QA panel: a tester's queue, or — as before — the bugs of
                somebody whose history is bug-led. Which of the two it is
                changes what "Ready for QA" counts, and nothing else. */}
            {data.qa ? (
              <div className={isAdmin ? "col-12" : "col-12 col-xl-5"}>
                <Card style={{ height: "100%" }}>
                  <CardBody>
                    <h2 className="prio-dash__section-title">
                      {data.qa.isTester ? "My QA queue" : "Bugs I reported"}
                    </h2>
                    <div
                      className="prio-workgrid"
                      style={{ marginTop: "var(--prio-space-4)" }}
                    >
                      <Link
                        href={`/issues?reporter=${user.id}&type=BUG`}
                        className="prio-worktile"
                      >
                        <span className="prio-worktile__value">
                          {data.qa.bugsReportedByMe}
                        </span>
                        <span className="prio-worktile__label">Reported</span>
                      </Link>
                      {/* A tester checks whatever a developer hands back, not
                          only the bugs they raised themselves — but only what
                          has been handed to *them*. The link carries the same
                          assignee the count is cut on, so opening the tile
                          shows the rows the figure was counting rather than
                          every unchecked issue in their projects. */}
                      <Link
                        href={
                          data.qa.isTester
                            ? `/issues?assignee=${user.id}&status=IN_REVIEW`
                            : `/issues?reporter=${user.id}&type=BUG&status=IN_REVIEW`
                        }
                        className="prio-worktile"
                      >
                        <span className="prio-worktile__value">
                          {data.qa.isTester
                            ? data.qa.readyForQa
                            : data.qa.awaitingVerification}
                        </span>
                        <span className="prio-worktile__label">Ready for QA</span>
                      </Link>
                      <Link
                        href="/bugs?priority=URGENT&resolution=open"
                        className="prio-worktile"
                        data-tone={data.qa.urgentOpen > 0 ? "danger" : undefined}
                      >
                        <span className="prio-worktile__value">
                          {data.qa.urgentOpen}
                        </span>
                        <span className="prio-worktile__label">Urgent</span>
                      </Link>
                    </div>
                  </CardBody>
                </Card>
              </div>
            ) : null}
          </div>

          {/* ------------------------------------ projects + activity */}
          <div className="row g-3">
            <div className="col-12 col-xl-7">
              <SectionHead
                title="Projects"
                count={data.projects.length}
                href="/projects"
              />
              <div className="row g-3">
                {data.projects.map((project) => (
                  <div key={project.id} className="col-12 col-md-6">
                    <ProjectRow project={project} />
                  </div>
                ))}
              </div>
            </div>

            <div className="col-12 col-xl-5">
              <SectionHead title="Recent activity" />
              <Card>
                <CardBody>
                  <ActivityList entries={data.activity} />
                </CardBody>
              </Card>
            </div>
          </div>

          {/* ---------------------------------------------- analytics */}
          <section>
            <SectionHead
              title="Analytics"
              href="/reports"
              linkLabel="Full reports"
            />
            <div className="row g-3">
              <div className="col-12 col-lg-4">
                <StatusDistribution byStatus={data.byStatus} />
              </div>
              <div className="col-12 col-lg-4">
                <PriorityDistribution byPriority={data.byPriority} />
              </div>
              <div className="col-12 col-lg-4">
                <TypeDistribution byType={data.byType} />
              </div>
            </div>
          </section>

          {/* --------------------------------------- important issues */}
          {data.important.length > 0 ? (
            <section>
              <SectionHead
                title="Needs attention"
                count={data.important.length}
                href="/issues?priority=URGENT&priority=HIGH&resolution=open"
                linkLabel="View all high priority"
              />
              <Card className="prio-dash__attention">
                <CardBody tight>
                  {data.important.map((issue) => (
                    <IssueRow key={issue.id} issue={issue} />
                  ))}
                </CardBody>
              </Card>
            </section>
          ) : null}

          {/* ------------------------------------------- admin: org-wide */}
          {isAdmin && data.org ? (
            <section>
              <SectionHead
                title="Organisation"
                href="/admin"
                linkLabel="Manage people"
              />

              <div className="row g-3">
                <div className="col-12 col-sm-6 col-xl-3">
                  <KpiCard
                    label="Active people"
                    value={data.org.activeUsers}
                    icon={<IconUsers size={13} />}
                    hint={`${data.org.admins} ${
                      data.org.admins === 1 ? "administrator" : "administrators"
                    } · ${data.org.users} total`}
                    href="/admin"
                  />
                </div>
                <div className="col-12 col-sm-6 col-xl-3">
                  <KpiCard
                    label="Open bugs"
                    value={data.org.openBugs}
                    icon={<IconBug size={13} />}
                    tone={data.org.openBugs > 0 ? "danger" : "default"}
                    hint={`${data.org.urgentOpen} urgent`}
                    href="/bugs?resolution=open"
                  />
                </div>
                <div className="col-12 col-sm-6 col-xl-3">
                  <KpiCard
                    label="Unassigned open"
                    value={data.org.unassignedOpen}
                    icon={<IconWarning size={13} />}
                    tone={data.org.unassignedOpen > 0 ? "warning" : "default"}
                    hint="Open work with no owner"
                    href="/issues?resolution=open&assignee=none"
                  />
                </div>
                <div className="col-12 col-sm-6 col-xl-3">
                  <KpiCard
                    label="All issues"
                    value={data.org.totalIssues}
                    icon={<IconProjects size={13} />}
                    hint={`Across ${data.kpi.projects} ${
                      data.kpi.projects === 1 ? "project" : "projects"
                    }`}
                    href="/issues"
                  />
                </div>
              </div>

              <div className="row g-3" style={{ marginTop: 0 }}>
                <div className="col-12 col-xl-6">
                  <Card style={{ height: "100%" }}>
                    <CardBody>
                      <h2 className="prio-issue__section-title">
                        Open work by person
                      </h2>
                      <WorkloadList people={data.org.workload} />
                    </CardBody>
                  </Card>
                </div>
                <div className="col-12 col-xl-6">
                  <Card style={{ height: "100%" }}>
                    <CardBody>
                      <h2 className="prio-issue__section-title">
                        <IconActivity size={15} /> Where the work sits
                      </h2>
                      <p className="prio-text-muted">
                        {data.kpi.inProgress} in progress,{" "}
                        {data.kpi.createdThisMonth} raised this month,{" "}
                        {data.kpi.newProjectsThisMonth} new{" "}
                        {data.kpi.newProjectsThisMonth === 1
                          ? "project"
                          : "projects"}
                        .
                      </p>
                    </CardBody>
                  </Card>
                </div>
              </div>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
