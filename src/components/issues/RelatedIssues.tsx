"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { IssueLinkType, IssueStatus, IssueType } from "@prisma/client";
import { Button } from "@/components/ui/primitives";
import { Dialog } from "@/components/ui/Dialog";
import { useToast } from "@/components/ui/Toast";
import { IssueKey, IssueTypeIcon, StatusPill } from "@/components/ui/Indicators";
import { IconClose, IconLink, IconPlus } from "@/components/ui/Icon";
import { LINK_LABEL, LINK_ORDER, LINK_TYPES } from "@/lib/issue-links";
import {
  createIssueLink,
  removeIssueLink,
  searchLinkableIssues,
} from "@/server/links";

/**
 * Relationships to other issues — blocks, duplicates, relates to.
 *
 * Separate from the parent/child hierarchy, which expresses containment. These
 * express dependency and identity, and unlike a parent an issue can have as
 * many of them as it needs.
 *
 * The search box only ever offers issues the viewer can already open: the
 * lookup runs on the server inside their own scope, so it cannot be used to
 * find out what exists in a project they have no access to.
 */

export interface RelatedIssueView {
  linkId: string;
  type: IssueLinkType;
  issue: {
    key: string;
    title: string;
    type: IssueType;
    status: IssueStatus;
  };
}

export function RelatedIssues({
  issueId,
  links,
}: {
  issueId: string;
  links: RelatedIssueView[];
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  const grouped = LINK_ORDER.map((type) => ({
    type,
    items: links.filter((link) => link.type === type),
  })).filter((group) => group.items.length > 0);

  async function unlink(linkId: string) {
    setRemoving(linkId);
    const result = await removeIssueLink(linkId);
    setRemoving(null);

    if (!result.ok) {
      toast(<>{result.error}</>);
      return;
    }
    toast(<>Link removed</>);
    router.refresh();
  }

  return (
    <section className="prio-issue__section">
      <div className="prio-related__head">
        <h2 className="prio-issue__section-title">
          <IconLink size={14} />
          Related issues
        </h2>
        <Button variant="ghost" size="sm" onClick={() => setAdding(true)}>
          <IconPlus size={13} />
          Link issue
        </Button>
      </div>

      {grouped.length === 0 ? (
        <p className="prio-text-muted" style={{ fontSize: "var(--prio-text-sm)" }}>
          No related issues yet. Link one to record that it blocks this work,
          duplicates it, or is simply worth reading alongside it.
        </p>
      ) : (
        <div className="prio-related">
          {grouped.map((group) => (
            <div key={group.type} className="prio-related__group">
              <h3 className="prio-related__label">{LINK_LABEL[group.type]}</h3>
              <ul className="prio-related__list">
                {group.items.map((link) => (
                  <li key={link.linkId} className="prio-related__item">
                    <Link
                      href={`/issues/${link.issue.key.toLowerCase()}`}
                      className="prio-relatedrow"
                    >
                      <IssueTypeIcon type={link.issue.type} size={16} />
                      <IssueKey issueKey={link.issue.key} />
                      <span className="prio-relatedrow__title prio-truncate">
                        {link.issue.title}
                      </span>
                      <StatusPill status={link.issue.status} />
                    </Link>
                    <button
                      type="button"
                      className="prio-related__remove"
                      aria-label={`Remove link to ${link.issue.key}`}
                      disabled={removing === link.linkId}
                      onClick={() => void unlink(link.linkId)}
                    >
                      <IconClose size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {adding ? (
        <LinkDialog issueId={issueId} onClose={() => setAdding(false)} />
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------- dialog */

interface Candidate {
  id: string;
  key: string;
  title: string;
  type: string;
}

function LinkDialog({
  issueId,
  onClose,
}: {
  issueId: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const { toast } = useToast();

  const [type, setType] = useState<IssueLinkType>("RELATES_TO");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Candidate[]>([]);
  const [chosen, setChosen] = useState<Candidate | null>(null);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function search(term: string) {
    setQuery(term);
    setChosen(null);
    setError(null);

    if (term.trim().length < 2) {
      setResults([]);
      return;
    }

    setSearching(true);
    const result = await searchLinkableIssues(issueId, term);
    setSearching(false);

    if (result.ok) setResults(result.data);
  }

  async function save() {
    if (!chosen) return;

    setSaving(true);
    setError(null);

    const result = await createIssueLink({
      issueId,
      targetKey: chosen.key,
      type,
    });

    setSaving(false);

    if (!result.ok) {
      setError(result.error);
      return;
    }

    onClose();
    toast(
      <>
        Linked — this issue {LINK_LABEL[type]} <strong>{result.data.targetKey}</strong>
      </>,
    );
    router.refresh();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      busy={saving}
      title="Link an issue"
      description="Record how this issue relates to another one."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="brand"
            onClick={() => void save()}
            loading={saving}
            disabled={!chosen}
          >
            {saving ? "Linking…" : "Link issue"}
          </Button>
        </>
      }
    >
      {error ? (
        <p className="prio-error" role="alert" style={{ marginBottom: "var(--prio-space-4)" }}>
          {error}
        </p>
      ) : null}

      <div className="prio-field">
        <label className="prio-label" htmlFor="link-type">
          This issue
        </label>
        <select
          id="link-type"
          className="prio-select"
          value={type}
          onChange={(event) => setType(event.target.value as IssueLinkType)}
        >
          {LINK_TYPES.map((option) => (
            <option key={option} value={option}>
              {LINK_LABEL[option]}
            </option>
          ))}
        </select>
      </div>

      <div className="prio-field">
        <label className="prio-label" htmlFor="link-search">
          Which issue?
        </label>
        <input
          id="link-search"
          className="prio-input"
          value={query}
          onChange={(event) => void search(event.target.value)}
          placeholder="Search by key or title, e.g. ENG-12"
          autoComplete="off"
          autoFocus
        />
        <span className="prio-hint">
          {chosen
            ? `Selected ${chosen.key} — ${chosen.title}`
            : searching
              ? "Searching…"
              : "Only issues you can open are listed."}
        </span>
      </div>

      {results.length > 0 ? (
        <ul className="prio-linkresults" role="listbox" aria-label="Matching issues">
          {results.map((candidate) => (
            <li key={candidate.id}>
              <button
                type="button"
                role="option"
                aria-selected={chosen?.id === candidate.id}
                className="prio-linkresults__item"
                data-active={chosen?.id === candidate.id || undefined}
                onClick={() => setChosen(candidate)}
              >
                <IssueKey issueKey={candidate.key} />
                <span className="prio-truncate">{candidate.title}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {query.trim().length >= 2 && !searching && results.length === 0 ? (
        <p className="prio-text-muted" style={{ fontSize: "var(--prio-text-sm)" }}>
          No issues you can open match “{query}”.
        </p>
      ) : null}
    </Dialog>
  );
}
