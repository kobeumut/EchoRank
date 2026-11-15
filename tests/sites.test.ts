import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import * as sites from "@/app/api/sites/route";
import * as site from "@/app/api/sites/[id]/route";
import { normalizeSiteUrl } from "@/lib/url";
import { ctx, req, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(() => prisma.$disconnect());

describe("normalizeSiteUrl", () => {
  it("normalizes to origin and adds https", () => {
    expect(normalizeSiteUrl(" Example.com/shop?x=1 ")).toBe("https://example.com");
    expect(normalizeSiteUrl("http://www.Foo.com.tr:8080/a")).toBe("http://www.foo.com.tr:8080");
  });
  it("rejects invalid input", () => {
    expect(() => normalizeSiteUrl("ftp://foo.com")).toThrow();
    expect(() => normalizeSiteUrl("not a url")).toThrow();
    expect(() => normalizeSiteUrl("")).toThrow();
  });
});

describe("/api/sites CRUD", () => {
  it("creates, lists, reads, updates and deletes a site", async () => {
    const createRes = await sites.POST(
      req("/api/sites", {
        method: "POST",
        body: {
          url: "shop.example.com/products",
          targetKeywords: ["olive oil"],
          integrations: { indexnow: "abcdef1234567890" },
        },
      }),
      undefined as never,
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.url).toBe("https://shop.example.com");
    expect(created.title).toBe("shop.example.com");
    expect(created.integrations.indexnow).toBe("abcd…7890"); // masked

    const list = await (await sites.GET(req("/api/sites"), undefined as never)).json();
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({ id: created.id, latestAudit: null, openActionItems: 0 });

    const got = await site.GET(req(`/api/sites/${created.id}`), ctx(created.id));
    expect(got.status).toBe(200);

    const patched = await (
      await site.PATCH(
        req(`/api/sites/${created.id}`, {
          method: "PATCH",
          body: { title: "Shop", integrations: { indexnow: null, gsc: "token-xyz-123456" } },
        }),
        ctx(created.id),
      )
    ).json();
    expect(patched.title).toBe("Shop");
    expect(patched.integrations).toEqual({ gsc: "toke…3456" });
    // Raw secret stays intact in the DB.
    const raw = await prisma.site.findUniqueOrThrow({ where: { id: created.id } });
    expect(raw.integrations).toEqual({ gsc: "token-xyz-123456" });

    const del = await site.DELETE(req(`/api/sites/${created.id}`, { method: "DELETE" }), ctx(created.id));
    expect(del.status).toBe(204);
    expect((await site.GET(req(`/api/sites/${created.id}`), ctx(created.id))).status).toBe(404);
  });

  it("rejects duplicate URLs with 409", async () => {
    const body = { url: "https://dup.example.com" };
    expect((await sites.POST(req("/api/sites", { method: "POST", body }), undefined as never)).status).toBe(201);
    const res = await sites.POST(req("/api/sites", { method: "POST", body: { url: "DUP.example.com/x" } }), undefined as never);
    expect(res.status).toBe(409);
  });

  it("validates input", async () => {
    expect((await sites.POST(req("/api/sites", { method: "POST", body: { url: "javascript:alert(1)" } }), undefined as never)).status).toBe(400);
    expect((await sites.POST(req("/api/sites", { method: "POST", body: "{bad json" }), undefined as never)).status).toBe(400);
    expect((await sites.POST(req("/api/sites", { method: "POST" }), undefined as never)).status).toBe(400);
  });

  it("returns 404 for unknown ids and 400 for empty patch", async () => {
    expect((await site.PATCH(req("/api/sites/nope", { method: "PATCH", body: { title: "x" } }), ctx("nope"))).status).toBe(404);
    const s = await prisma.site.create({ data: { url: "https://e.example.com", title: "e" } });
    expect((await site.PATCH(req(`/api/sites/${s.id}`, { method: "PATCH", body: {} }), ctx(s.id))).status).toBe(400);
  });
});
