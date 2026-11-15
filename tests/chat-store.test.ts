import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function memoryStorage() {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) };
}
const answer = { answer: "GEO skorunuz 48.", citations: [], provider: "claude", transport: "cli", modelId: "cli:claude", answeredAt: "2026-11-08T00:00:00Z" };

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("window", {});
  vi.stubGlobal("sessionStorage", memoryStorage());
  vi.stubGlobal("localStorage", memoryStorage());
});
afterEach(() => { vi.unstubAllGlobals(); });

const load = () => import("@/components/dashboard/chat-store");
const limits = { messages: 20, chars: 4000 };

describe("site assistant chat store", () => {
  it("keeps the question running outside the page, stores the answer and announces it", async () => {
    let resolve!: (r: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((r) => { resolve = r; }));
    vi.stubGlobal("fetch", fetchMock);
    const store = await load();
    const completions: unknown[] = [];
    store.onChatCompleted((c) => completions.push(c));

    const done = store.askChat("s1", "Acme", [{ role: "user", content: "GEO?" }], { provider: "claude", transport: "cli" }, limits);
    // A second question while one is pending is ignored.
    await store.askChat("s1", "Acme", [{ role: "user", content: "again" }], { provider: "claude", transport: "cli" }, limits);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.getChat("s1").pending).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/sites/s1/chat");
    expect(JSON.parse(String(init.body))).toEqual({ messages: [{ role: "user", content: "GEO?" }], provider: "claude", transport: "cli" });

    resolve(Response.json(answer));
    await done;
    expect(store.getChat("s1").pending).toBe(false);
    expect(completions).toEqual([{ siteId: "s1", siteTitle: "Acme", ok: true }]);
    const saved = JSON.parse(sessionStorage.getItem("aiv-chat:s1")!);
    expect(saved.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);
    expect(saved[1]).toMatchObject({ content: "GEO skorunuz 48.", meta: { provider: "claude", transport: "cli" } });

    // A fresh module (page reload) restores the conversation from sessionStorage.
    vi.resetModules();
    const reloaded = await load();
    expect(reloaded.getChat("s1").messages).toHaveLength(2);
  });

  it("reports failures, tracks the chat page on screen and remembers the model choice", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "The claude answer failed: timeout" }, { status: 504 })));
    const store = await load();
    const completions: { ok: boolean }[] = [];
    store.onChatCompleted((c) => completions.push(c));
    await store.askChat("s2", "Beta", [{ role: "user", content: "x" }], { provider: "claude", transport: "cli" }, limits);
    expect(completions).toEqual([{ siteId: "s2", siteTitle: "Beta", ok: false }]);
    expect(store.getChat("s2")).toMatchObject({ pending: false, messages: [{ role: "user", content: "x" }] });
    expect((store.getChat("s2").error as Error).message).toContain("timeout");

    store.setViewingChat("s2");
    expect(store.isViewingChat("s2")).toBe(true);
    expect(store.isViewingChat("s1")).toBe(false);

    expect(store.loadSelection()).toEqual({ transport: null, provider: null });
    store.saveSelection({ transport: "cli", provider: "chatgpt" });
    expect(store.loadSelection()).toEqual({ transport: "cli", provider: "chatgpt" });
    localStorage.setItem("aiv-chat-selection", JSON.stringify({ transport: "bogus", provider: 3 }));
    expect(store.loadSelection()).toEqual({ transport: null, provider: null });
  });
});
