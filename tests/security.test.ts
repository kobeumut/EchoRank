import { afterEach, describe, expect, it, vi } from "vitest";
import { errorResponse, HttpError } from "@/lib/http";
import { FailureLimiter } from "@/lib/rate-limit";
import { assertPublicHttpUrl, fetchPublic, isPrivateAddress, isPrivateHostname } from "@/lib/distribution/net";
import { tokenUriFor } from "@/lib/distribution/google";
import { serializeSchedule } from "@/lib/services/reports";
import { maskSecret } from "@/lib/services/sites";
import { normalizeSiteUrl } from "@/lib/url";
import { Prisma } from "@prisma/client";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("SSRF guards", () => {
  it("classifies private, reserved and IPv4-mapped addresses", () => {
    for (const ip of [
      "127.0.0.1", "10.1.2.3", "172.31.255.255", "192.168.0.10", "169.254.169.254", "100.64.0.1", "0.0.0.0", "192.0.0.8", "198.18.0.1",
      "224.0.0.1", "255.255.255.255", "::", "::1", "fc00::1", "fd12::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a00:1", "64:ff9b::7f00:1",
    ]) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) expect(isPrivateAddress(ip), ip).toBe(false);
    expect(isPrivateAddress("not-an-ip")).toBe(true); // fail closed
  });

  it("recognises internal host names without DNS", () => {
    for (const host of ["localhost", "LOCALHOST.", "api.localhost", "printer.local", "db.internal", "[::1]", "127.0.0.1", "169.254.169.254"]) {
      expect(isPrivateHostname(host), host).toBe(true);
    }
    for (const host of ["example.com", "shop.example.co.uk", "8.8.8.8"]) expect(isPrivateHostname(host), host).toBe(false);
  });

  it("assertPublicHttpUrl rejects credentials, odd schemes and internal targets", async () => {
    await expect(assertPublicHttpUrl("https://user:pw@8.8.8.8/")).rejects.toThrow("credentials");
    await expect(assertPublicHttpUrl("file:///etc/passwd")).rejects.toThrow("http(s)");
    await expect(assertPublicHttpUrl("http://[::ffff:7f00:1]/")).rejects.toThrow("private network");
    await expect(assertPublicHttpUrl("http://2130706433/")).rejects.toThrow("private network"); // decimal form of 127.0.0.1
    await expect(assertPublicHttpUrl("https://8.8.8.8/")).resolves.toBeInstanceOf(URL);
  });

  it("fetchPublic re-validates every redirect hop", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(url);
      return url === "https://8.8.8.8/start"
        ? new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data" } })
        : new Response("secret", { status: 200 });
    }));
    await expect(fetchPublic("https://8.8.8.8/start")).rejects.toThrow("private network");
    expect(calls).toEqual(["https://8.8.8.8/start"]); // the internal hop is never requested
  });

  it("fetchPublic follows public redirects, reports the final URL and caps the hop count", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url.endsWith("/a") ? new Response(null, { status: 301, headers: { location: "/b" } }) : new Response("ok", { status: 200 })));
    const res = await fetchPublic("https://8.8.8.8/a");
    expect(res.status).toBe(200);
    expect(res.url).toBe("https://8.8.8.8/b");

    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 302, headers: { location: "/loop" } })));
    await expect(fetchPublic("https://8.8.8.8/loop")).rejects.toThrow(/redirects/i);
  });

  it("site URLs may not point at internal hosts unless explicitly allowed for development", () => {
    for (const url of ["http://localhost:3000", "https://127.0.0.1", "http://169.254.169.254/latest", "http://[::1]/", "https://intranet.internal", "https://user:pw@example.com"]) {
      expect(() => normalizeSiteUrl(url), url).toThrow();
    }
    expect(normalizeSiteUrl("Example.com/shop?x=1")).toBe("https://example.com");
    vi.stubEnv("ALLOW_PRIVATE_NETWORK_TARGETS", "true");
    expect(normalizeSiteUrl("http://localhost:3000")).toBe("http://localhost:3000");
  });

  it("only honours Google's own HTTPS token endpoints from service-account files", () => {
    const sa = (token_uri?: string) => ({ client_email: "a@b.iam.gserviceaccount.com", private_key: "k", token_uri });
    expect(tokenUriFor(sa())).toBe("https://oauth2.googleapis.com/token");
    expect(tokenUriFor(sa("https://oauth2.googleapis.com/token"))).toBe("https://oauth2.googleapis.com/token");
    for (const evil of ["http://oauth2.googleapis.com/token", "https://evil.example/token", "https://googleapis.com.evil.example/token", "http://169.254.169.254/", "nonsense"]) {
      expect(tokenUriFor(sa(evil)), evil).toBe("https://oauth2.googleapis.com/token");
    }
  });
});

describe("secret handling", () => {
  it("masks stored integration secrets down to a short tail", () => {
    expect(maskSecret("abcdefghijklmnop1234")).toBe("…1234");
    expect(maskSecret("short-secret")).toBe("••••");
    expect(maskSecret('{"private_key":"-----BEGIN PRIVATE KEY-----..."}')).toBe("••••");
    expect(maskSecret("abcdefghijklmnop1234")).not.toContain("abcd");
  });

  it("returns only the origin of webhook URLs and hides worker claims", () => {
    const view = serializeSchedule({ id: "s1", webhookUrl: "https://hooks.slack.com/services/T000/B000/XXXXSECRET", claimId: "claim-1", frequency: "daily" });
    expect(JSON.stringify(view)).not.toContain("XXXXSECRET");
    expect(JSON.stringify(view)).not.toContain("claim-1");
    expect(view).toMatchObject({ webhookUrl: "https://hooks.slack.com/…", running: true });
    expect(serializeSchedule({ webhookUrl: null, claimId: null })).toMatchObject({ webhookUrl: null, running: false });
  });

  it("does not echo Prisma metadata or log query arguments", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const err = new Prisma.PrismaClientKnownRequestError("Invalid `prisma.site.create()` invocation: integrations: { indexnow: 'TOPSECRET' }", {
      code: "P2002", clientVersion: "test", meta: { target: ["url"], secret: "TOPSECRET" },
    });
    const res = errorResponse(err);
    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).not.toContain("TOPSECRET");
    const other = errorResponse(new Prisma.PrismaClientKnownRequestError("with TOPSECRET arguments", { code: "P2003", clientVersion: "test" }));
    expect(other.status).toBe(500);
    expect(JSON.stringify(spy.mock.calls)).not.toContain("TOPSECRET");
    spy.mockRestore();
    expect(errorResponse(new HttpError(418, "teapot")).status).toBe(418);
  });
});

describe("FailureLimiter", () => {
  it("blocks after the maximum number of failures and reopens when the window passes", () => {
    const limiter = new FailureLimiter(3, 60_000);
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) {
      expect(limiter.retryAfter("ip", t0)).toBe(0);
      limiter.fail("ip", t0);
    }
    expect(limiter.retryAfter("ip", t0 + 1_000)).toBe(59);
    expect(limiter.retryAfter("other", t0)).toBe(0);
    expect(limiter.retryAfter("ip", t0 + 61_000)).toBe(0);
    limiter.fail("ip", t0 + 61_000);
    limiter.reset("ip");
    expect(limiter.retryAfter("ip", t0 + 61_000)).toBe(0);
  });
});
