"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Avatar, Button } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/Dialog";
import { SearchSelect } from "@/components/admin/SearchSelect";
import { IssueKey, StatusPill } from "@/components/ui/Indicators";
import { useToast } from "@/components/ui/Toast";
import { IconMyWork } from "@/components/ui/Icon";
import { STATUS_LABEL, WORK_ROLE_LABEL } from "@/lib/domain";
import { assignWork, laneIssues, laneMembers } from "@/server/workStatus";
import {
  applyBacklogAllocation,
  previewBacklogAllocation,
} from "@/server/backlogAssignment";
import type { BacklogPlan } from "@/lib/backlogAllocation";
import { WORK_LANE_LABEL } from "@/lib/workLanes";
import type {
  WorkLane,
  WorkStatusData,
  WorkStatusIssue,
  WorkStatusLane,
  WorkStatusMember,
} from "@/lib/workLanes";

/**
 * Work Status — Admin Home's replacement for "Assigned to me".
 *
 * It sits in the same slot, in the same `prio-kpi` shell as the three cards
 * beside it, and holds the two acts an administrator's Home is actually for:
 * handing what is Ready for QA to a tester, and handing what has been raised to
 * a developer. Each button carries the number of issues still waiting in that
 * lane — in the right status, with nobody who could do the work holding them —
 * and that number is the one the dialog then lists, from the same fragment, so
 * a count and the work behind it cannot disagree.
 *
 * Nothing here is a permission. Every list is fetched from an administrator-only
 * action and the assignment itself re-checks the issue, the person and the
 * caller; this component only decides what is drawn.
 *
 * The dialog is the workflow in order — project, then issue, then person — and
 * each choice resets the ones after it, because an issue chosen from one
 * project is never valid in another. `latestProject` is what makes a slow reply
 * harmless: two quick changes leave two requests in flight and only the one
 * still selected may write its result. The same shape `TeamAdmin` already uses
 * for exactly this.
 */
export function WorkStatusCard({ data }: { data: WorkStatusData }) {
  const router = useRouter();
  const { toast } = useToast();

  const [lane, setLane] = useState<WorkLane | null>(null);
  const [projectId, setProjectId] = useState("");
  const [issueId, setIssueId] = useState("");
  const [personId, setPersonId] = useState("");

  const [issues, setIssues] = useState<WorkStatusIssue[] | null>(null);
  const [people, setPeople] = useState<WorkStatusMember[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  /* Auto-assignment has its own dialog, its own project and its own plan. It
     sits beside the two lanes rather than inside them: dealing a backlog out in
     bulk and choosing one person for one issue are different acts, and the
     manual dialog is deliberately left exactly as it was. */
  const [autoOpen, setAutoOpen] = useState(false);
  const [autoProjectId, setAutoProjectId] = useState("");
  const [plan, setPlan] = useState<BacklogPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [applying, setApplying] = useState(false);

  const latestProject = useRef("");
  const latestAutoProject = useRef("");

  const current: WorkStatusLane | null =
    lane === "QA" ? data.qa : lane === "DEVELOPER" ? data.developer : null;

  function open(next: WorkLane) {
    latestProject.current = "";
    setProjectId("");
    setIssueId("");
    setPersonId("");
    setIssues(null);
    setPeople(null);
    setLane(next);
  }

  function close() {
    setLane(null);
  }

  async function chooseProject(nextId: string) {
    latestProject.current = nextId;

    setProjectId(nextId);
    setIssueId("");
    setPersonId("");
    setIssues(null);
    setPeople(null);

    if (!nextId || !lane) return;

    setLoading(true);
    const [issueResult, peopleResult] = await Promise.all([
      laneIssues({ lane, projectId: nextId }),
      laneMembers({ lane, projectId: nextId }),
    ]);

    /* A different project was chosen while these were in flight: this answer
       describes a project nobody is looking at any more. */
    if (latestProject.current !== nextId) return;

    setLoading(false);
    setIssues(issueResult.ok ? issueResult.data : []);
    setPeople(peopleResult.ok ? peopleResult.data : []);

    if (!issueResult.ok) toast(issueResult.error, "error");
    else if (!peopleResult.ok) toast(peopleResult.error, "error");
  }

  async function submit() {
    if (!lane || !issueId || !personId) return;

    setSaving(true);
    const result = await assignWork({ lane, issueId, assigneeId: personId });
    setSaving(false);

    if (!result.ok) {
      toast(result.error, "error");
      return;
    }

    const person = people?.find((p) => p.id === personId);
    toast(
      person
        ? `${result.data.key} assigned to ${person.name}`
        : `${result.data.key} assigned`,
    );
    close();
    /* The card's counts and the lists behind them come from the server, and
       `updateIssue` has already revalidated Home. Refreshing is what pulls the
       new figures down, so the issue just handed out is gone from the next
       dialog rather than lingering in client state. */
    router.refresh();
  }

  function openAuto() {
    latestAutoProject.current = "";
    setAutoProjectId("");
    setPlan(null);
    setAutoOpen(true);
  }

  /** Choosing a project asks the server what it would do, and shows it. */
  async function chooseAutoProject(nextId: string) {
    latestAutoProject.current = nextId;

    setAutoProjectId(nextId);
    setPlan(null);
    if (!nextId) return;

    setPlanning(true);
    const result = await previewBacklogAllocation({ projectId: nextId });

    /* A different project was chosen while this was in flight. */
    if (latestAutoProject.current !== nextId) return;
    setPlanning(false);

    if (!result.ok) {
      toast(result.error, "error");
      return;
    }
    setPlan(result.data);
  }

  /**
   * Applying recomputes the plan on the server rather than posting this one
   * back to it, so what gets written is what was true at the moment of writing
   * — and so this dialog cannot be used to assign whatever it likes.
   */
  async function applyPlan() {
    if (!autoProjectId) return;

    setApplying(true);
    const result = await applyBacklogAllocation({ projectId: autoProjectId });
    setApplying(false);

    if (!result.ok) {
      toast(result.error, "error");
      return;
    }

    const { assigned } = result.data;
    toast(
      assigned === 0
        ? "Nothing was left to assign."
        : `${assigned} ${assigned === 1 ? "issue" : "issues"} assigned`,
    );
    setAutoOpen(false);
    router.refresh();
  }

  return (
    <>
      <div className="prio-kpi prio-workstatus" data-tone="brand">
        <span className="prio-kpi__label">
          <IconMyWork size={13} />
          Work Status
        </span>

        <div className="prio-workstatus__actions">
          <Button
            variant="secondary"
            size="sm"
            block
            onClick={() => open("QA")}
            disabled={data.qa.count === 0}
          >
            <span className="prio-workstatus__btntext">
              {WORK_LANE_LABEL.QA}
            </span>
            <span className="prio-workstatus__count">{data.qa.count}</span>
          </Button>
          <Button
            variant="secondary"
            size="sm"
            block
            onClick={() => open("DEVELOPER")}
            disabled={data.developer.count === 0}
          >
            <span className="prio-workstatus__btntext">
              {WORK_LANE_LABEL.DEVELOPER}
            </span>
            <span className="prio-workstatus__count">
              {data.developer.count}
            </span>
          </Button>

          {/* A third way to hand work out, beside the two that choose one
              person for one issue rather than instead of them. */}
          <Button
            variant="ghost"
            size="sm"
            block
            onClick={openAuto}
            disabled={data.developer.count === 0}
          >
            <span className="prio-workstatus__btntext">
              Auto-assign backlog
            </span>
          </Button>
        </div>

        <span className="prio-kpi__foot">
          <span className="prio-kpi__hint">
            {data.qa.count === 0 && data.developer.count === 0
              ? "Nothing is waiting to be handed out."
              : "Waiting for somebody to pick up"}
          </span>
        </span>
      </div>

      {lane && current ? (
        <Dialog
          open
          onClose={close}
          title={WORK_LANE_LABEL[lane]}
          busy={saving}
          description={
            lane === "QA"
              ? "Work a developer has handed over. Choose the project, the issue that is Ready for QA, and the tester who will check it."
              : "Work that has been raised and not picked up. Choose the project, the issue — New, Reopen or Backlog — and the developer who will build it."
          }
          footer={
            <>
              <Button variant="ghost" onClick={close} disabled={saving}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={submit}
                loading={saving}
                disabled={saving || !issueId || !personId}
              >
                Assign
              </Button>
            </>
          }
        >
          <div className="prio-field">
            <label className="prio-label" htmlFor="workstatus-project">
              Project
            </label>
            {/* Only projects holding at least one eligible issue. A project
                with nothing waiting is not a choice that leads anywhere. */}
            <SearchSelect
              id="workstatus-project"
              ariaLabel="Search projects"
              placeholder="Search projects by name or key…"
              emptyHint={
                lane === "QA"
                  ? "No project has work waiting for QA."
                  : "No project has work waiting for a developer."
              }
              options={current.projects.map((project) => ({
                id: project.id,
                label: project.name,
                meta: `${project.key} · ${project.count} waiting`,
                keywords: project.key,
              }))}
              selected={projectId ? [projectId] : []}
              onChange={(next) => void chooseProject(next[0] ?? "")}
            />
          </div>

          <div className="prio-field">
            <label className="prio-label" htmlFor="workstatus-issue">
              {lane === "QA" ? "Ready for QA issue" : "Issue"}
            </label>
            {!projectId ? (
              <p className="prio-text-muted">
                Choose a project first — issues are that project&rsquo;s only.
              </p>
            ) : loading ? (
              <p className="prio-text-muted">Loading issues…</p>
            ) : (
              <SearchSelect
                id="workstatus-issue"
                ariaLabel="Search issues waiting to be assigned"
                placeholder="Search issues by key or summary…"
                emptyHint="Nothing in this project is waiting any more."
                options={(issues ?? []).map((issue) => ({
                  id: issue.id,
                  label: `${issue.key} — ${issue.title}`,
                  /* The status is shown because this lane holds more than one
                     of them, and which one an issue is in is the reason it is
                     on this list at all. */
                  meta: issue.assigneeName
                    ? `${STATUS_LABEL[issue.status]} · currently ${issue.assigneeName}`
                    : STATUS_LABEL[issue.status],
                  keywords: issue.key,
                }))}
                selected={issueId ? [issueId] : []}
                onChange={(next) => setIssueId(next[0] ?? "")}
              />
            )}
          </div>

          <div className="prio-field">
            <label className="prio-label" htmlFor="workstatus-person">
              {lane === "QA" ? "QA / Tester" : "Developer"}
            </label>
            {!projectId ? (
              <p className="prio-text-muted">
                Choose a project first — only its members can be given its work.
              </p>
            ) : loading ? (
              <p className="prio-text-muted">Loading people…</p>
            ) : (
              <SearchSelect
                id="workstatus-person"
                ariaLabel="Search people by name, designation or email"
                placeholder="Search by name, designation or email…"
                emptyHint={
                  lane === "QA"
                    ? "Nobody on this project does QA work."
                    : "Nobody on this project does development work."
                }
                options={(people ?? []).map((person) => ({
                  id: person.id,
                  label: person.name,
                  meta: `${person.jobTitle ?? "Not set"} · ${WORK_ROLE_LABEL[person.workRole]}`,
                  /* Searchable by email without printing an address on every
                     row — the same rule Administration's pickers follow. */
                  keywords: person.email,
                  adornment: (
                    <Avatar name={person.name} image={person.image} size="sm" />
                  ),
                }))}
                selected={personId ? [personId] : []}
                onChange={(next) => setPersonId(next[0] ?? "")}
              />
            )}
          </div>

          {issueId && issues ? (
            <p className="prio-hint">
              {(() => {
                const issue = issues.find((row) => row.id === issueId);
                return issue ? (
                  <>
                    <StatusPill status={issue.status} /> {issue.key} stays where
                    it is — assigning work changes who holds it, not where it is.
                  </>
                ) : null;
              })()}
            </p>
          ) : null}
        </Dialog>
      ) : null}

      {autoOpen ? (
        <Dialog
          open
          onClose={() => setAutoOpen(false)}
          title="Auto-assign backlog"
          size="lg"
          busy={applying}
          description="Deals a project's backlog out across the developers on it: most urgent work first, each issue to whoever has the lightest queue at the time."
          footer={
            <>
              <Button
                variant="ghost"
                onClick={() => setAutoOpen(false)}
                disabled={applying}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={applyPlan}
                loading={applying}
                disabled={applying || !plan || plan.allocations.length === 0}
              >
                {plan && plan.allocations.length > 0
                  ? `Assign ${plan.allocations.length} ${
                      plan.allocations.length === 1 ? "issue" : "issues"
                    }`
                  : "Assign"}
              </Button>
            </>
          }
        >
          <div className="prio-field">
            <label className="prio-label" htmlFor="autoassign-project">
              Project
            </label>
            <SearchSelect
              id="autoassign-project"
              ariaLabel="Search projects"
              placeholder="Search projects by name or key…"
              emptyHint="No project has work waiting for a developer."
              /* The projects with work waiting for a developer — the same list
                 the manual dialog offers, because it is the same question. */
              options={data.developer.projects.map((project) => ({
                id: project.id,
                label: project.name,
                meta: `${project.key} · ${project.count} waiting`,
                keywords: project.key,
              }))}
              selected={autoProjectId ? [autoProjectId] : []}
              onChange={(next) => void chooseAutoProject(next[0] ?? "")}
            />
          </div>

          {/* The plan is shown before anything is written, because an
              assignment nobody could inspect first is just an opaque write. */}
          {!autoProjectId ? (
            <p className="prio-text-muted">
              Choose a project to see what would be assigned, before any of it
              is.
            </p>
          ) : planning ? (
            <p className="prio-text-muted">Working out the plan…</p>
          ) : plan && plan.allocations.length > 0 ? (
            <>
              <p className="prio-hint">
                {plan.waiting > plan.allocations.length
                  ? `${plan.waiting} backlog issues are waiting. The ${plan.allocations.length} most urgent are placed in this run.`
                  : `${plan.allocations.length} backlog ${
                      plan.allocations.length === 1 ? "issue is" : "issues are"
                    } waiting, and all of them are placed here.`}
              </p>

              <ul className="prio-autoassign">
                {plan.allocations.map((row) => (
                  <li key={row.issueId} className="prio-autoassign__row">
                    <span className="prio-autoassign__issue">
                      <IssueKey issueKey={row.issueKey} />
                      <span className="prio-truncate">{row.issueTitle}</span>
                    </span>
                    <span className="prio-autoassign__who">
                      {row.assigneeName}
                      {/* The queue this issue moved, which is the whole of why
                          it went to this person rather than another. */}
                      <span className="prio-text-muted">
                        {" "}
                        {row.workloadBefore} → {row.workloadAfter}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>

              <p className="prio-hint">
                {plan.totals
                  .map((person) => `${person.name} +${person.added}`)
                  .join(" · ")}
              </p>
            </>
          ) : (
            <p className="prio-text-muted">
              Nothing in this project&rsquo;s backlog is waiting for a
              developer, or nobody on the project does development work.
            </p>
          )}
        </Dialog>
      ) : null}
    </>
  );
}
