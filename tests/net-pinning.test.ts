import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent } from "undici";

// DNS is fully scripted: every test decides what each host name resolves to.
const dns = vi.hoisted(() => ({ answers: new Map<string, string[][]>(), calls: [] as string[] }));
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(async (host: string) => {
    dns.calls.push(host);
    const queue = dns.answers.get(host);
    if (!queue?.length) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
    const answer = queue.length > 1 ? queue.shift()! : queue[0];
    return answer.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  }),
}));

const { assertPublicHttpUrl, createGuardedLookup, fetchPublic, guardedLookup, pinnedFetch, publicDispatcher } = await import("@/lib/distribution/net");

let server: Server;
let port: number;
const seen: IncomingMessage[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push(req);
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/final" }).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" }).end(`host=${req.headers.host}`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  dns.answers.clear();
  dns.calls.length = 0;
  seen.length = 0;
});

afterEach(() => vi.unstubAllEnvs());

const lookupOnce = (host: string, options: { all?: boolean; family?: number }) =>
  new Promise<{ err: Error | null; address: unknown; family?: number }>((resolve) =>
    guardedLookup(host, options, (err, address, family) => resolve({ err, address, family })));

describe("guardedLookup (connect-time DNS check)", () => {
  it("hands the socket exactly the checked public addresses", async () => {
    dns.answers.set("shop.example.com", [["93.184.216.34", "2606:2800:220:1::248"]]);
    expect(await lookupOnce("shop.example.com", { all: true })).toMatchObject({
      err: null,
      address: [{ address: "93.184.216.34", family: 4 }, { address: "2606:2800:220:1::248", family: 6 }],
    });
    expect(await lookupOnce("shop.example.com", {})).toMatchObject({ err: null, address: "93.184.216.34", family: 4 });
    expect(await lookupOnce("shop.example.com", { family: 6 })).toMatchObject({ err: null, address: "2606:2800:220:1::248", family: 6 });
  });

  it("refuses private, mixed and internal-looking answers", async () => {
    dns.answers.set("meta.example.com", [["169.254.169.254"]]);
    dns.answers.set("mixed.example.com", [["93.184.216.34", "10.0.0.8"]]);
    for (const host of ["meta.example.com", "mixed.example.com", "db.internal", "localhost"]) {
      const { err } = await lookupOnce(host, { all: true });
      expect(err?.message, host).toMatch(/private network/);
    }
  });
});

describe("pinnedFetch / fetchPublic (DNS rebinding)", () => {
  it("never connects when the name resolves to an internal address at connect time", async () => {
    // A rebinding name: the first answer looks public, every later one points at the local server.
    dns.answers.set("rebind.example.com", [["93.184.216.34"], ["127.0.0.1"]]);
    await assertPublicHttpUrl(`http://rebind.example.com:${port}/`); // the pre-check sees the public answer...
    await expect(pinnedFetch(`http://rebind.example.com:${port}/`)).rejects.toThrow(/private network/);
    expect(seen).toHaveLength(0); // ...but the connection is checked against its own answer and never opened
  });

  it("connects to the address the guard checked, keeping the original Host header", async () => {
    // The name exists only in the scripted DNS; the loopback test server is treated as "public" for this dispatcher,
    // so the request can only arrive if the socket dials the address the guard resolved and checked.
    dns.answers.set("pinned.example.com", [["127.0.0.1"]]);
    const checked: string[] = [];
    const lookup = createGuardedLookup((address) => (checked.push(address), false));
    const agent = new Agent({ connect: { lookup: lookup as never } });
    const res = await fetch(`http://pinned.example.com:${port}/x`, { dispatcher: agent } as RequestInit);
    expect(await res.text()).toBe(`host=pinned.example.com:${port}`);
    expect(dns.calls).toEqual(["pinned.example.com"]); // resolved exactly once, by the guard
    expect(checked).toEqual(["127.0.0.1"]);
    await agent.close();
  });

  it("re-checks every redirect hop at connect time", async () => {
    dns.answers.set("hop.example.com", [["127.0.0.1"]]);
    await expect(fetchPublic(`http://hop.example.com:${port}/redirect`)).rejects.toThrow(/private network/);
    expect(seen).toHaveLength(0);
  });

  it("rejects IP literals and bad schemes before any DNS or socket work", async () => {
    await expect(pinnedFetch(`http://127.0.0.1:${port}/`)).rejects.toThrow(/private network/);
    await expect(pinnedFetch("http://[::ffff:7f00:1]/")).rejects.toThrow(/private network/);
    await expect(pinnedFetch("ftp://example.com/")).rejects.toThrow(/http\(s\)/);
    expect(dns.calls).toEqual([]);
    expect(seen).toHaveLength(0);
  });

  it("uses the normal dispatcher when private targets are explicitly allowed (development)", async () => {
    vi.stubEnv("ALLOW_PRIVATE_NETWORK_TARGETS", "true");
    expect(publicDispatcher()).toBeUndefined();
    const res = await fetchPublic(`http://127.0.0.1:${port}/redirect`);
    expect(res.status).toBe(200);
    expect(res.url).toBe(`http://127.0.0.1:${port}/final`);
    expect(seen.map((r) => r.url)).toEqual(["/redirect", "/final"]);
  });
});
