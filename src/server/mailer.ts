import nodemailer, { type Transporter } from "nodemailer";
import { getEnv, isEmailConfigured } from "@/lib/env";

/**
 * Outbound email.
 *
 * One place builds messages and one place sends them, so no caller ever has a
 * transport or a template of its own. Two rules hold throughout:
 *
 *  - **Delivery never breaks the request.** Sending is fire-and-forget and
 *    failures are logged. A mail server being down must not stop somebody
 *    posting a comment.
 *  - **A message says only what its recipient may already see.** Callers pass
 *    recipients they have already authorized; nothing here widens that.
 *
 * With no `SMTP_HOST` configured the module logs and no-ops, which is what a
 * developer running without Mailpit gets.
 */

export interface IssueMailContext {
  issueKey: string;
  issueTitle: string;
  projectName: string;
  actorName: string;
  /** One line describing what happened, e.g. "changed the status to Done". */
  event: string;
  /** Optional quoted body — a comment, for instance. */
  excerpt?: string | null;
}

let transport: Transporter | null = null;

function getTransport(): Transporter | null {
  if (!isEmailConfigured()) return null;
  if (transport) return transport;

  const env = getEnv();
  transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth:
      env.SMTP_USERNAME && env.SMTP_PASSWORD
        ? { user: env.SMTP_USERNAME, pass: env.SMTP_PASSWORD }
        : undefined,
  });

  return transport;
}

/** Test seam. Passing null restores the configured transport. */
export function setMailTransport(next: Transporter | null): void {
  transport = next;
}

/* ------------------------------------------------------------- escaping */

/**
 * Escapes text for the HTML body.
 *
 * The application's own pages never build HTML from strings — but an email
 * body is HTML built from strings by necessity, so every interpolated value
 * goes through here. An issue title containing `<script>` arrives as visible
 * characters in the reader's mail client, not as markup.
 */
function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ------------------------------------------------------------- template */

function issueUrl(issueKey: string): string {
  const base = getEnv().BASE_URL.replace(/\/+$/, "");
  return `${base}/issues/${issueKey.toLowerCase()}`;
}

/**
 * One template for every issue notification.
 *
 * Inline styles only: mail clients strip `<style>` blocks and none of them
 * support CSS variables, so Prio's palette is written out literally here. The
 * colours are the brand-primary and accent purples from `tokens.css`, kept in
 * step by hand since a mail client cannot read the token file.
 */
function renderIssueEmail(context: IssueMailContext): {
  subject: string;
  text: string;
  html: string;
} {
  const url = issueUrl(context.issueKey);
  const subject = `[${context.issueKey}] ${context.issueTitle}`;

  const text = [
    `${context.actorName} ${context.event}`,
    "",
    `${context.issueKey} — ${context.issueTitle}`,
    `Project: ${context.projectName}`,
    context.excerpt ? `\n"${context.excerpt}"\n` : "",
    `Open it: ${url}`,
    "",
    "— Prio, Symbiosys Technologies",
  ]
    .filter((line) => line !== "")
    .join("\n");

  const html = `
<div style="margin:0;padding:24px;background:#f6f8fb;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e7ef;border-radius:14px;overflow:hidden;">
    <div style="padding:18px 24px;background:linear-gradient(135deg,#5b2c83 0%,#8b5cf6 100%);">
      <span style="font-size:17px;font-weight:700;color:#ffffff;letter-spacing:-0.02em;">Prio</span>
    </div>
    <div style="padding:24px;">
      <p style="margin:0 0 16px;font-size:14px;color:#506078;">
        <strong style="color:#1e293b;">${esc(context.actorName)}</strong> ${esc(context.event)}
      </p>
      <p style="margin:0 0 6px;">
        <span style="display:inline-block;padding:2px 8px;border-radius:999px;background:#ccccff;color:#47215f;font-size:12px;font-weight:600;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${esc(context.issueKey)}</span>
      </p>
      <p style="margin:0 0 4px;font-size:18px;font-weight:600;color:#1e293b;line-height:1.35;">${esc(context.issueTitle)}</p>
      <p style="margin:0 0 20px;font-size:13px;color:#6b7c98;">${esc(context.projectName)}</p>
      ${
        context.excerpt
          ? `<blockquote style="margin:0 0 20px;padding:12px 16px;border-left:3px solid #e2e7ef;background:#f6f8fb;border-radius:0 8px 8px 0;font-size:14px;color:#3b4a60;white-space:pre-wrap;">${esc(context.excerpt)}</blockquote>`
          : ""
      }
      <a href="${esc(url)}" style="display:inline-block;padding:10px 18px;border-radius:8px;background:#5b2c83;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;">Open in Prio</a>
    </div>
    <div style="padding:14px 24px;border-top:1px solid #e2e7ef;background:#fbfcfe;">
      <p style="margin:0;font-size:12px;color:#8494ad;">
        Prio — internal project and issue management for Symbiosys Technologies.
        You are receiving this because you are involved in this issue.
      </p>
    </div>
  </div>
</div>`.trim();

  return { subject, text, html };
}

/* ---------------------------------------------------------------- send */

/**
 * Sends one notification to each recipient.
 *
 * Recipients are addressed individually rather than being put on a shared
 * To/CC line: a group header would tell every reader who else is involved,
 * which is information about the project they may not all be entitled to.
 */
export async function sendIssueMail(
  recipients: { email: string; name: string }[],
  context: IssueMailContext,
): Promise<{ sent: number; skipped: boolean }> {
  const unique = [
    ...new Map(recipients.map((r) => [r.email.toLowerCase(), r])).values(),
  ];

  if (unique.length === 0) return { sent: 0, skipped: false };

  const mailer = getTransport();
  if (!mailer) {
    console.info(
      `[prio] email not configured; would have notified ${unique.length} recipient(s) about ${context.issueKey}`,
    );
    return { sent: 0, skipped: true };
  }

  const { subject, text, html } = renderIssueEmail(context);
  const from = getEnv().SMTP_FROM;

  const results = await Promise.allSettled(
    unique.map((recipient) =>
      mailer.sendMail({
        from,
        to: `${recipient.name} <${recipient.email}>`,
        subject,
        text,
        html,
      }),
    ),
  );

  const failed = results.filter((r) => r.status === "rejected");
  if (failed.length > 0) {
    console.error(
      `[prio] ${failed.length} of ${unique.length} notification emails failed for ${context.issueKey}`,
      failed[0] && "reason" in failed[0] ? failed[0].reason : undefined,
    );
  }

  return { sent: results.length - failed.length, skipped: false };
}

/**
 * Sends without making the caller wait, and without letting a mail failure
 * surface as a failed action.
 */
export function sendIssueMailInBackground(
  recipients: { email: string; name: string }[],
  context: IssueMailContext,
): void {
  void sendIssueMail(recipients, context).catch((error) => {
    console.error("[prio] notification email failed:", error);
  });
}
