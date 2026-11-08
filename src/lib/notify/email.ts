import { OUTBOUND_TIMEOUT_MS, readSnippet } from "../distribution/net";

// E-mail delivery: SMTP (nodemailer), Resend or SendGrid HTTP APIs, or a "log" transport that only
// simulates delivery (default when nothing is configured, and for dry runs).

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: EmailAttachment[];
}

export interface EmailTransport {
  /** smtp | resend | sendgrid | log | custom names in tests */
  name: string;
  /** true when the transport does not actually deliver (log / dry run). */
  simulated?: boolean;
  send(message: EmailMessage & { from: string }): Promise<{ messageId?: string; response?: unknown }>;
}

export const EMAIL_PROVIDERS = ["auto", "smtp", "resend", "sendgrid", "log"] as const;

export function fromAddress() {
  return process.env.REPORT_FROM_EMAIL?.trim() || "reports@example.com";
}

const logTransport: EmailTransport = {
  name: "log",
  simulated: true,
  async send(m) {
    if (process.env.NODE_ENV !== "test") {
      console.warn(`[email:simulated] to=${m.to} subject="${m.subject}" attachments=${m.attachments?.map((a) => a.filename).join(",") || "-"}`);
    }
    return { messageId: `simulated-${Date.now().toString(36)}` };
  },
};

function smtpTransport(): EmailTransport {
  return {
    name: "smtp",
    async send(m) {
      const nodemailer = await import("nodemailer");
      const port = Number(process.env.SMTP_PORT || 587);
      const user = process.env.SMTP_USER?.trim();
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port,
        secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === "true" : port === 465,
        auth: user ? { user, pass: process.env.SMTP_PASSWORD ?? "" } : undefined,
        connectionTimeout: OUTBOUND_TIMEOUT_MS,
        greetingTimeout: OUTBOUND_TIMEOUT_MS,
        socketTimeout: OUTBOUND_TIMEOUT_MS * 2,
      });
      const info = await transporter.sendMail({
        from: m.from,
        to: m.to,
        subject: m.subject,
        html: m.html,
        text: m.text,
        attachments: m.attachments?.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
      });
      return { messageId: info.messageId, response: info.response };
    },
  };
}

async function postJson(url: string, token: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await readSnippet(res, 300)}`);
  return res;
}

function resendTransport(apiKey: string): EmailTransport {
  return {
    name: "resend",
    async send(m) {
      const res = await postJson("https://api.resend.com/emails", apiKey, {
        from: m.from,
        to: [m.to],
        subject: m.subject,
        html: m.html,
        text: m.text,
        attachments: m.attachments?.map((a) => ({ filename: a.filename, content: a.content.toString("base64"), content_type: a.contentType })),
      });
      const data = (await res.json().catch(() => ({}))) as { id?: string };
      return { messageId: data.id };
    },
  };
}

function sendgridTransport(apiKey: string): EmailTransport {
  return {
    name: "sendgrid",
    async send(m) {
      const res = await postJson("https://api.sendgrid.com/v3/mail/send", apiKey, {
        personalizations: [{ to: [{ email: m.to }] }],
        from: { email: m.from },
        subject: m.subject,
        content: [
          { type: "text/plain", value: m.text },
          { type: "text/html", value: m.html },
        ],
        attachments: m.attachments?.map((a) => ({ content: a.content.toString("base64"), filename: a.filename, type: a.contentType, disposition: "attachment" })),
      });
      return { messageId: res.headers.get("x-message-id") ?? undefined };
    },
  };
}

let override: EmailTransport | null = null;
/** Test / embedding hook: force a transport (null restores env-based resolution). */
export function setEmailTransport(t: EmailTransport | null) {
  override = t;
}

/**
 * EMAIL_PROVIDER=auto (default) picks Resend (RESEND_API_KEY), SendGrid (SENDGRID_API_KEY),
 * SMTP (SMTP_HOST), else the simulated log transport.
 */
export function resolveEmailTransport(opts: { dryRun?: boolean } = {}): EmailTransport {
  if (opts.dryRun) return logTransport;
  if (override) return override;
  const provider = (process.env.EMAIL_PROVIDER?.trim() || "auto").toLowerCase();
  const resend = process.env.RESEND_API_KEY?.trim();
  const sendgrid = process.env.SENDGRID_API_KEY?.trim();
  const smtp = process.env.SMTP_HOST?.trim();
  switch (provider) {
    case "log":
      return logTransport;
    case "resend":
      if (!resend) throw new Error("EMAIL_PROVIDER=resend but RESEND_API_KEY is empty");
      return resendTransport(resend);
    case "sendgrid":
      if (!sendgrid) throw new Error("EMAIL_PROVIDER=sendgrid but SENDGRID_API_KEY is empty");
      return sendgridTransport(sendgrid);
    case "smtp":
      if (!smtp) throw new Error("EMAIL_PROVIDER=smtp but SMTP_HOST is empty");
      return smtpTransport();
    default:
      if (resend) return resendTransport(resend);
      if (sendgrid) return sendgridTransport(sendgrid);
      if (smtp) return smtpTransport();
      return logTransport;
  }
}

export interface EmailResult {
  status: "sent" | "simulated" | "failed";
  provider: string;
  messageId?: string;
  error?: string;
}

export async function sendEmail(message: EmailMessage, opts: { dryRun?: boolean } = {}): Promise<EmailResult> {
  let transport: EmailTransport;
  try {
    transport = resolveEmailTransport(opts);
  } catch (err) {
    return { status: "failed", provider: "config", error: (err as Error).message };
  }
  try {
    const { messageId } = await transport.send({ ...message, from: fromAddress() });
    return { status: transport.simulated ? "simulated" : "sent", provider: transport.name, messageId };
  } catch (err) {
    return { status: "failed", provider: transport.name, error: (err as Error).message.slice(0, 500) };
  }
}
