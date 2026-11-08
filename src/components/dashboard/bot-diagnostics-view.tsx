"use client";

import { useEffect, useMemo, useState } from "react";
import {
  BOT_META, botVerdict, buildAllowRule, DIAGNOSTIC_BOTS, formatMs, formatTokens, RULE_PLATFORM_LABELS, RULE_PLATFORMS, statusMix,
  VENDOR_LABELS, VERDICT_LABELS, type BotRecord, type BotSummary, type RulePlatform, type Verdict,
} from "@/lib/dashboard/bot-diagnostics";
import { formatDate, timeAgo } from "@/lib/dashboard/format";
import { apiFetch, ApiError, errorMessage, useApi } from "./api";
import { useSite } from "./site-shell";
import { useToast } from "./toast";
import { Badge, Button, Card, CodeBlock, cx, EmptyState, ErrorState, inputBase, Segmented, Skeleton, Spinner } from "./ui";

type Summary = {
  perBot: BotSummary[];
  botOnlyBlocks: { url: string; botName: string; statusCode: number | null; blockedBy: string | null }[];
  csrShellUrls: string[];
};
type SimulationList = { runId: string | null; checkedAt: string | null; summary: Summary | null; items: BotRecord[]; total: number };
type SimulationRun = { runId: string; checkedAt: string; urls: string[]; bots: string[]; summary: Summary; records: BotRecord[] };

/** Every simulated bot: the four headline bots get a card even before the first run. */
const RUN_BOTS = ["GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended", "Applebot-Extended"];

const VERDICT_STYLE: Record<Verdict, { dot: string; ring: string; text: string; icon: string }> = {
  allowed: { dot: "#0ca30c", ring: "border-emerald-300 dark:border-emerald-800", text: "text-emerald-800 dark:text-emerald-200", icon: "✓" },
  blocked: { dot: "#d03b3b", ring: "border-red-300 dark:border-red-800", text: "text-red-800 dark:text-red-200", icon: "✕" },
  shell: { dot: "#fab219", ring: "border-amber-300 dark:border-amber-800", text: "text-amber-900 dark:text-amber-200", icon: "!" },
  error: { dot: "#ec835a", ring: "border-orange-300 dark:border-orange-800", text: "text-orange-900 dark:text-orange-200", icon: "▲" },
  unknown: { dot: "#898781", ring: "border-zinc-200 dark:border-zinc-800", text: "text-zinc-600 dark:text-zinc-400", icon: "•" },
};

export function BotDiagnosticsView() {
  const { siteId, site } = useSite();
  const toast = useToast();
  const list = useApi<SimulationList>(`/api/sites/${siteId}/simulation/bots?limit=500`);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [urlsText, setUrlsText] = useState("");
  const [showOptions, setShowOptions] = useState(false);

  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    const t = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => {
      clearInterval(t);
      setElapsed(0);
    };
  }, [running]);

  const run = async () => {
    const urls = urlsText
      .split(/\s+/)
      .map((u) => u.trim())
      .filter(Boolean)
      .slice(0, 10);
    setRunning(true);
    try {
      const res = await apiFetch<SimulationRun>(`/api/sites/${siteId}/simulation/bots`, {
        method: "POST",
        json: { bots: RUN_BOTS, includeBaseline: true, ...(urls.length ? { urls } : {}) },
      });
      list.mutate(() => ({ runId: res.runId, checkedAt: res.checkedAt, summary: res.summary, items: res.records, total: res.records.length }));
      const blocked = res.summary.perBot.filter((b) => b.botName !== "Browser" && b.blocked > 0).length;
      toast.push(blocked ? "error" : "success", blocked ? `Test tamamlandı: ${blocked} bot engelleniyor.` : `Test tamamlandı: ${res.urls.length} URL × ${res.bots.length} kimlik.`);
    } catch (err) {
      toast.push("error", err instanceof ApiError && err.status === 409 ? "Bu site için zaten çalışan bir bot testi var. Birkaç saniye sonra tekrar deneyin." : errorMessage(err));
    } finally {
      setRunning(false);
    }
  };

  const data = list.data;
  const summary = data?.summary ?? null;
  const records = useMemo(() => data?.items ?? [], [data]);
  const perBot = useMemo(() => new Map((summary?.perBot ?? []).map((b) => [b.botName, b])), [summary]);
  const cardBots = useMemo(() => {
    const extra = (summary?.perBot ?? []).map((b) => b.botName).filter((b) => b !== "Browser" && !(DIAGNOSTIC_BOTS as readonly string[]).includes(b));
    return [...DIAGNOSTIC_BOTS, ...extra];
  }, [summary]);
  const blockedBots = cardBots.filter((b) => botVerdict(perBot.get(b)) === "blocked");
  const vendors = [...new Set((summary?.perBot ?? []).flatMap((b) => b.blockedBy).filter((v): v is string => !!v))];
  const browser = perBot.get("Browser");

  return (
    <div className="space-y-5">
      <Card
        title="Canlı AI Bot Teşhis Merkezi"
        subtitle="Sitenizi GPTBot, ClaudeBot, PerplexityBot ve Google-Extended kimlikleriyle canlı olarak çeker; WAF engelini, JS shell (boş render) sorununu ve token yükünü ölçer."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => setShowOptions((v) => !v)} aria-expanded={showOptions}>
              {showOptions ? "Seçenekleri gizle" : "URL seç"}
            </Button>
            <Button variant="primary" onClick={() => void run()} loading={running}>
              {running ? `Test ediliyor… ${elapsed}s` : "▶ Canlı Bot Testini Çalıştır"}
            </Button>
          </div>
        }
      >
        {showOptions && (
          <label className="mb-4 flex flex-col gap-1 text-xs font-medium text-zinc-600 dark:text-zinc-400">
            Test edilecek URL&apos;ler (boşluk/satır ile ayırın, en fazla 10; boş = ana sayfa + son taranan 4 sayfa)
            <textarea
              className={`${inputBase} min-h-20 w-full font-mono text-xs`}
              placeholder={`${site.url}\n/blog\n/urunler`}
              value={urlsText}
              onChange={(e) => setUrlsText(e.target.value)}
              disabled={running}
            />
          </label>
        )}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500">
          {data?.checkedAt ? (
            <>
              <span title={formatDate(data.checkedAt)}>Son test: {timeAgo(data.checkedAt)}</span>
              <span>
                {new Set(records.map((r) => r.url)).size} URL · {perBot.size} kimlik
              </span>
              {browser && (
                <span>
                  Kontrol (tarayıcı): {browser.blocked ? <b className="text-red-600">engelli — site geneli sorun</b> : <b className="text-[#006300] dark:text-[#0ca30c]">erişilebilir</b>}
                </span>
              )}
            </>
          ) : (
            !list.loading && <span>Henüz test çalıştırılmadı.</span>
          )}
          {list.refreshing && !running && <Spinner className="h-3 w-3" />}
        </div>
        {running && (
          <div className="mt-3 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800" role="progressbar" aria-label="Bot testi sürüyor" aria-valuetext={`${elapsed} saniye`}>
            <div className="h-1 w-1/3 animate-[botscan_1.4s_ease-in-out_infinite] rounded-full bg-indigo-500" />
          </div>
        )}
      </Card>

      {list.loading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" role="status" aria-label="Yükleniyor">
          {DIAGNOSTIC_BOTS.map((b) => (
            <Skeleton key={b} className="h-48" />
          ))}
        </div>
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={() => void list.reload()} />
      ) : (
        <>
          <div className={cx("grid gap-4 sm:grid-cols-2", cardBots.length > 4 ? "xl:grid-cols-5" : "xl:grid-cols-4", running && "opacity-60")} aria-busy={running}>
            {cardBots.map((b) => (
              <BotCard key={b} bot={b} summary={perBot.get(b)} records={records.filter((r) => r.botName === b)} running={running} />
            ))}
          </div>

          {summary && (summary.botOnlyBlocks.length > 0 || summary.csrShellUrls.length > 0) && <Findings summary={summary} />}

          {records.length > 0 ? (
            <ResultMatrix records={records} bots={[...cardBots, ...(browser ? ["Browser"] : [])]} />
          ) : (
            !running && (
              <EmptyState
                icon="🤖"
                title="AI botları sitenizi görebiliyor mu?"
                action={
                  <Button variant="primary" onClick={() => void run()}>
                    ▶ İlk testi çalıştır
                  </Button>
                }
              >
                robots.txt izni erişim demek değildir: Cloudflare/WAF kuralları veya yalnızca JavaScript ile render edilen sayfalar AI botlarına boş içerik döndürebilir.
              </EmptyState>
            )
          )}
        </>
      )}

      <RuleGenerator blockedBots={blockedBots} vendors={vendors} />
    </div>
  );
}

function BotCard({ bot, summary, records, running }: { bot: string; summary: BotSummary | undefined; records: BotRecord[]; running: boolean }) {
  const verdict = botVerdict(summary);
  const style = VERDICT_STYLE[verdict];
  const meta = BOT_META[bot];
  const vendors = (summary?.blockedBy ?? []).filter((v): v is string => !!v);
  return (
    <section className={cx("flex flex-col rounded-xl border-2 bg-white p-4 shadow-sm dark:bg-zinc-900", style.ring)} aria-label={`${bot}: ${VERDICT_LABELS[verdict]}`}>
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate font-semibold">{bot}</h3>
          <p className="text-xs text-zinc-500">{meta?.vendor ?? "AI crawler"}</p>
        </div>
        <span className="relative mt-1 flex h-3 w-3 shrink-0" aria-hidden>
          {running && <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60" style={{ background: style.dot }} />}
          <span className="relative inline-flex h-3 w-3 rounded-full" style={{ background: style.dot }} />
        </span>
      </header>
      <div className={cx("mt-3 flex items-center gap-1.5 text-sm font-semibold", style.text)}>
        <span aria-hidden>{style.icon}</span>
        {VERDICT_LABELS[verdict]}
      </div>
      {verdict === "blocked" && vendors.length > 0 && <p className="mt-0.5 text-xs text-red-700 dark:text-red-300">{vendors.map((v) => VENDOR_LABELS[v] ?? v).join(", ")}</p>}
      {verdict === "shell" && summary && <p className="mt-0.5 text-xs text-amber-800 dark:text-amber-300">{summary.csrShells}/{summary.checked} sayfa boş JS kabuğu</p>}
      <dl className="mt-4 grid grid-cols-2 gap-3 text-xs">
        <div>
          <dt className="text-zinc-500">Ort. yüklenme</dt>
          <dd className="mt-0.5 text-lg font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{summary ? formatMs(summary.avgLoadTimeMs) : "—"}</dd>
        </div>
        <div>
          <dt className="text-zinc-500" title="Botun gördüğü görünür metin, ≈ karakter ÷ 4">
            Token ağırlığı
          </dt>
          <dd className="mt-0.5 text-lg font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{summary ? formatTokens(summary.avgTokens) : "—"}</dd>
        </div>
      </dl>
      <div className="mt-auto pt-3 text-xs text-zinc-500">
        {summary ? (
          <>
            <span className="tabular-nums">
              {summary.ok}/{summary.checked} sayfa erişilebilir
            </span>
            <span className="block truncate font-mono" title="HTTP durum kodları">
              HTTP {statusMix(records) || "—"}
            </span>
          </>
        ) : (
          "Henüz test edilmedi"
        )}
        {meta?.note && <span className="mt-1 block text-[11px] text-zinc-400">{meta.note}</span>}
      </div>
    </section>
  );
}

function Findings({ summary }: { summary: Summary }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {summary.botOnlyBlocks.length > 0 && (
        <Card title="Yalnızca botlara özel engeller" subtitle="Normal tarayıcı erişebiliyor ama AI botu engelleniyor → WAF / bot kuralı sorunu">
          <ul className="space-y-1.5 text-sm">
            {summary.botOnlyBlocks.slice(0, 20).map((b) => (
              <li key={`${b.url}-${b.botName}`} className="flex flex-wrap items-center gap-2">
                <Badge tone="critical">{b.botName}</Badge>
                <span className="min-w-0 flex-1 truncate font-mono text-xs" title={b.url}>
                  {b.url}
                </span>
                <span className="text-xs text-zinc-500">
                  {b.statusCode ?? "—"} · {VENDOR_LABELS[b.blockedBy ?? ""] ?? b.blockedBy}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {summary.csrShellUrls.length > 0 && (
        <Card title="JS shell sayfalar" subtitle="AI botları JavaScript çalıştırmaz: bu sayfaların ilk HTML'i neredeyse boş">
          <ul className="space-y-1 text-sm">
            {summary.csrShellUrls.slice(0, 20).map((u) => (
              <li key={u} className="truncate font-mono text-xs" title={u}>
                <a href={u} target="_blank" rel="noopener noreferrer" className="text-indigo-600 hover:underline dark:text-indigo-400">
                  {u}
                </a>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-zinc-500">Çözüm: sayfayı sunucu tarafında render edin (SSR/SSG) veya botlara prerender edilmiş HTML sunun.</p>
        </Card>
      )}
    </div>
  );
}

function cellTone(r: BotRecord): Verdict {
  if (r.isBlocked) return "blocked";
  if (r.isCsrShell) return "shell";
  if (r.statusCode !== null && r.statusCode < 400) return "allowed";
  return "error";
}

function ResultMatrix({ records, bots }: { records: BotRecord[]; bots: string[] }) {
  const urls = useMemo(() => [...new Set(records.map((r) => r.url))], [records]);
  const cell = useMemo(() => new Map(records.map((r) => [`${r.url}\u0000${r.botName}`, r])), [records]);
  const shown = bots.filter((b) => records.some((r) => r.botName === b));
  return (
    <Card title="URL × Bot sonuç matrisi" subtitle="Her hücre: HTTP durumu · yüklenme süresi · token">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left text-xs">
          <thead className="text-zinc-500">
            <tr>
              <th className="py-2 pr-3 font-medium">URL</th>
              {shown.map((b) => (
                <th key={b} className="px-2 py-2 font-medium whitespace-nowrap">
                  {b === "Browser" ? "Tarayıcı (kontrol)" : b}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {urls.map((u) => (
              <tr key={u} className="border-t border-zinc-100 dark:border-zinc-800">
                <td className="max-w-64 truncate py-2 pr-3 font-mono" title={u}>
                  {u.replace(/^https?:\/\/[^/]+/, "") || "/"}
                </td>
                {shown.map((b) => {
                  const r = cell.get(`${u}\u0000${b}`);
                  if (!r)
                    return (
                      <td key={b} className="px-2 py-2 text-zinc-400">
                        —
                      </td>
                    );
                  const v = cellTone(r);
                  return (
                    <td key={b} className="px-2 py-2 whitespace-nowrap" title={r.blockedBy ? `Engelleyen: ${VENDOR_LABELS[r.blockedBy] ?? r.blockedBy}` : VERDICT_LABELS[v]}>
                      <span className="inline-flex items-center gap-1.5">
                        <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: VERDICT_STYLE[v].dot }} />
                        <span className={cx("font-semibold tabular-nums", VERDICT_STYLE[v].text)}>{r.statusCode ?? "ERR"}</span>
                        <span className="sr-only">{VERDICT_LABELS[v]}</span>
                      </span>
                      <span className="block text-zinc-500 tabular-nums">
                        {formatMs(r.loadTimeMs)} · {formatTokens(r.tokenCount)} tk
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function RuleGenerator({ blockedBots, vendors }: { blockedBots: string[]; vendors: string[] }) {
  const [platform, setPlatform] = useState<RulePlatform>("cloudflare");
  const [picked, setPicked] = useState<Set<string> | null>(null);
  // Until the user picks bots themselves, follow the latest result: the blocked bots, or every headline bot.
  const selected = picked ?? new Set(blockedBots.length ? blockedBots : RUN_BOTS);
  const rule = buildAllowRule(platform, RUN_BOTS.filter((b) => selected.has(b)));
  const toggle = (b: string) => {
    const next = new Set(selected);
    if (next.has(b)) next.delete(b);
    else next.add(b);
    setPicked(next);
  };
  return (
    <Card
      title="WAF bypass kuralı üretici"
      subtitle="Seçilen AI botlarını güvenlik duvarı ve sunucu kurallarından muaf tutan, kopyalanmaya hazır yapılandırma"
      action={vendors.length > 0 ? <Badge tone="critical">Tespit edilen: {vendors.map((v) => VENDOR_LABELS[v] ?? v).join(", ")}</Badge> : undefined}
    >
      <div className="flex flex-wrap items-center gap-3">
        <Segmented label="Platform" value={platform} onChange={setPlatform} options={RULE_PLATFORMS.map((p) => ({ value: p, label: RULE_PLATFORM_LABELS[p] }))} />
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Botlar">
          {RUN_BOTS.map((b) => {
            const on = selected.has(b);
            return (
              <button
                key={b}
                type="button"
                aria-pressed={on}
                onClick={() => toggle(b)}
                className={cx(
                  "rounded-full border px-2.5 py-1 text-xs transition",
                  on ? "border-indigo-300 bg-indigo-50 text-indigo-800 dark:border-indigo-800 dark:bg-indigo-950 dark:text-indigo-200" : "border-dashed border-zinc-300 text-zinc-400 dark:border-zinc-700",
                  blockedBots.includes(b) && "font-semibold",
                )}
              >
                {on ? "✓ " : ""}
                {b}
                {blockedBots.includes(b) && <span className="ml-1 text-red-600">●</span>}
              </button>
            );
          })}
        </div>
      </div>
      <div className="mt-4">
        {rule ? (
          <div className="space-y-3">
            <CodeBlock code={rule.code} language={rule.language} filename={rule.filename} maxHeight="22rem" />
            <ol className="list-decimal space-y-0.5 pl-5 text-xs text-zinc-600 dark:text-zinc-400">
              {rule.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          </div>
        ) : (
          <p className="text-sm text-zinc-500">Kural üretmek için en az bir bot seçin.</p>
        )}
      </div>
    </Card>
  );
}
