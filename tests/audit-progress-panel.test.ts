import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AuditProgressPanel } from "@/components/dashboard/audit-progress";
import type { AuditRow } from "@/components/dashboard/types";
import type { Locale } from "@/lib/i18n/config";
import { getMessages } from "@/lib/i18n/messages";
import { I18nProvider } from "@/lib/i18n/provider";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
function audit(over: Partial<AuditRow> = {}, crawl: Partial<NonNullable<AuditRow["crawlSession"]>> = {}): AuditRow {
  return {
    id: "a1", status: "running", geoScore: null, seoScore: null, eeatScore: null, summary: null, error: null, createdAt: ago(40_000), completedAt: null, _count: { actionItems: 0 },
    crawlSession: { id: "c1", status: "running", pagesCrawled: 0, pagesFailed: 0, startedAt: ago(30_000), finishedAt: null, progress: 0, stage: null, pagesTotal: null, ...crawl },
    ...over,
  };
}
const render = (a: AuditRow, runner: boolean | undefined = true, canceling = false, locale: Locale = "tr") =>
  renderToStaticMarkup(
    createElement(I18nProvider, { locale, messages: getMessages(locale) }, createElement(AuditProgressPanel, { audit: a, runner, canceling, onCancel: () => undefined })),
  );

describe("AuditProgressPanel", () => {
  it("renders the same states in English", () => {
    const html = render(audit({}, { stage: "crawl", progress: 31, pagesCrawled: 25, pagesTotal: 50 }), true, false, "en");
    expect(html).toContain("Crawling pages");
    expect(html).toContain("25 / 50 pages");
    expect(html).toContain("~31%");
    expect(html).toContain("Cancel audit");
    expect(render(audit({ status: "pending" }, { status: "queued" }), false, false, "en")).toContain("Nothing is running right now.");
  });

  it("shows the estimated percentage, stage, crawl counts, elapsed time, an accessible bar and a cancel button", () => {
    const html = render(audit({}, { stage: "crawl", progress: 31, pagesCrawled: 25, pagesTotal: 50 }));
    expect(html).toContain("Sayfalar taranıyor");
    expect(html).toContain("25 / 50 sayfa");
    expect(html).toContain("~%31");
    expect(html).toMatch(/role="progressbar"[^>]*aria-valuenow="31"/);
    expect(html).toContain("aria-valuemax=\"100\"");
    expect(html).toContain("width:31%");
    expect(html).toMatch(/3\d sn/); // elapsed since startedAt
    expect(html).toContain("Analizi iptal et");
  });

  it("is honest when nothing executes the audit (queued, no runner) and still offers to cancel", () => {
    const html = render(audit({ status: "pending" }, { status: "queued" }), false);
    expect(html).toContain("Şu anda hiçbir şey çalışmıyor");
    expect(html).toContain("GEO_AUDIT_BIN");
    expect(html).toContain("ilerleme gösterilemez");
    expect(html).not.toContain("progressbar");
    expect(html).toContain("Analizi iptal et");
  });

  it("says it is starting, and suggests cancelling once a queued audit waits too long", () => {
    const fresh = render(audit({ status: "pending", createdAt: ago(5_000) }, { status: "queued" }));
    expect(fresh).toContain("Analiz başlatılıyor");
    expect(fresh).not.toContain("yeniden başlamış olabilir");
    const stale = render(audit({ status: "pending", createdAt: ago(10 * 60_000) }, { status: "queued" }));
    expect(stale).toContain("yeniden başlamış olabilir");
    expect(stale).toContain("Analizi iptal et");
  });

  it("does not invent a percentage for a runner that reports none", () => {
    const html = render(audit({}, { stage: null, progress: 0 }));
    expect(html).toContain("Başlatılıyor");
    expect(html).toContain("İlerleme bilgisi yok");
    expect(html).not.toContain("aria-valuenow");
    expect(html).not.toContain("~%");
  });

  it("disables the cancel button and marks it busy while the cancellation is in flight", () => {
    const html = render(audit({}, { stage: "scoring", progress: 88 }), true, true);
    expect(html).toMatch(/<button[^>]*aria-busy="true"[^>]*disabled|<button[^>]*disabled[^>]*aria-busy="true"/);
    expect(html).toContain("Skorlar hesaplanıyor");
  });
});
