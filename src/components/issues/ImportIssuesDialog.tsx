"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Dialog } from "@/components/ui/Dialog";
import { Alert, Button } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/Toast";
import { IconWarning } from "@/components/ui/Icon";
import { importWorkItems, type ImportProblem } from "@/server/issueImport";

/**
 * Bringing work items in from a spreadsheet.
 *
 * Deliberately plain: a file, a button, and — when the file is not right — a
 * list of what to correct. The interesting design is on the server, which
 * validates every row before it writes any of them, so this never has to
 * report a half-finished import.
 *
 * The errors are shown in full rather than summarised. "Import failed" sends
 * somebody back to a spreadsheet with nothing to look for; "Row 7: Unknown
 * priority" sends them to row 7.
 */
export function ImportIssuesDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [problems, setProblems] = useState<ImportProblem[]>([]);

  async function submit() {
    if (!file) return;

    setBusy(true);
    setError(null);
    setProblems([]);

    const body = new FormData();
    body.set("file", file);

    const result = await importWorkItems(body);
    setBusy(false);

    if (!result.ok) {
      setError(result.error);
      setProblems(result.problems ?? []);
      return;
    }

    onClose();
    toast(
      `${result.created} work item${result.created === 1 ? "" : "s"} imported`,
    );
    /* The list is server-rendered, so the server has to draw it again. */
    router.refresh();
  }

  return (
    <Dialog
      open
      onClose={onClose}
      busy={busy}
      title="Import work items"
      description="An .xlsx spreadsheet — the same shape Export produces."
      footer={
        <>
          <span className="prio-dialog__footer-note">
            Nothing is created until every row is valid.
          </span>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="brand"
            onClick={() => void submit()}
            loading={busy}
            disabled={!file}
          >
            Import
          </Button>
        </>
      }
    >
      {error ? (
        <div style={{ marginBottom: "var(--prio-space-4)" }}>
          <Alert tone="danger" icon={<IconWarning />}>
            {error}
          </Alert>
        </div>
      ) : null}

      <div className="prio-field">
        <label className="prio-label" htmlFor="import-file">
          Spreadsheet
        </label>
        <input
          id="import-file"
          ref={inputRef}
          type="file"
          className="prio-input"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            setError(null);
            setProblems([]);
          }}
        />
        <span className="prio-hint">
          Needs a <strong>Title</strong> and a <strong>Project key</strong>
          {" "}column. Type, Status, Priority, Assignee, Labels, Due date and
          Description are used when present.
        </span>
      </div>

      {problems.length > 0 ? (
        <div className="prio-field">
          <span className="prio-label">What to correct</span>
          <ul className="prio-importproblems">
            {problems.map((problem, index) => (
              <li key={`${problem.row}-${index}`}>
                <strong>Row {problem.row}</strong>
                {problem.column ? ` · ${problem.column}` : null} —{" "}
                {problem.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Dialog>
  );
}
