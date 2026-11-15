import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Markdown } from "@/components/dashboard/markdown";
import { getMessages } from "@/lib/i18n/messages";
import { I18nProvider } from "@/lib/i18n/provider";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));

// Fenced code goes through the dashboard CodeBlock, which reads the locale: Turkish keeps the "Kopyala" assertion below.
const render = (text: string, tone: "default" | "inverse" = "default") =>
  renderToStaticMarkup(
    <I18nProvider locale="tr" messages={getMessages("tr")}>
      <Markdown text={text} tone={tone} />
    </I18nProvider>,
  );

describe("chat Markdown", () => {
  it("renders headings, emphasis, nested lists, quotes, rules and fenced code", () => {
    const html = render("## Özet\n**Kalın** ve *italik* ~~eski~~ `kod`\n\n- bir\n  - iç\n1. a\n\n> alıntı\n\n---\n\n```json\n{\"a\":1}\n```");
    expect(html).toContain("Özet</p>");
    expect(html).toMatch(/<strong[^>]*>Kalın<\/strong>/);
    expect(html).toContain("<em>italik</em>");
    expect(html).toContain("<del>eski</del>");
    expect(html).toMatch(/<code[^>]*>kod<\/code>/);
    expect(html).toMatch(/<ul[^>]*>\s*<li[^>]*>bir\s*<ul/);
    expect(html).toMatch(/<ol[^>]*>/);
    expect(html).toMatch(/<blockquote[^>]*>/);
    expect(html).toContain("<hr");
    // Fenced code goes through the dashboard CodeBlock (language label + copy button).
    expect(html).toContain("json");
    expect(html).toContain("{&quot;a&quot;:1}");
    expect(html).toContain("Kopyala");
  });

  it("renders GFM tables and task lists", () => {
    const html = render("| Sayfa | Skor |\n| --- | --: |\n| /a | 48 |\n\n- [x] robots.txt\n- [ ] llms.txt");
    expect(html).toMatch(/<table[^>]*>/);
    expect(html).toMatch(/<th[^>]*>Sayfa<\/th>/);
    expect(html).toMatch(/<td style="text-align:right"[^>]*>48<\/td>/);
    expect(html).toMatch(/<input type="checkbox"[^>]*checked=""[^>]*\/?>/);
  });

  it("links safely, never renders raw HTML, and turns images into links", () => {
    const html = render("[şema](https://schema.org/x) https://a.test/p [x](javascript:alert(1)) <script>alert(1)</script><b>raw</b> ![logo](https://cdn.test/l.png)");
    expect(html).toContain('href="https://schema.org/x"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    expect(html).toContain('href="https://a.test/p"');
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<b>");
    expect(html).not.toContain("<img");
    expect(html).toMatch(/<a href="https:\/\/cdn\.test\/l\.png"[^>]*>logo<\/a>/);
  });

  it("styles the user's own bubble for white-on-indigo", () => {
    expect(render("**soru** `x`", "inverse")).toContain("bg-white/20");
  });
});
