// Pure helpers for the AI crawler diagnostic center: per-bot verdicts from `/simulation/bots` summaries and
// copy-paste WAF / web-server allow rules. No server imports — used by the client dashboard and the tests.

export type BotSummary = {
  botName: string;
  checked: number;
  blocked: number;
  csrShells: number;
  ok: number;
  avgTokens: number;
  avgLoadTimeMs: number;
  blockedBy: (string | null)[];
};

export type BotRecord = {
  id: string;
  url: string;
  botName: string;
  statusCode: number | null;
  isBlocked: boolean;
  blockedBy: string | null;
  isCsrShell: boolean;
  tokenCount: number;
  bytes: number;
  loadTimeMs: number;
  headers?: unknown;
  diagnostics?: unknown;
  checkedAt?: string;
};

export type Verdict = "allowed" | "blocked" | "shell" | "error" | "unknown";

/** Bots that get a status card, in display order (Applebot-Extended / OAI-SearchBot appear when simulated). */
export const DIAGNOSTIC_BOTS = ["GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended"] as const;

export const BOT_META: Record<string, { vendor: string; crawler: string; note?: string }> = {
  GPTBot: { vendor: "OpenAI", crawler: "GPTBot" },
  "OAI-SearchBot": { vendor: "OpenAI", crawler: "OAI-SearchBot" },
  ClaudeBot: { vendor: "Anthropic", crawler: "ClaudeBot" },
  PerplexityBot: { vendor: "Perplexity", crawler: "PerplexityBot" },
  "Google-Extended": { vendor: "Google", crawler: "Googlebot", note: "robots.txt jetonu; istek Googlebot kimliğiyle yapılır" },
  "Applebot-Extended": { vendor: "Apple", crawler: "Applebot", note: "robots.txt jetonu; istek Applebot kimliğiyle yapılır" },
};

export const VENDOR_LABELS: Record<string, string> = {
  cloudflare: "Cloudflare",
  imperva: "Imperva",
  akamai: "Akamai",
  aws_waf: "AWS WAF",
  sucuri: "Sucuri",
  datadome: "DataDome",
  captcha: "CAPTCHA",
  http_status: "HTTP durum kodu",
  network: "Ağ / zaman aşımı",
};

export const VERDICT_LABELS: Record<Verdict, string> = {
  allowed: "İzinli · 200 OK",
  blocked: "WAF Engeli / 403",
  shell: "JS Shell · Yetersiz Render",
  error: "HTTP hatası",
  unknown: "Test edilmedi",
};

/** Worst outcome wins: any block → red, any empty CSR shell → yellow, every URL served → green. */
export function botVerdict(s: BotSummary | null | undefined): Verdict {
  if (!s || !s.checked) return "unknown";
  if (s.blocked > 0) return "blocked";
  if (s.csrShells > 0) return "shell";
  if (s.ok === s.checked) return "allowed";
  return "error";
}

/** Status codes seen per bot, e.g. "200 ×4, 404" (null = no response). */
export function statusMix(records: Pick<BotRecord, "statusCode">[]): string {
  const counts = new Map<string, number>();
  for (const r of records) {
    const k = r.statusCode === null ? "—" : String(r.statusCode);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, n]) => (n > 1 ? `${k} ×${n}` : k))
    .join(", ");
}

export function formatMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} sn` : `${Math.round(ms)} ms`;
}

export function formatTokens(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}K`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(Math.round(n));
}

// ---------------------------------------------------------------- WAF / server allow rules

export const RULE_PLATFORMS = ["cloudflare", "nginx", "apache", "robots"] as const;
export type RulePlatform = (typeof RULE_PLATFORMS)[number];
export const RULE_PLATFORM_LABELS: Record<RulePlatform, string> = {
  cloudflare: "Cloudflare WAF",
  nginx: "nginx",
  apache: "Apache / .htaccess",
  robots: "robots.txt",
};

const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Crawler names inside the User-Agent (robots-only tokens map to their fetcher), de-duplicated, stable order. */
export function crawlersFor(bots: string[]): string[] {
  return [...new Set(bots.map((b) => BOT_META[b]?.crawler ?? b).filter((b) => /^[\w.-]+$/.test(b)))];
}

export type GeneratedRule = { language: string; filename: string; code: string; steps: string[] };

/** Copy-paste allow rule for the given bots on one platform. Returns null when no bot is selected. */
export function buildAllowRule(platform: RulePlatform, bots: string[]): GeneratedRule | null {
  const crawlers = crawlersFor(bots);
  if (!crawlers.length) return null;
  const alt = crawlers.map(escapeRx).join("|");
  switch (platform) {
    case "cloudflare": {
      const expr = `${crawlers.map((c) => `(http.user_agent contains "${c}")`).join(" or ")} or (cf.verified_bot_category in {"AI Crawler" "AI Search" "AI Assistant"})`;
      return {
        language: "text",
        filename: "cloudflare-ai-allow.txt",
        code: `# Rule name: Allow AI crawlers (GEO)
# Expression (Edit expression):
${expr}

# Action: Skip → All remaining custom rules, Rate limiting rules,
#         Managed rules, Super Bot Fight Mode rules  (+ Log matching requests)`,
        steps: [
          "Security → WAF → Custom rules → Create rule.",
          "İfadeyi 'Edit expression' alanına yapıştırın, Action = Skip seçin.",
          "Kuralı listenin EN ÜSTÜNE taşıyın; Security → Bots → 'Block AI bots' = Off.",
          "Ücretsiz plandaki Bot Fight Mode Skip ile atlanamaz — gerekirse kapatın.",
        ],
      };
    }
    case "nginx":
      return {
        language: "nginx",
        filename: "ai-bots.conf",
        code: `# http { } — /etc/nginx/conf.d/ai-bots.conf
map $http_user_agent $is_ai_bot {
    default 0;
    "~*(${alt})" 1;
}
# AI botları için boş anahtar = rate limit uygulanmaz
map $is_ai_bot $ai_limit_key {
    0 $binary_remote_addr;
    1 "";
}
limit_req_zone $ai_limit_key zone=perip:10m rate=10r/s;

# server { } — mevcut UA engelinizi AI botları dışında bırakın
set $block_ua 0;
if ($http_user_agent ~* "(bot|crawl|spider|scrape)") { set $block_ua 1; }
if ($is_ai_bot = 1) { set $block_ua 0; }
if ($block_ua = 1) { return 403; }`,
        steps: ["Dosyayı conf.d altına kaydedin, mevcut deny / limit_req kurallarınızı bu değişkenlerle koşullandırın.", "`nginx -t && nginx -s reload` çalıştırın."],
      };
    case "apache":
      return {
        language: "apache",
        filename: ".htaccess",
        code: `# AI botlarını işaretle
SetEnvIfNoCase User-Agent "(${alt})" ai_bot

# Bot engelleyen RewriteRule'lara istisna
RewriteEngine On
RewriteCond %{ENV:ai_bot} !^1$
RewriteCond %{HTTP_USER_AGENT} (bot|crawl|spider|scrape) [NC]
RewriteRule .* - [F,L]

# ModSecurity / OWASP CRS tarayıcı tespitinden muaf tut
<IfModule mod_security2.c>
    SecRule REQUEST_HEADERS:User-Agent "@rx (?i)(${alt})" \\
        "id:1009001,phase:1,pass,nolog,ctl:ruleRemoveByTag=attack-reputation-scanner"
</IfModule>`,
        steps: ["Kuralları .htaccess veya <VirtualHost> içine ekleyin.", "`apachectl configtest && apachectl graceful` çalıştırın."],
      };
    case "robots": {
      // robots.txt uses the product tokens (Google-Extended), not the fetcher names.
      const tokens = [...new Set(bots.filter((b) => /^[\w.-]+$/.test(b)))];
      return {
        language: "text",
        filename: "robots.txt",
        code: tokens.map((t) => `User-agent: ${t}\nAllow: /`).join("\n\n"),
        steps: ["robots.txt izni WAF engelini aşmaz; önce WAF kuralını uygulayın.", "Daha kısıtlayıcı bir `User-agent: *` grubunuz varsa bu grupları onun ÜSTÜNE ekleyin."],
      };
    }
  }
}

