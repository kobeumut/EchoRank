"use client";

import { useState } from "react";
import { formatDate, PLATFORM_LABELS, timeAgo } from "@/lib/dashboard/format";
import { apiFetch, errorMessage, useApi } from "./api";
import { useSite } from "./site-shell";
import { useToast } from "./toast";
import type { DistributionOverview, KeyFile, Submission } from "./types";
import { Badge, Button, Card, CodeBlock, cx, downloadText, EmptyState, ErrorState, inputClass, Segmented, Skeleton, SkeletonCard } from "./ui";

const OUTPUT_LABELS: Record<string, string> = {
  llms: "llms.txt",
  llmsFull: "llms-full.txt",
  sitemap: "AI sitemap",
  rss: "RSS 2.0 akışı",
  atom: "Atom akışı",
  json: "JSON Feed",
};
const QUEUE_STATUS_LABELS: Record<string, string> = { pending: "Bekliyor", processing: "Gönderiliyor", sent: "Gönderildi", failed: "Başarısız", skipped: "Atlandı" };
const CHANNEL_LABELS: Record<string, string> = { indexnow: "IndexNow", google_indexing: "Google Indexing API" };

function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx("relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50", checked ? "bg-indigo-600" : "bg-zinc-300 dark:bg-zinc-700")}
    >
      <span className={cx("inline-block h-4 w-4 rounded-full bg-white shadow transition-transform", checked ? "translate-x-4" : "translate-x-0.5")} />
    </button>
  );
}

function ReadyRow({ ok, label, children }: { ok: boolean; label: string; children?: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      <span aria-hidden className={ok ? "text-[#0ca30c]" : "text-[#d03b3b]"}>
        {ok ? "✓" : "✕"}
      </span>
      <div className="min-w-0">
        <span className="text-zinc-800 dark:text-zinc-200">{label}</span>
        {children && <div className="text-xs text-zinc-500">{children}</div>}
      </div>
    </li>
  );
}

function submissionDetail(s: Submission): string {
  const r = s.response;
  if (!r || typeof r !== "object") return "";
  const o = r as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof o.status === "number") parts.push(`HTTP ${o.status}`);
  if (typeof o.httpStatus === "number") parts.push(`HTTP ${o.httpStatus}`);
  if (typeof o.error === "string") parts.push(o.error);
  if (typeof o.message === "string") parts.push(o.message);
  return parts.join(" · ");
}

function LlmsPreview({ siteId, outputs, siteUrl }: { siteId: string; outputs: DistributionOverview["outputs"]; siteUrl: string }) {
  const [which, setWhich] = useState<"llms" | "llmsFull">("llms");
  const out = outputs[which] ?? { api: `/api/sites/${siteId}/ai/${which === "llms" ? "llms.txt" : "llms-full.txt"}`, publicPath: which === "llms" ? "/llms.txt" : "/llms-full.txt" };
  const file = useApi<string>(out.api, { parse: "text" });
  const filename = out.publicPath.replace(/^\//, "");
  return (
    <Card
      title="Dinamik llms.txt"
      subtitle={`Taranan içerikten otomatik üretilir. Sitenizin köküne ${siteUrl}${out.publicPath} olarak yayınlayın.`}
      action={
        <Segmented
          label="Dosya"
          value={which}
          onChange={setWhich}
          options={[
            { value: "llms", label: "llms.txt" },
            { value: "llmsFull", label: "llms-full.txt" },
          ]}
        />
      }
    >
      {file.loading ? (
        <Skeleton className="h-64" />
      ) : file.error ? (
        <ErrorState error={file.error} onRetry={() => void file.reload()} />
      ) : !file.data?.trim() ? (
        <EmptyState title="İçerik yok">Önce bir analiz çalıştırarak siteyi taratın.</EmptyState>
      ) : (
        <>
          <CodeBlock code={file.data} language="markdown" filename={filename} maxHeight="26rem" />
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="primary" onClick={() => downloadText(file.data!, filename, "text/markdown;charset=utf-8")}>
              ⬇ {filename} indir
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void file.reload()} loading={file.refreshing}>
              Yeniden oluştur
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}

export function DistributionView() {
  const { siteId, site, version } = useSite();
  const toast = useToast();
  const [tick, setTick] = useState(0);
  const overview = useApi<DistributionOverview>(`/api/sites/${siteId}/distribution`, { version: `${version}:${tick}` });
  const [busy, setBusy] = useState<string | null>(null);
  const [urls, setUrls] = useState("");
  const refresh = () => setTick((t) => t + 1);

  async function act<T>(name: string, fn: () => Promise<T>, success: (r: T) => string) {
    setBusy(name);
    try {
      const r = await fn();
      toast.push("success", success(r));
      refresh();
    } catch (err) {
      toast.push("error", errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  const patch = (body: Record<string, unknown>) =>
    act("settings", () => apiFetch(`/api/sites/${siteId}/distribution`, { method: "PATCH", json: body }), () => "Dağıtım ayarları kaydedildi.");

  if (overview.loading)
    return (
      <div className="grid gap-4 lg:grid-cols-3">
        <SkeletonCard lines={5} />
        <SkeletonCard lines={5} />
        <SkeletonCard lines={5} />
        <SkeletonCard lines={8} className="lg:col-span-3" />
      </div>
    );
  if (overview.error) return <ErrorState error={overview.error} onRetry={() => void overview.reload()} />;
  const o = overview.data!;
  const r = o.readiness;
  const queue = (o.queue && typeof o.queue === "object" ? o.queue : {}) as Record<string, Record<string, number>>;
  const pending = Object.values(queue).reduce((sum, s) => sum + (s.pending ?? 0) + (s.failed ?? 0), 0);
  const key = r.indexnow.keyFile as KeyFile | null;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="IndexNow" subtitle="Bing, Yandex, Seznam, Naver… (ChatGPT araması Bing dizinini kullanır)" action={<Toggle label="IndexNow kanalı" checked={r.indexnow.enabled} disabled={busy === "settings"} onChange={(v) => void patch({ channels: { indexnow: v } })} />}>
          <ul className="space-y-2">
            <ReadyRow ok={r.indexnow.keyConfigured} label={r.indexnow.keyConfigured ? "Anahtar tanımlı" : "Anahtar yok"}>
              {key && <span className="break-all font-mono">{String(key.keyLocation ?? "")}</span>}
            </ReadyRow>
          </ul>
          <div className="mt-4 flex flex-wrap gap-2">
            {!r.indexnow.keyConfigured ? (
              <Button size="sm" variant="primary" loading={busy === "key"} onClick={() => void act("key", () => apiFetch(`/api/sites/${siteId}/distribution/indexnow-key`, { method: "POST", json: {} }), () => "IndexNow anahtarı oluşturuldu. Dosyayı sitenizin köküne yükleyin.")}>
                Anahtar oluştur
              </Button>
            ) : (
              <>
                {key && (
                  <Button size="sm" onClick={() => downloadText(key.fileContent, key.fileName)}>
                    ⬇ Anahtar dosyası
                  </Button>
                )}
                <Button
                  size="sm"
                  loading={busy === "verify"}
                  onClick={() =>
                    void act(
                      "verify",
                      () => apiFetch<{ valid: boolean; reason: string | null }>(`/api/sites/${siteId}/distribution/indexnow-key/verify`, { method: "POST" }),
                      (res) => (res.valid ? "Anahtar dosyası doğrulandı ✓" : `Doğrulanamadı: ${res.reason ?? "bilinmeyen"}`),
                    )
                  }
                >
                  Doğrula
                </Button>
              </>
            )}
          </div>
        </Card>
        <Card title="Google" subtitle="Search Console sitemap gönderimi ve Indexing API">
          <ul className="space-y-3">
            <li className="flex items-center justify-between gap-3">
              <ReadyRow ok={r.googleSearchConsole.serviceAccount} label="Search Console">
                {r.googleSearchConsole.serviceAccount ? "Servis hesabı tanımlı" : "Servis hesabı gerekli"}
              </ReadyRow>
              <Toggle label="Search Console kanalı" checked={r.googleSearchConsole.enabled} disabled={busy === "settings"} onChange={(v) => void patch({ channels: { googleSearchConsole: v } })} />
            </li>
            <li className="flex items-center justify-between gap-3">
              <ReadyRow ok={r.googleIndexingApi.serviceAccount} label="Indexing API">
                Yalnızca JobPosting / BroadcastEvent için resmi destek
              </ReadyRow>
              <Toggle label="Indexing API kanalı" checked={r.googleIndexingApi.enabled} disabled={busy === "settings"} onChange={(v) => void patch({ channels: { googleIndexingApi: v } })} />
            </li>
          </ul>
        </Card>
        <Card title="Otomasyon" subtitle="Analiz sonrası değişen URL’leri otomatik bildir">
          <ul className="space-y-3">
            <li className="flex items-center justify-between gap-3 text-sm">
              <span>Dağıtım motoru</span>
              <Toggle label="Dağıtım motoru" checked={o.settings.enabled} disabled={busy === "settings"} onChange={(v) => void patch({ enabled: v })} />
            </li>
            <li className="flex items-center justify-between gap-3 text-sm">
              <span>Analizden sonra otomatik gönder</span>
              <Toggle label="Otomatik gönderim" checked={o.settings.autoDispatch} disabled={busy === "settings"} onChange={(v) => void patch({ autoDispatch: v })} />
            </li>
            <ReadyRow ok={r.webhooks.count > 0} label={`${r.webhooks.count} webhook`}>
              {r.webhooks.count ? (r.webhooks.signed ? "İmzalı (HMAC)" : "İmzasız") : "AI besleyici webhook’u tanımlı değil"}
            </ReadyRow>
          </ul>
        </Card>
      </div>

      <Card
        title="Bildirim kuyruğu"
        subtitle={pending ? `${pending} URL gönderilmeyi bekliyor` : "Bekleyen URL yok"}
        action={
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              loading={busy === "sync"}
              onClick={() =>
                void act(
                  "sync",
                  () => apiFetch<{ created: number; updated: number; deleted: number }>(`/api/sites/${siteId}/distribution/sync`, { method: "POST", json: { mode: "notify" } }),
                  (s) => `Senkronize edildi: ${s.created} yeni, ${s.updated} güncel, ${s.deleted} silinen URL kuyruğa alındı.`,
                )
              }
            >
              Taramayla senkronize et
            </Button>
            <Button
              size="sm"
              variant="primary"
              loading={busy === "dispatch"}
              onClick={() =>
                void act(
                  "dispatch",
                  () => apiFetch<{ claimed: number }>(`/api/sites/${siteId}/distribution/dispatch`, { method: "POST", json: {} }),
                  (d) => (d.claimed ? `${d.claimed} URL bildirimi gönderildi.` : "Gönderilecek bekleyen URL yok."),
                )
              }
            >
              ⚡ IndexNow bildirimini tetikle
            </Button>
          </div>
        }
      >
        <div className="grid gap-5 lg:grid-cols-2">
          <div>
            {Object.keys(queue).length ? (
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-zinc-500">
                  <tr>
                    <th className="py-1.5 pr-3 font-medium">Kanal</th>
                    {Object.keys(QUEUE_STATUS_LABELS).map((s) => (
                      <th key={s} className="py-1.5 pr-2 text-right font-medium">
                        {QUEUE_STATUS_LABELS[s]}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="tabular-nums">
                  {Object.entries(queue).map(([ch, stats]) => (
                    <tr key={ch} className="border-t border-zinc-100 dark:border-zinc-800">
                      <td className="py-1.5 pr-3">{CHANNEL_LABELS[ch] ?? ch}</td>
                      {Object.keys(QUEUE_STATUS_LABELS).map((s) => (
                        <td key={s} className={cx("py-1.5 pr-2 text-right", s === "failed" && !!stats[s] && "text-red-600 dark:text-red-400")}>
                          {stats[s] ?? 0}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-sm text-zinc-500">Kuyruk boş. Analiz tamamlandığında değişen sayfalar otomatik olarak buraya eklenir.</p>
            )}
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const list = urls
                .split(/\s+/)
                .map((u) => u.trim())
                .filter(Boolean);
              if (!list.length) return;
              void act(
                "enqueue",
                () => apiFetch<{ accepted: number; rejected: string[] }>(`/api/sites/${siteId}/distribution/queue`, { method: "POST", json: { urls: list, reason: "updated" } }),
                (res) => {
                  setUrls("");
                  return `${res.accepted} URL kuyruğa eklendi${res.rejected?.length ? `, ${res.rejected.length} URL reddedildi (farklı alan adı)` : ""}.`;
                },
              );
            }}
          >
            <label className="text-xs font-medium uppercase tracking-wide text-zinc-500" htmlFor="enqueue-urls">
              URL’leri elle bildir
            </label>
            <textarea id="enqueue-urls" rows={3} value={urls} onChange={(e) => setUrls(e.target.value)} placeholder={`${site.url}/yeni-urun\n${site.url}/kampanya`} className={`${inputClass} mt-1 font-mono text-xs`} />
            <Button type="submit" size="sm" className="mt-2" loading={busy === "enqueue"} disabled={!urls.trim()}>
              Kuyruğa ekle
            </Button>
          </form>
        </div>
      </Card>

      <div className="grid gap-4 xl:grid-cols-5">
        <div className="xl:col-span-3">
          <LlmsPreview siteId={siteId} outputs={o.outputs} siteUrl={site.url} />
        </div>
        <Card title="Bildirim geçmişi" subtitle="Son 20 gönderim" className="xl:col-span-2">
          {o.recentSubmissions.length ? (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {o.recentSubmissions.map((s) => (
                <li key={s.id} className="flex items-start gap-3 py-2 text-sm">
                  <Badge tone={s.status === "sent" ? "good" : s.status === "failed" ? "critical" : "neutral"} icon>
                    {s.status === "sent" ? "Gönderildi" : s.status === "failed" ? "Hata" : "Kuyrukta"}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">
                      {PLATFORM_LABELS[s.platform] ?? s.platform} <span className="font-normal text-zinc-500">· {s.urlCount} URL</span>
                    </div>
                    {submissionDetail(s) && <div className="truncate text-xs text-zinc-500">{submissionDetail(s)}</div>}
                  </div>
                  <span className="whitespace-nowrap text-xs text-zinc-400" title={formatDate(s.createdAt)}>
                    {timeAgo(s.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon="📭" title="Henüz gönderim yok" className="py-6">
              “IndexNow bildirimini tetikle” ile bekleyen URL’leri gönderin.
            </EmptyState>
          )}
          <div className="mt-4 border-t border-zinc-100 pt-3 dark:border-zinc-800">
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">AI çıktıları</div>
            <ul className="space-y-1 text-sm">
              {Object.entries(o.outputs).map(([name, out]) => (
                <li key={name} className="flex items-center justify-between gap-2">
                  <span>{OUTPUT_LABELS[name] ?? name}</span>
                  <a href={out.api} target="_blank" rel="noopener noreferrer" className="font-mono text-xs text-indigo-600 hover:underline dark:text-indigo-400">
                    {out.publicPath} ↗
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </Card>
      </div>
    </div>
  );
}
