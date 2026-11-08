import type { z } from "zod";
import type { WebhookType } from "../constants";
import { assertPublicHttpUrl, OUTBOUND_TIMEOUT_MS, readSnippet } from "../distribution/net";
import { signWebhook } from "../distribution/syndication";
import type { webhookTargetSchema } from "../validation";
import { trPct, type PeriodicReport } from "../reports/builder";
import { alertSubject, FREQUENCY_TR, IMPACT_TR, periodLabel, reportSubject, type AlertContent } from "../reports/html";

// Report / alert notifications for Slack (incoming webhooks), Discord and generic JSON endpoints.
// Generic payloads are HMAC-signed with the site's `webhookSecret` integration when present.

export type WebhookTarget = z.infer<typeof webhookTargetSchema>;

export function detectWebhookType(target: WebhookTarget): WebhookType {
  if (target.type) return target.type;
  const host = new URL(target.url).hostname;
  if (host === "hooks.slack.com") return "slack";
  if (/(^|\.)discord(app)?\.com$/.test(host) && new URL(target.url).pathname.startsWith("/api/webhooks/")) return "discord";
  return "generic";
}

export type NotificationEvent =
  | { event: "report.weekly" | "report.daily"; report: PeriodicReport; links: { html?: string | null; pdf?: string | null } }
  | { event: "anomaly.detected"; alert: AlertContent; links: { html?: string | null } };

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const signed = (n: number | null) => (n == null ? "" : n > 0 ? ` (+${n})` : ` (${n})`);

function reportFields(r: PeriodicReport) {
  const v = r.visibility.current;
  return [
    ["GEO", r.scores.geo.current == null ? "—" : `${r.scores.geo.current}${signed(r.scores.geo.delta)}`],
    ["SEO", r.scores.seo.current == null ? "—" : `${r.scores.seo.current}${signed(r.scores.seo.delta)}`],
    ["E-E-A-T", r.scores.eeat.current == null ? "—" : `${r.scores.eeat.current}${signed(r.scores.eeat.delta)}`],
    ["AI görünürlük", v.visibilityRate == null ? "—" : trPct(v.visibilityRate)],
    ["Model atıfı", `${v.cited} / ${v.totalChecks}`],
    ["Bekleyen aksiyon", `${r.actions.pendingCount} (${r.actions.pendingByImpact.high ?? 0} yüksek)`],
  ] as const;
}

function topActions(r: PeriodicReport, n = 5) {
  return r.actions.pendingCritical.slice(0, n).map((a) => `• [${IMPACT_TR[a.impact] ?? a.impact}] ${a.title}`);
}

export function buildSlackPayload(e: NotificationEvent) {
  if (e.event === "anomaly.detected") {
    const a = e.alert;
    return {
      text: alertSubject(a),
      blocks: [
        { type: "header", text: { type: "plain_text", text: clip(alertSubject(a), 150) } },
        { type: "section", text: { type: "mrkdwn", text: clip(a.anomalies.map((x) => `• ${x.severity === "high" ? "*Kritik*" : "Uyarı"}: ${x.message}`).join("\n"), 2900) } },
        { type: "context", elements: [{ type: "mrkdwn", text: `${a.site.url}${e.links.html ? ` · <${e.links.html}|Raporu aç>` : ""}` }] },
      ],
    };
  }
  const r = e.report;
  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: clip(reportSubject(r), 150) } },
    { type: "section", text: { type: "mrkdwn", text: `*${r.headline.text}*\n${r.site.url} · ${periodLabel(r)}` } },
    { type: "section", fields: reportFields(r).map(([k, v]) => ({ type: "mrkdwn", text: `*${k}*\n${v}` })) },
    { type: "section", text: { type: "mrkdwn", text: clip(`*Yönetici Özeti*\n${r.executiveSummary.map((s) => `• ${s}`).join("\n")}`, 2900) } },
  ];
  const actions = topActions(r);
  if (actions.length) blocks.push({ type: "section", text: { type: "mrkdwn", text: clip(`*Bekleyen kritik aksiyonlar*\n${actions.join("\n")}`, 2900) } });
  const links = [e.links.html && `<${e.links.html}|HTML rapor>`, e.links.pdf && `<${e.links.pdf}|PDF>`].filter(Boolean);
  if (links.length) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: links.join(" · ") }] });
  return { text: `${reportSubject(r)} — ${r.headline.text}`, blocks };
}

const DISCORD_COLOR = { up: 0x047857, down: 0xb91c1c, flat: 0x4f46e5, none: 0x64748b, alert: 0xb45309, critical: 0xb91c1c };

export function buildDiscordPayload(e: NotificationEvent) {
  if (e.event === "anomaly.detected") {
    const a = e.alert;
    const critical = a.anomalies.some((x) => x.severity === "high");
    return {
      username: "AI Visibility",
      embeds: [
        {
          title: clip(alertSubject(a), 256),
          url: e.links.html ?? undefined,
          description: clip(a.anomalies.map((x) => `• **${x.severity === "high" ? "Kritik" : "Uyarı"}**: ${x.message}`).join("\n"), 4000),
          color: critical ? DISCORD_COLOR.critical : DISCORD_COLOR.alert,
          timestamp: a.detectedAt,
          footer: { text: a.site.url },
        },
      ],
    };
  }
  const r = e.report;
  const actions = topActions(r);
  return {
    username: "AI Visibility",
    embeds: [
      {
        title: clip(reportSubject(r), 256),
        url: e.links.html ?? undefined,
        description: clip(`**${r.headline.text}**\n\n${r.executiveSummary.map((s) => `• ${s}`).join("\n")}`, 4000),
        color: DISCORD_COLOR[r.headline.direction],
        fields: [
          ...reportFields(r).map(([name, value]) => ({ name, value: String(value), inline: true })),
          ...(actions.length ? [{ name: "Bekleyen kritik aksiyonlar", value: clip(actions.join("\n"), 1024), inline: false }] : []),
          ...(e.links.pdf ? [{ name: "PDF", value: e.links.pdf, inline: false }] : []),
        ].slice(0, 25),
        timestamp: r.generatedAt,
        footer: { text: `${r.site.url} · ${FREQUENCY_TR[r.frequency]} · ${r.periodKey}` },
      },
    ],
  };
}

export function buildGenericPayload(e: NotificationEvent) {
  if (e.event === "anomaly.detected") {
    return { event: e.event, site: e.alert.site, detectedAt: e.alert.detectedAt, anomalies: e.alert.anomalies, links: e.links };
  }
  return { event: e.event, site: e.report.site, period: e.report.period, headline: e.report.headline, report: e.report, links: e.links };
}

export function buildWebhookPayload(type: WebhookType, e: NotificationEvent) {
  return type === "slack" ? buildSlackPayload(e) : type === "discord" ? buildDiscordPayload(e) : buildGenericPayload(e);
}

export interface WebhookDeliveryResult {
  status: "sent" | "failed" | "simulated";
  type: WebhookType;
  httpStatus: number | null;
  message: string;
}

export async function deliverWebhook(
  target: WebhookTarget,
  e: NotificationEvent,
  opts: { secret?: string; dryRun?: boolean } = {},
): Promise<WebhookDeliveryResult> {
  const type = detectWebhookType(target);
  const body = JSON.stringify(buildWebhookPayload(type, e));
  if (opts.dryRun) return { status: "simulated", type, httpStatus: null, message: `Dry run: ${body.length} bytes not sent` };
  const timestamp = String(Math.floor(Date.now() / 1000));
  try {
    await assertPublicHttpUrl(target.url);
    const res = await fetch(target.url, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        "user-agent": "AIVisibility-Reports/1.0",
        ...(type === "generic" && {
          "x-aiv-event": e.event,
          "x-aiv-timestamp": timestamp,
          ...(opts.secret && { "x-aiv-signature": signWebhook(opts.secret, timestamp, body) }),
        }),
      },
      body,
      signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
    });
    return {
      status: res.ok ? "sent" : "failed",
      type,
      httpStatus: res.status,
      message: res.ok ? "Delivered" : await readSnippet(res, 300),
    };
  } catch (err) {
    return { status: "failed", type, httpStatus: null, message: (err as Error).message.slice(0, 500) };
  }
}
