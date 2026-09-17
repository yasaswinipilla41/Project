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

/* ------------------------------------------------------ welcome to Prio */

export interface WelcomeMailContext {
  name: string;
  /** The address they sign in with — the one the administrator typed. */
  email: string;
  /** The password the administrator chose, which they must replace. */
  temporaryPassword: string;
  /** Their account role, as the People screen granted it. */
  roleLabel: string;
  /** The projects actually saved against the account; may be empty. */
  projects: string[];
}

function signInUrl(): string {
  const base = getEnv().BASE_URL.replace(/\/+$/, "");
  return `${base}/sign-in`;
}

/**
 * The one message that carries a password, and the reasons that is acceptable.
 *
 * Prio never stores what is printed here — the account row holds a hash, and
 * this string exists only for the length of the request that created the
 * account. It is sent because an administrator choosing somebody's first
 * password has to get it to them somehow, and the alternative designs (showing
 * it on screen for the administrator to relay, or a reset link) were not what
 * this workflow asked for.
 *
 * Two things follow from that and are load-bearing rather than decorative: the
 * message says the password must be changed at first sign-in, which the
 * application then enforces rather than merely advising, and the password is
 * never written to a log on the way here.
 */
function renderWelcomeEmail(context: WelcomeMailContext): {
  subject: string;
  text: string;
  html: string;
} {
  const url = signInUrl();
  const subject = "Welcome to Prio — your account details";

  const projectLine =
    context.projects.length === 0
      ? null
      : context.projects.length === 1
        ? `Project: ${context.projects[0]}`
        : `Projects:\n${context.projects.map((p) => `  ${p}`).join("\n")}`;

  const text = [
    `Welcome to Prio, ${context.name}.`,
    "",
    "An administrator has created your account.",
    "",
    `Email: ${context.email}`,
    `Temporary password: ${context.temporaryPassword}`,
    `Role: ${context.roleLabel}`,
    projectLine,
    "",
    `Sign in: ${url}`,
    "",
    "You will be asked to choose a new password the first time you sign in.",
    "Please do not share these details with anyone.",
    "",
    "— Prio · Track, prioritize, deliver",
  ]
    .filter((line) => line !== null && line !== "")
    .join("\n");

  const projectsHtml =
    context.projects.length === 0
      ? ""
      : `<tr><td style="padding:6px 0;font-size:13px;color:#6b7c98;">${
          context.projects.length === 1 ? "Project" : "Projects"
        }</td><td style="padding:6px 0;font-size:14px;color:#1e293b;font-weight:600;">${context.projects
          .map((p) => esc(p))
          .join("<br>")}</td></tr>`;

  const html = `
<div style="margin:0;padding:24px;background:#f6f8fb;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e7ef;border-radius:14px;overflow:hidden;">
    <div style="padding:18px 24px;background:linear-gradient(135deg,#5b2c83 0%,#8b5cf6 100%);">
      <span style="font-size:17px;font-weight:700;color:#ffffff;letter-spacing:-0.02em;">Prio</span>
      <span style="margin-left:10px;font-size:11px;color:#e9d8fd;letter-spacing:0.08em;text-transform:uppercase;">Track · Prioritize · Deliver</span>
    </div>
    <div style="padding:24px;">
      <p style="margin:0 0 6px;font-size:18px;font-weight:600;color:#1e293b;">Welcome to Prio, ${esc(context.name)}.</p>
      <p style="margin:0 0 20px;font-size:14px;color:#506078;">An administrator has created your account. Here is what you need to sign in.</p>

      <table style="width:100%;border-collapse:collapse;margin:0 0 20px;">
        <tr><td style="padding:6px 0;font-size:13px;color:#6b7c98;width:40%;">Email</td><td style="padding:6px 0;font-size:14px;color:#1e293b;font-weight:600;">${esc(context.email)}</td></tr>
        <tr><td style="padding:6px 0;font-size:13px;color:#6b7c98;">Temporary password</td><td style="padding:6px 0;font-size:14px;color:#1e293b;font-weight:600;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${esc(context.temporaryPassword)}</td></tr>
        <tr><td style="padding:6px 0;font-size:13px;color:#6b7c98;">Role</td><td style="padding:6px 0;font-size:14px;color:#1e293b;font-weight:600;">${esc(context.roleLabel)}</td></tr>
        ${projectsHtml}
      </table>

      <a href="${esc(url)}" style="display:inline-block;padding:10px 18px;border-radius:8px;background:#5b2c83;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;">Sign in to Prio</a>

      <p style="margin:20px 0 0;padding:12px 16px;border-left:3px solid #8b5cf6;background:#f6f8fb;border-radius:0 8px 8px 0;font-size:13px;color:#3b4a60;">
        You will be asked to choose a new password the first time you sign in.
        Please do not share these details with anyone.
      </p>
    </div>
    <div style="padding:14px 24px;border-top:1px solid #e2e7ef;background:#fbfcfe;">
      <p style="margin:0;font-size:12px;color:#8494ad;">
        Prio — internal project and issue management for Symbiosys Technologies.
      </p>
    </div>
  </div>
</div>`.trim();

  return { subject, text, html };
}

/**
 * Sends the welcome message, and says whether it went.
 *
 * Unlike the issue notifications above this is awaited by its caller, because
 * an administrator who has just created somebody's account needs to know
 * whether that person can be told about it. The account is never rolled back
 * on a mail failure — it exists, and re-running the creation would only
 * collide with the address — so the answer is reported rather than thrown.
 */
export async function sendWelcomeMail(
  context: WelcomeMailContext,
): Promise<{ sent: boolean; skipped: boolean }> {
  const mailer = getTransport();
  if (!mailer) {
    /* Deliberately says nothing about the password. */
    console.info(
      `[prio] email not configured; no welcome message sent to ${context.email}`,
    );
    return { sent: false, skipped: true };
  }

  const { subject, text, html } = renderWelcomeEmail(context);

  try {
    await mailer.sendMail({
      from: getEnv().SMTP_FROM,
      to: `${context.name} <${context.email}>`,
      subject,
      text,
      html,
    });
    return { sent: true, skipped: false };
  } catch (error) {
    /* The address is safe to log; what was in the message is not. */
    console.error(`[prio] welcome email to ${context.email} failed:`, error);
    return { sent: false, skipped: false };
  }
}
