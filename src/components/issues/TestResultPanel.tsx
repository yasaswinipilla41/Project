"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/primitives";
import { useToast } from "@/components/ui/Toast";
import {
  TEST_RESULTS,
  TEST_RESULT_DESCRIPTION,
  TEST_RESULT_LABEL,
} from "@/lib/domain";
import { formatDateTime } from "@/lib/format";
import { recordTestResult } from "@/server/qa";
import type { IssueStatus, TestResult } from "@prisma/client";

/**
 * The testing panel: development state on the left, QA verdict on the right.
 *
 * Compact on purpose (§8) — it reports two facts and offers four buttons.
 * Everything discursive about a test run stays in the comment thread below it,
 * which is where the screenshots and logs already live.
 *
 * The verdict buttons are hidden from the assignee, because signing off your
 * own work is what QA exists to prevent — but `recordTestResult` refuses it on
 * the server too, so this is the courtesy, not the control.
 */
export function TestResultPanel({
  issueId,
  status,
  testResult,
  testedBy,
  testedAt,
  reporterId,
  currentUserId,
}: {
  issueId: string;
  status: IssueStatus;
  testResult: TestResult;
  testedBy: { name: string } | null;
  testedAt: Date | null;
  reporterId: string;
  currentUserId: string;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [saving, setSaving] = useState<TestResult | null>(null);
  const [pending, startTransition] = useTransition();

  /* The verdict belongs to whoever raised the issue — the same rule the
     server enforces, so the controls never offer a call it would refuse. */
  const isReporter = reporterId === currentUserId;

  const development =
    status === "DONE"
      ? "Completed"
      : status === "IN_REVIEW"
        ? "Ready for QA"
        : status === "IN_QA"
          ? "In QA"
          : status === "CANCELLED"
            ? "Cancelled"
            : "In progress";

  async function record(result: TestResult) {
    setSaving(result);
    const outcome = await recordTestResult({ issueId, result });
    setSaving(null);

    if (!outcome.ok) {
      toast(outcome.error, "error");
      return;
    }

    toast(`Marked ${TEST_RESULT_LABEL[result].toLowerCase()}`);
    startTransition(() => router.refresh());
  }

  return (
    <div className="prio-qa">
      <div className="prio-qa__facts">
        <div className="prio-qa__fact">
          <dt>Development</dt>
          <dd>{development}</dd>
        </div>
        <div className="prio-qa__fact">
          <dt>Testing</dt>
          <dd>
            <span className="prio-testresult" data-result={testResult}>
              {TEST_RESULT_LABEL[testResult]}
            </span>
          </dd>
        </div>
        {testedBy ? (
          <div className="prio-qa__fact">
            <dt>Tested by</dt>
            <dd>{testedBy.name}</dd>
          </div>
        ) : null}
        {testedAt ? (
          <div className="prio-qa__fact">
            <dt>Last result</dt>
            <dd>{formatDateTime(testedAt)}</dd>
          </div>
        ) : null}
      </div>

      {!isReporter ? (
        <p className="prio-hint">
          The person who raised this issue records the test result. Use
          <strong> Submit for review</strong> when your work is ready, and add
          a comment if they need context.
        </p>
      ) : (
        <div className="prio-qa__actions" role="group" aria-label="Test result">
          {TEST_RESULTS.map((result) => (
            <Button
              key={result}
              variant={result === testResult ? "primary" : "secondary"}
              size="sm"
              disabled={saving !== null || pending}
              loading={saving === result}
              onClick={() => record(result)}
              title={TEST_RESULT_DESCRIPTION[result]}
            >
              {TEST_RESULT_LABEL[result]}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
