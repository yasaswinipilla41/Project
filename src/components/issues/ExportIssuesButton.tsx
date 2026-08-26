"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/primitives";
import { IconDownload } from "@/components/ui/Icon";
import { useToast } from "@/components/ui/Toast";

/**
 * "Export to Excel" for the issue sheet.
 *
 * Carries the page's own query string straight through to the export route,
 * so what downloads is exactly the filtered set on screen — there is no second
 * notion of "what is being exported". The route re-derives the caller and
 * re-applies project scope regardless of what arrives here, so a tampered
 * query string can only ever narrow the result.
 *
 * The response is fetched rather than linked so a failure can be reported in
 * place instead of navigating the person to a JSON error page.
 */
export function ExportIssuesButton({ disabled }: { disabled?: boolean }) {
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  async function exportSheet() {
    setBusy(true);
    let url: string | null = null;

    try {
      const query = searchParams.toString();
      const response = await fetch(
        `/api/issues/export${query ? `?${query}` : ""}`,
      );

      if (!response.ok) {
        toast(
          response.status === 401
            ? "Your session has expired. Sign in again to export."
            : "Could not generate the export. Please try again.",
          "error",
        );
        return;
      }

      const blob = await response.blob();
      const name =
        /filename="([^"]+)"/.exec(
          response.headers.get("content-disposition") ?? "",
        )?.[1] ?? "prio-issues.xlsx";

      url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      document.body.append(link);
      link.click();
      link.remove();

      const count = response.headers.get("x-prio-export-rows");
      toast(
        count
          ? `Exported ${count} ${count === "1" ? "issue" : "issues"}.`
          : "Export downloaded.",
      );
    } catch {
      toast("Could not generate the export. Please try again.", "error");
    } finally {
      // Freed later, not synchronously: revoking immediately can cancel the
      // download in some browsers before they have finished reading the blob.
      const created = url;
      if (created) {
        window.setTimeout(() => URL.revokeObjectURL(created), 10_000);
      }
      setBusy(false);
    }
  }

  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={exportSheet}
      loading={busy}
      disabled={disabled || busy}
      title="Export to Excel"
    >
      <IconDownload size={13} />
      Export
    </Button>
  );
}
