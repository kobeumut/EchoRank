import { describe, expect, it } from "vitest";
import { botVerdict, buildAllowRule, crawlersFor, formatMs, formatTokens, statusMix, type BotSummary } from "@/lib/dashboard/bot-diagnostics";

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
    expect([formatMs(342.4), formatMs(1540), formatMs(15_400), formatMs(null)]).toEqual(["342 ms", "1.5 sn", "15 sn", "—"]);
    expect([formatTokens(950), formatTokens(1540), formatTokens(25_000), formatTokens(2_300_000)]).toEqual(["950", "1.5K", "25K", "2.3M"]);
  });
});

describe("buildAllowRule", () => {
  it("maps robots-only tokens to their fetcher and drops unsafe names", () => {
    expect(crawlersFor(["GPTBot", "Google-Extended", "Applebot-Extended", "bad name\"; drop"])).toEqual(["GPTBot", "Googlebot", "Applebot"]);
  });
  it("builds a Cloudflare skip expression for the selected bots", () => {
    const r = buildAllowRule("cloudflare", ["GPTBot", "ClaudeBot"])!;
    expect(r.code).toContain('(http.user_agent contains "GPTBot") or (http.user_agent contains "ClaudeBot")');
    expect(r.code).toContain("cf.verified_bot_category");
    expect(r.code).not.toContain("PerplexityBot");
  });
  it("escapes regex in nginx / apache rules and keeps robots tokens", () => {
    expect(buildAllowRule("nginx", ["OAI-SearchBot", "Google-Extended"])!.code).toContain('"~*(OAI-SearchBot|Googlebot)" 1;');
    expect(buildAllowRule("apache", ["ClaudeBot"])!.code).toContain('SetEnvIfNoCase User-Agent "(ClaudeBot)" ai_bot');
    expect(buildAllowRule("robots", ["GPTBot", "Google-Extended"])!.code).toBe("User-agent: GPTBot\nAllow: /\n\nUser-agent: Google-Extended\nAllow: /");
    expect(buildAllowRule("cloudflare", [])).toBeNull();
  });
});
