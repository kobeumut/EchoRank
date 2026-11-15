import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_LOCALE, LOCALES, negotiateLocale, resolveLocale } from "@/lib/i18n/config";
import { catalogs, en, getMessages } from "@/lib/i18n/messages";
import { localeFromRequest } from "@/lib/i18n/request";
import { createTranslator, translate } from "@/lib/i18n/translate";

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("message catalogs", () => {
  it("registers every supported locale", () => {
    expect(Object.keys(catalogs).sort()).toEqual([...LOCALES].sort());
    expect(DEFAULT_LOCALE).toBe("en");
  });

  for (const locale of LOCALES.filter((l) => l !== "en")) {
    it(`${locale} defines exactly the English keys`, () => {
      const keys = Object.keys(en).sort();
      expect(Object.keys(catalogs[locale]).sort()).toEqual(keys);
    });

    it(`${locale} keeps the {placeholders} of every English message`, () => {
      const bad = Object.entries(en).filter(([key, value]) => placeholders(value).join() !== placeholders(catalogs[locale][key] ?? "").join());
      expect(bad.map(([key]) => key)).toEqual([]);
    });

    it(`${locale} has no untranslated empty strings`, () => {
      expect(Object.entries(catalogs[locale]).filter(([, v]) => !v.trim()).map(([k]) => k)).toEqual([]);
    });
  }

  it("uses only keys that exist in the English catalog (literal t(\"…\") calls in src/)", () => {
    const known = new Set(Object.keys(en).map((k) => k.replace(/_(zero|one|two|few|many|other)$/, "")));
    const namespaces = new Set(Object.keys(en).map((k) => k.split(".")[0]));
    const missing: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const file = path.join(dir, name);
        if (statSync(file).isDirectory()) {
          if (!file.includes(path.join("i18n", "messages"))) walk(file);
        } else if (/\.(ts|tsx)$/.test(name)) {
          const source = readFileSync(file, "utf8");
          for (const m of source.matchAll(/\bt\(\s*["'`]([A-Za-z][\w]*(?:\.[\w]+)+)["'`]/g)) {
            if (namespaces.has(m[1].split(".")[0]) && !known.has(m[1])) missing.push(`${path.relative(process.cwd(), file)}: ${m[1]}`);
          }
        }
      }
    };
    walk(path.resolve(__dirname, "../src"));
    expect(missing).toEqual([]);
  });
});

describe("translate", () => {
  const messages = { "a.hello": "Hello {name}", "a.items_one": "{count} item", "a.items_other": "{count} items", "a.only": "fallback only" };

  it("interpolates parameters and leaves unknown placeholders intact", () => {
    expect(translate(messages, "a.hello", { name: "Ada" })).toBe("Hello Ada");
    expect(translate(messages, "a.hello")).toBe("Hello {name}");
  });

  it("selects plural variants from `count`", () => {
    expect(translate(messages, "a.items", { count: 1 })).toBe("1 item");
    expect(translate(messages, "a.items", { count: 3 })).toBe("3 items");
  });

  it("falls back to the fallback catalog and then to the key", () => {
    const t = createTranslator({}, "tr", messages);
    expect(t("a.only")).toBe("fallback only");
    expect(t("missing.key")).toBe("missing.key");
  });

  it("fills missing Turkish messages from English", () => {
    const merged = getMessages("tr");
    for (const key of Object.keys(en)) expect(merged[key]).toBeTruthy();
  });
});

describe("locale resolution", () => {
  it("negotiates Accept-Language by quality and supported locales", () => {
    expect(negotiateLocale("tr-TR,tr;q=0.9,en;q=0.8")).toBe("tr");
    expect(negotiateLocale("de;q=0.9, en;q=0.5")).toBe("en");
    expect(negotiateLocale("fr, de")).toBeNull();
    expect(negotiateLocale("en;q=0.2, tr;q=0.9")).toBe("tr");
    expect(negotiateLocale(null)).toBeNull();
  });

  it("prefers explicit choice, then Accept-Language, then English", () => {
    expect(resolveLocale({ cookie: "tr", acceptLanguage: "en" })).toBe("tr");
    expect(resolveLocale({ query: "en", cookie: "tr" })).toBe("en");
    expect(resolveLocale({ cookie: "xx", acceptLanguage: "tr" })).toBe("tr");
    expect(resolveLocale({})).toBe("en");
  });

  it("reads the locale of an API request (query → cookie → header → default)", () => {
    const req = (url: string, headers: Record<string, string> = {}) => new Request(`http://localhost${url}`, { headers });
    expect(localeFromRequest(req("/api/x?lang=tr"))).toBe("tr");
    expect(localeFromRequest(req("/api/x", { cookie: "theme=dark; locale=tr" }))).toBe("tr");
    expect(localeFromRequest(req("/api/x", { "accept-language": "tr-TR,tr;q=0.9" }))).toBe("tr");
    expect(localeFromRequest(req("/api/x"))).toBe("en");
  });
});
