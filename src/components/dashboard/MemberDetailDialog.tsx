"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Avatar, Button } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/Dialog";
import {
  IssueKey,
  IssueTypeIcon,
  PriorityIndicator,
  SeverityChip,
  StatusPill,
} from "@/components/ui/Indicators";
import { IconUser } from "@/components/ui/Icon";
import { useToast } from "@/components/ui/Toast";
import { ROLE_LABEL } from "@/lib/domain";
import { formatDateCompact, formatRelative, humanizeActivity } from "@/lib/format";
import { getMemberDetail } from "@/server/users";
import { updateIssue } from "@/server/issues";
import type { MemberDetail, MemberDetailIssue } from "@/server/queries/memberDetail";

/**
 * Admin Portal → New Members → View details.
 *
 * Fetched lazily on open through the existing `getMemberDetail` action, and
 * assignment goes through the same `updateIssue` Server Action the issue
 * detail page already uses — there is no second assignment path here, just
 * another place that calls the one that exists.
 */

function IssueCard({ issue }: { issue: MemberDetailIssue }) {
  return (
    <div className="prio-memberdetail__issue">
      <Link
        href={`/issues/${issue.key.toLowerCase()}`}
        className="prio-issuelink"
      >
        <IssueTypeIcon type={issue.type} size={16} />
        <IssueKey issueKey={issue.key} />
        <span className="prio-truncate">{issue.title}</span>
      </Link>
      <span className="prio-memberdetail__issue-meta">
        <span className="prio-text-muted">{issue.project.name}</span>
        <StatusPill status={issue.status} />
        <PriorityIndicator priority={issue.priority} />
        {issue.severity ? <SeverityChip severity={issue.severity} /> : null}
        {issue.dueDate ? (
          <span className="prio-text-muted">
            Due {formatDateCompact(issue.dueDate)}
          </span>
        ) : null}
      </span>
    </div>
  );
}

export function MemberDetailButton({
  memberId,
  memberName,
  canAssign = false,
}: {
  memberId: string;
  memberName: string;
  /**
   * Whether the viewer may hand this person work. Deciding who does a piece of
   * work is an administrator's, so for everybody else the dialog is what it
   * already was — who they are, what they are holding, what they have done —
   * without a control that the server would only refuse. `updateIssue` makes
   * that refusal itself; this just stops offering the button first.
   */
  canAssign?: boolean;
}) {
  const router = useRouter();
  const { toast } = useToast();

  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [detail, setDetail] = useState<MemberDetail | null>(null);
  const [assigningId, setAssigningId] = useState<string | null>(null);
  const [pickedIssueId, setPickedIssueId] = useState("");

  async function openDialog() {
    setOpen(true);
    setLoading(true);
    const result = await getMemberDetail(memberId);
    setLoading(false);

    if (!result.ok) {
      toast(result.error, "error");
      setOpen(false);
      return;
    }
    setDetail(result.data);
  }

  async function assign() {
    if (!pickedIssueId) return;
    setAssigningId(pickedIssueId);

    const result = await updateIssue({
      issueId: pickedIssueId,
      assigneeId: memberId,
    });

    setAssigningId(null);

    if (!result.ok) {
      toast(result.error, "error");
      return;
    }

    toast(`Assigned to ${memberName}`);
    setPickedIssueId("");
    // Re-fetch so the assigned/assignable lists in this dialog move the item
    // over immediately, and refresh so the member's own dashboard (if this
    // admin later signs in as them, or the org workload panel) is current.
    const refreshed = await getMemberDetail(memberId);
    if (refreshed.ok) setDetail(refreshed.data);
    router.refresh();
  }

  return (
    <>
      <button
        type="button"
        className="prio-btn prio-btn--ghost prio-btn--icon prio-btn--sm"
        aria-label={`View details for ${memberName}`}
        title="View details"
        onClick={openDialog}
      >
        <IconUser size={15} />
      </button>

      {open ? (
        <Dialog
          open
          onClose={() => setOpen(false)}
          title={detail ? detail.name : memberName}
          description={detail ? detail.email : undefined}
          size="lg"
        >
          {loading || !detail ? (
            <p className="prio-text-muted">Loading…</p>
          ) : (
            <div className="prio-memberdetail">
              <section className="prio-memberdetail__section">
                <div className="prio-memberdetail__profile">
                  <Avatar name={detail.name} image={detail.image} size="lg" />
                  <div>
                    <p className="prio-memberdetail__row">
                      <strong>Role</strong> {ROLE_LABEL[detail.role]}
                    </p>
                    <p className="prio-memberdetail__row">
                      <strong>Status</strong>{" "}
                      {detail.isActive ? "Active" : "Deactivated"}
                    </p>
                    <p className="prio-memberdetail__row">
                      <strong>Joined</strong> {formatRelative(detail.createdAt)}
                    </p>
                    {detail.jobTitle ? (
                      <p className="prio-memberdetail__row">
                        <strong>Title</strong> {detail.jobTitle}
                      </p>
                    ) : null}
                  </div>
                </div>
              </section>

              <section className="prio-memberdetail__section">
                <h3 className="prio-memberdetail__heading">
                  Projects ({detail.projects.length})
                </h3>
                {detail.projects.length === 0 ? (
                  <p className="prio-text-muted">Not a member of any project yet.</p>
                ) : (
                  <div className="prio-chipset" role="list">
                    {detail.projects.map((project) => (
                      <Link
                        key={project.id}
                        href={`/projects/${project.key.toLowerCase()}/welcome`}
                        className="prio-chipset__chip"
                        role="listitem"
                      >
                        {project.name}
                      </Link>
                    ))}
                  </div>
                )}
              </section>

              <section className="prio-memberdetail__section">
                <h3 className="prio-memberdetail__heading">
                  Assigned work ({detail.assignedIssues.length})
                </h3>
                {detail.assignedIssues.length === 0 ? (
                  <p className="prio-text-muted">Nothing assigned right now.</p>
                ) : (
                  <div className="prio-memberdetail__issuelist">
                    {detail.assignedIssues.map((issue) => (
                      <IssueCard key={issue.id} issue={issue} />
                    ))}
                  </div>
                )}
              </section>

              {canAssign ? (
              <section className="prio-memberdetail__section">
                <h3 className="prio-memberdetail__heading">Assign task / bug</h3>
                {detail.assignableIssues.length === 0 ? (
                  <p className="prio-text-muted">
                    No open, unassigned-to-them issues in {memberName.split(" ")[0]}
                    &rsquo;s projects right now.
                  </p>
                ) : (
                  <div className="prio-memberdetail__assign">
                    <select
                      className="prio-select"
                      value={pickedIssueId}
                      onChange={(e) => setPickedIssueId(e.target.value)}
                      aria-label="Choose an issue to assign"
                    >
                      <option value="">Choose an issue…</option>
                      {detail.assignableIssues.map((issue) => (
                        <option key={issue.id} value={issue.id}>
                          {issue.key} · {issue.title} ({issue.project.name})
                        </option>
                      ))}
                    </select>
                    <Button
                      type="button"
                      variant="primary"
                      size="sm"
                      disabled={!pickedIssueId}
                      loading={assigningId !== null}
                      onClick={assign}
                    >
                      Assign
                    </Button>
                  </div>
                )}
              </section>
              ) : null}

              <section className="prio-memberdetail__section">
                <h3 className="prio-memberdetail__heading">Recent activity</h3>
                {detail.recentActivity.length === 0 ? (
                  <p className="prio-text-muted">No recorded activity yet.</p>
                ) : (
                  <ul className="prio-memberdetail__activity">
                    {detail.recentActivity.map((entry) => (
                      <li key={entry.id}>
                        {humanizeActivity(entry.action, entry.field)}{" "}
                        <Link href={`/issues/${entry.issue.key.toLowerCase()}`}>
                          {entry.issue.key}
                        </Link>{" "}
                        <span className="prio-text-muted">
                          {formatRelative(entry.createdAt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          )}
        </Dialog>
      ) : null}
    </>
  );
}
