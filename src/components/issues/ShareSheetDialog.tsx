"use client";

import { useEffect, useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { Alert, Avatar, Button } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/Toast";
import { IconClose, IconLink, IconWarning } from "@/components/ui/Icon";
import {
  addShareMember,
  getShareInfo,
  removeShareMember,
  type ShareCandidate,
  type ShareInfo,
  type ShareMemberInfo,
} from "@/server/shares";

/**
 * Share Issue Sheet dialog (§ Share Issue Sheet).
 *
 * Any signed-in user can open this to see who has access and copy the link.
 * Only an administrator sees the search-and-add picker and the remove
 * buttons — everyone else gets a read-only member list, which is what keeps
 * "Only users with the required permissions can ... manage sharing" true on
 * the client as well as on the server (the actions re-check on every call
 * regardless of what this dialog renders).
 */
export function ShareSheetDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [data, setData] = useState<ShareInfo | null>(null);
  const [query, setQuery] = useState("");
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    getShareInfo().then((result) => {
      if (cancelled) return;
      setLoading(false);
      if (!result.ok) {
        setLoadError(result.error);
        return;
      }
      setData(result.data);
    });

    return () => {
      cancelled = true;
    };
  }, [open]);

  /** Resets transient state so the next time this dialog opens starts fresh. */
  function handleClose() {
    onClose();
    setLoading(true);
    setLoadError(null);
    setData(null);
    setQuery("");
    setPickedId(null);
    setCopied(false);
  }

  async function handleShare() {
    if (!pickedId || adding) return;
    setAdding(true);

    const result = await addShareMember({ userId: pickedId, permission: "VIEW" });

    setAdding(false);

    if (!result.ok) {
      toast(result.error, "error");
      return;
    }

    setData((prev) =>
      prev
        ? {
            ...prev,
            exists: true,
            members: [...prev.members, result.data],
            candidates: prev.candidates.filter((c) => c.id !== pickedId),
          }
        : prev,
    );
    setPickedId(null);
    setQuery("");
    toast(
      <>
        Shared with <strong>{result.data.name}</strong>.
      </>,
    );

    if (!data?.url) {
      // First member ever added: the share now exists — fetch its link.
      const refreshed = await getShareInfo();
      if (refreshed.ok) setData(refreshed.data);
    }
  }

  async function handleRemove(member: ShareMemberInfo) {
    if (removingId) return;
    setRemovingId(member.id);

    const result = await removeShareMember({ memberId: member.id });

    setRemovingId(null);

    if (!result.ok) {
      toast(result.error, "error");
      return;
    }

    setData((prev) => {
      if (!prev) return prev;
      const restored: ShareCandidate = {
        id: member.userId,
        name: member.name,
        email: member.email,
        image: member.image,
        jobTitle: member.jobTitle,
      };
      return {
        ...prev,
        members: prev.members.filter((m) => m.id !== member.id),
        candidates: [...prev.candidates, restored].sort((a, b) =>
          a.name.localeCompare(b.name),
        ),
      };
    });
    toast(`Removed ${member.name}'s access.`);
  }

  async function handleCopyLink() {
    if (!data?.url) return;
    try {
      await navigator.clipboard.writeText(data.url);
      setCopied(true);
      toast("Link copied to clipboard.");
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      toast("Could not copy the link. Copy it manually instead.", "error");
    }
  }

  const filteredCandidates = (data?.candidates ?? []).filter((c) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return (
      c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q)
    );
  });

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      title="Share Issue Sheet"
      description="Grant organization members view access to the live Issues Sheet."
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={handleClose}>
            Close
          </Button>
          <Button
            variant="brand"
            onClick={handleCopyLink}
            disabled={!data?.url}
          >
            <IconLink size={14} />
            {copied ? "Copied!" : "Copy link"}
          </Button>
        </>
      }
    >
      {loading ? (
        <p className="prio-hint">Loading…</p>
      ) : loadError ? (
        <Alert tone="danger" icon={<IconWarning />}>
          {loadError}
        </Alert>
      ) : data ? (
        <div className="prio-share">
          {!data.url ? (
            <p className="prio-hint" style={{ marginBottom: "var(--prio-space-4)" }}>
              {data.isAdmin
                ? "This sheet hasn't been shared yet. Add someone below to create the link."
                : "This sheet hasn't been shared yet. Ask an administrator to share it."}
            </p>
          ) : null}

          <div className="prio-field">
            <span className="prio-label">People with access</span>
            {data.members.length === 0 ? (
              <p className="prio-hint">Nobody has been given access yet.</p>
            ) : (
              <ul className="prio-share__members">
                {data.members.map((member) => (
                  <li key={member.id} className="prio-share__member">
                    <Avatar name={member.name} image={member.image} size="sm" />
                    <span className="prio-share__member-text">
                      <span className="prio-share__member-name">
                        {member.name}
                      </span>
                      <span className="prio-text-muted">{member.email}</span>
                    </span>
                    <span className="prio-share__permission">Can view</span>
                    {data.isAdmin ? (
                      <button
                        type="button"
                        className="prio-btn prio-btn--ghost prio-btn--icon prio-btn--sm"
                        onClick={() => handleRemove(member)}
                        disabled={removingId === member.id}
                        aria-label={`Remove ${member.name}'s access`}
                      >
                        <IconClose size={13} />
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {data.isAdmin ? (
            <div className="prio-field">
              <label className="prio-label" htmlFor="share-search">
                Add a member
              </label>
              <input
                id="share-search"
                className="prio-input"
                placeholder="Search by name or email…"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPickedId(null);
                }}
              />
              {query.trim() ? (
                <div className="prio-share__results" role="listbox">
                  {filteredCandidates.length === 0 ? (
                    <p className="prio-hint">No matching member.</p>
                  ) : (
                    filteredCandidates.slice(0, 6).map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        role="option"
                        aria-selected={pickedId === c.id}
                        className="prio-share__result"
                        data-selected={pickedId === c.id}
                        onClick={() => setPickedId(c.id)}
                      >
                        <Avatar name={c.name} image={c.image} size="sm" />
                        <span className="prio-share__member-text">
                          <span className="prio-share__member-name">{c.name}</span>
                          <span className="prio-text-muted">{c.email}</span>
                        </span>
                      </button>
                    ))
                  )}
                </div>
              ) : null}

              <div className="prio-share__grant">
                <span className="prio-hint">Permission: Can view</span>
                <Button
                  variant="brand"
                  size="sm"
                  onClick={handleShare}
                  disabled={!pickedId}
                  loading={adding}
                >
                  {adding ? "Sharing…" : "Share"}
                </Button>
              </div>
            </div>
          ) : (
            <p className="prio-hint">
              Only an administrator can add or remove members.
            </p>
          )}
        </div>
      ) : null}
    </Dialog>
  );
}
