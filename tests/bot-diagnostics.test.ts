import { describe, expect, it } from "vitest";
import { botVerdict, buildAllowRule, crawlersFor, formatMs, formatTokens, statusMix, vendorLabel, verdictLabel, type BotSummary } from "@/lib/dashboard/bot-diagnostics";
import { getMessages } from "@/lib/i18n/messages";
import { createTranslator } from "@/lib/i18n/translate";

const tEn = createTranslator(getMessages("en"), "en");
const tTr = createTranslator(getMessages("tr"), "tr", getMessages("en"));

const base: BotSummary = { botName: "GPTBot", checked: 3, blocked: 0, csrShells: 0, ok: 3, avgTokens: 1200, avgLoadTimeMs: 340, blockedBy: [] };

describe("botVerdict", () => {
  it("ranks block > CSR shell > http error > ok", () => {
    expect(botVerdict(undefined)).toBe("unknown");
    expect(botVerdict({ ...base, checked: 0, ok: 0 })).toBe("unknown");
    expect(botVerdict(base)).toBe("allowed");
    expect(botVerdict({ ...base, ok: 2, csrShells: 1 })).toBe("shell");
    expect(botVerdict({ ...base, ok: 1, csrShells: 1, blocked: 1, blockedBy: ["cloudflare"] })).toBe("blocked");
    expect(botVerdict({ ...base, ok: 2 })).toBe("error");
  });
});

describe("formatting", () => {
  it("summarises status codes, durations and token counts", () => {
    expect(statusMix([{ statusCode: 200 }, { statusCode: 200 }, { statusCode: 404 }, { statusCode: null }])).toBe("200 ×2, —, 404");
    expect([formatMs(342.4, tEn), formatMs(1540, tEn), formatMs(15_400, tEn), formatMs(null, tEn)]).toEqual(["342 ms", "1.5 s", "15 s", "—"]);
    expect([formatMs(1540, tTr), formatMs(15_400, tTr)]).toEqual(["1.5 sn", "15 sn"]);
    expect([formatTokens(950), formatTokens(1540), formatTokens(25_000), formatTokens(2_300_000)]).toEqual(["950", "1.5K", "25K", "2.3M"]);
  });
});

describe("labels", () => {
  it("localises verdicts and vendor names, keeping product names and unknown values as-is", () => {
    expect(verdictLabel(tEn, "blocked")).toBe("WAF block / 403");
    expect(verdictLabel(tTr, "blocked")).toBe("WAF Engeli / 403");
    expect(vendorLabel(tEn, "cloudflare")).toBe("Cloudflare");
    expect(vendorLabel(tEn, "network")).toBe("Network / timeout");
    expect(vendorLabel(tTr, "network")).toBe("Ağ / zaman aşımı");
    expect(vendorLabel(tEn, "some_new_waf")).toBe("some_new_waf");
  });
});

describe("buildAllowRule", () => {
  it("maps robots-only tokens to their fetcher and drops unsafe names", () => {
    expect(crawlersFor(["GPTBot", "Google-Extended", "Applebot-Extended", "bad name\"; drop"])).toEqual(["GPTBot", "Googlebot", "Applebot"]);
  });
  it("builds a Cloudflare skip expression for the selected bots", () => {
    const r = buildAllowRule("cloudflare", ["GPTBot", "ClaudeBot"], tEn)!;
    expect(r.code).toContain('(http.user_agent contains "GPTBot") or (http.user_agent contains "ClaudeBot")');
    expect(r.code).toContain("cf.verified_bot_category");
    expect(r.code).not.toContain("PerplexityBot");
  });
  it("escapes regex in nginx / apache rules and keeps robots tokens", () => {
    expect(buildAllowRule("nginx", ["OAI-SearchBot", "Google-Extended"], tEn)!.code).toContain('"~*(OAI-SearchBot|Googlebot)" 1;');
    expect(buildAllowRule("apache", ["ClaudeBot"], tEn)!.code).toContain('SetEnvIfNoCase User-Agent "(ClaudeBot)" ai_bot');
    expect(buildAllowRule("robots", ["GPTBot", "Google-Extended"], tEn)!.code).toBe("User-agent: GPTBot\nAllow: /\n\nUser-agent: Google-Extended\nAllow: /");
    expect(buildAllowRule("cloudflare", [], tEn)).toBeNull();
  });
  it("writes comments and setup steps in the requested language", () => {
    const en = buildAllowRule("nginx", ["GPTBot"], tEn)!;
    expect(en.code).toContain("# Empty key for AI bots = no rate limit applied");
    expect(en.steps).toEqual([
      "Save the file under conf.d and make your existing deny / limit_req rules conditional on these variables.",
      "Run `nginx -t && nginx -s reload`.",
    ]);
    const tr = buildAllowRule("nginx", ["GPTBot"], tTr)!;
    expect(tr.code).toContain("# AI botları için boş anahtar = rate limit uygulanmaz");
    expect(tr.steps[1]).toBe("`nginx -t && nginx -s reload` çalıştırın.");
    expect(buildAllowRule("cloudflare", ["GPTBot"], tEn)!.steps).toHaveLength(4);
    expect(buildAllowRule("apache", ["GPTBot"], tEn)!.steps[0]).toBe("Add the rules to .htaccess or inside <VirtualHost>.");
    expect(buildAllowRule("robots", ["GPTBot"], tEn)!.steps[0]).toBe("A robots.txt allow does not bypass a WAF block; apply the WAF rule first.");
  });
});
