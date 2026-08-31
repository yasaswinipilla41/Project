"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Avatar, Button } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/Dialog";
import { useToast } from "@/components/ui/Toast";
import { IconUsers } from "@/components/ui/Icon";
import { formatRelative } from "@/lib/format";
import { decideProjectAccess, requestProjectAccess } from "@/server/access";

export interface AccessCandidate {
  id: string;
  name: string;
  email: string;
  image: string | null;
  jobTitle: string | null;
}

export interface PendingAccessRequest {
  id: string;
  createdAt: Date;
  message: string | null;
  requester: { name: string; image: string | null };
  subject: { name: string; email: string; image: string | null };
}

/**
 * Sharing a project, from both ends.
 *
 * A member who wants to bring somebody onto their project cannot add them —
 * membership is an administrator's action. Rather than hiding the intent or
 * failing silently, Share raises a request an administrator answers here, on
 * the same page. Nothing is granted by asking.
 *
 * The people a member may name are the people they can already see: colleagues
 * who share a project with them. The full directory is never exposed here, so
 * this cannot become a way to enumerate the organisation.
 */
export function ProjectAccess({
  projectId,
  projectName,
  isAdmin,
  candidates,
  pending,
}: {
  projectId: string;
  projectName: string;
  isAdmin: boolean;
  candidates: AccessCandidate[];
  pending: PendingAccessRequest[];
}) {
  const router = useRouter();
  const { toast } = useToast();

  const [sharing, setSharing] = useState(false);
  const [query, setQuery] = useState("");
  const [subjectId, setSubjectId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [decidingId, setDecidingId] = useState<string | null>(null);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter(
      (person) =>
        person.name.toLowerCase().includes(q) ||
        person.email.toLowerCase().includes(q),
    );
  }, [candidates, query]);

  async function submit() {
    if (!subjectId) return;
    setBusy(true);
    const result = await requestProjectAccess({
      projectId,
      subjectId,
      message: message.trim() || undefined,
    });
    setBusy(false);

    if (!result.ok) {
      toast(result.error, "error");
      return;
    }

    toast("Request sent to an administrator");
    setSharing(false);
    setSubjectId(null);
    setMessage("");
    router.refresh();
  }

  async function decide(requestId: string, approve: boolean) {
    setDecidingId(requestId);
    const result = await decideProjectAccess({ requestId, approve });
    setDecidingId(null);

    if (!result.ok) {
      toast(result.error, "error");
      return;
    }

    toast(approve ? "Access granted" : "Request declined");
    router.refresh();
  }

  return (
    <>
      {/* An administrator does not ask — they use Add members above. */}
      {!isAdmin ? (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => {
            setQuery("");
            setSubjectId(null);
            setMessage("");
            setSharing(true);
          }}
        >
          <IconUsers size={14} />
          Share
        </Button>
      ) : null}

      {isAdmin && pending.length > 0 ? (
        <div className="prio-accessreq">
          <h3 className="prio-accessreq__title">
            Access requests · {pending.length}
          </h3>
          {pending.map((request) => (
            <div key={request.id} className="prio-accessreq__row">
              <Avatar
                name={request.subject.name}
                image={request.subject.image}
                size="md"
              />
              <span className="prio-accessreq__text">
                <span className="prio-accessreq__who">
                  {request.subject.name}
                </span>
                <span className="prio-accessreq__meta">
                  Asked by {request.requester.name} ·{" "}
                  {formatRelative(request.createdAt)}
                </span>
                {request.message ? (
                  <span className="prio-accessreq__note">
                    “{request.message}”
                  </span>
                ) : null}
              </span>
              <span className="prio-accessreq__actions">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={decidingId === request.id}
                  onClick={() => decide(request.id, true)}
                >
                  Approve
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={decidingId === request.id}
                  onClick={() => decide(request.id, false)}
                >
                  Reject
                </Button>
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {sharing ? (
        <Dialog
          open
          onClose={() => setSharing(false)}
          busy={busy}
          title={`Share ${projectName}`}
          description="Adding someone to a project is an administrator's decision, so this sends them a request. Nobody gains access until it is approved."
          footer={
            <>
              <Button
                variant="ghost"
                onClick={() => setSharing(false)}
                disabled={busy}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={submit}
                loading={busy}
                disabled={!subjectId || busy}
              >
                Send request
              </Button>
            </>
          }
        >
          <div className="prio-field">
            <label className="prio-label" htmlFor="share-search">
              Who needs access?
            </label>
            <input
              id="share-search"
              type="search"
              className="prio-input"
              placeholder="Name or email"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>

          {candidates.length === 0 ? (
            <p className="prio-text-muted">
              Everyone you work with already has access to this project.
            </p>
          ) : matches.length === 0 ? (
            <p className="prio-text-muted">Nobody matches “{query}”.</p>
          ) : (
            <div className="prio-memberpicker">
              {matches.map((person) => (
                <label
                  key={person.id}
                  className="prio-memberrow"
                  data-selected={subjectId === person.id || undefined}
                >
                  <input
                    type="radio"
                    name="share-subject"
                    checked={subjectId === person.id}
                    onChange={() => setSubjectId(person.id)}
                  />
                  <Avatar name={person.name} image={person.image} size="md" />
                  <span className="prio-memberpicker__text">
                    <span className="prio-memberpicker__name">
                      {person.name}
                    </span>
                    <span className="prio-memberpicker__meta">
                      {person.jobTitle ?? person.email}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          )}

          <div className="prio-field">
            <label className="prio-label" htmlFor="share-message">
              Why (optional)
            </label>
            <textarea
              id="share-message"
              className="prio-input prio-textarea"
              rows={3}
              maxLength={500}
              placeholder="They are joining the QA rotation this sprint."
              value={message}
              onChange={(event) => setMessage(event.target.value)}
            />
          </div>
        </Dialog>
      ) : null}
    </>
  );
}
