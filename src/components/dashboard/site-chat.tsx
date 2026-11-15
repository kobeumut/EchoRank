"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { VISIBILITY_MODEL_ORDER } from "@/lib/dashboard/format";
import { errorMessage, useApi } from "./api";
import { askChat, clearChat, loadSelection, saveSelection, setViewingChat, useChat, type Message } from "./chat-store";
import { Markdown } from "./markdown";
import { useSite } from "./site-shell";
import type { ProviderStatus, TransportMode } from "./types";
import { Button, Card, CodeBlock, EmptyState, ErrorState, RichText, Segmented, SkeletonCard } from "./ui";
import { useFormat } from "./use-format";

type ChatOptions = { providers: ProviderStatus[]; defaultTransport: TransportMode; defaultProvider: string | null; enabled: boolean; apiAllowed?: boolean };

const SUGGESTION_KEYS = ["chat.suggestion.score", "chat.suggestion.actions", "chat.suggestion.bots", "chat.suggestion.visibility", "chat.suggestion.schema"];
const TRANSPORT_OPTIONS: { value: TransportMode; labelKey: string }[] = [
  { value: "auto", labelKey: "visibility.transport.auto" },
  { value: "api", labelKey: "visibility.transport.api" },
  { value: "cli", labelKey: "visibility.transport.cli" },
];
/** `{claude}` / `{codex}` / `{agy}` slots of the setup hints. */
const CLI_SLOTS = { claude: <code className="font-mono">claude</code>, codex: <code className="font-mono">codex</code>, agy: <code className="font-mono">agy</code> };
/** Mirrors the API limits: 20 messages, 4000 characters each. */
const MAX_MESSAGES = 20;
const MAX_CHARS = 4_000;

function Bubble({ message }: { message: Message }) {
  const { label } = useFormat();
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="min-w-0 max-w-[85%] rounded-2xl rounded-br-sm bg-indigo-600 px-4 py-2.5">
          <Markdown text={message.content} tone="inverse" />
        </div>
      </div>
    );
  }
  const meta = message.meta;
  return (
    <div className="flex justify-start">
      <div className="min-w-0 max-w-[92%] rounded-2xl rounded-bl-sm border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
        <Markdown text={message.content} />
        {meta && (
          <div className="mt-3 border-t border-zinc-100 pt-2 text-xs text-zinc-500 dark:border-zinc-800">
            {label("model", meta.provider)} · {meta.transport === "cli" ? "CLI" : "API"}
            {meta.citations.length > 0 && (
              <ul className="mt-1 space-y-0.5">
                {meta.citations.map((url) => (
                  <li key={url} className="truncate">
                    <a href={url} target="_blank" rel="noopener noreferrer nofollow" className="text-indigo-600 hover:underline dark:text-indigo-400">{url}</a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function McpCard() {
  const { t } = useFormat();
  const [origin, setOrigin] = useState("http://localhost:3000");
  // window is only known on the client; the server-rendered placeholder is replaced after mount.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setOrigin(window.location.origin), []);
  const url = `${origin}/api/mcp`;
  return (
    <Card title={t("chat.mcp.title")} subtitle={t("chat.mcp.subtitle")}>
      <div className="space-y-3 text-xs text-zinc-600 dark:text-zinc-400">
        <p>{t("chat.mcp.claude")}</p>
        <CodeBlock language="bash" code={`claude mcp add --transport http echorank ${url} \\\n  --header "Authorization: Bearer $API_TOKEN"`} />
        <p>{t("chat.mcp.codex")}</p>
        <CodeBlock language="bash" code={`export ECHORANK_TOKEN=<API_TOKEN>\ncodex mcp add echorank --url ${url} \\\n  --bearer-token-env-var ECHORANK_TOKEN`} />
        <p>
          <RichText
            message={t("chat.mcp.stdio")}
            slots={{ command: <code className="font-mono">npm --prefix &lt;project-dir&gt; run -s mcp</code>, docs: <code className="font-mono">docs/mcp.md</code> }}
          />
        </p>
      </div>
    </Card>
  );
}

export function SiteChat() {
  const { t, label } = useFormat();
  const { siteId, site } = useSite();
  const options = useApi<ChatOptions>(`/api/sites/${siteId}/chat`);
  // The conversation and any in-flight question live in chat-store, so they survive leaving this page.
  const { messages, pending, error } = useChat(siteId);
  const [input, setInput] = useState("");
  // The page renders only on the client (after SiteShell's fetch), so the stored choice can seed the state.
  const [selection, setSelection] = useState(loadSelection);
  const { transport, provider } = selection;
  const select = (next: Partial<typeof selection>) => {
    const merged = { ...selection, ...next };
    setSelection(merged);
    saveSelection(merged);
  };
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setViewingChat(siteId);
    return () => setViewingChat(null);
  }, [siteId]);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length, pending]);

  if (options.loading) return <SkeletonCard lines={6} />;
  if (options.error) return <ErrorState error={options.error} onRetry={() => void options.reload()} />;
  const opts = options.data!;
  if (!opts.enabled) {
    return (
      <EmptyState icon="💬" title={t("chat.disabled.title")}>
        <RichText message={t("chat.disabled.body")} slots={{ ...CLI_SLOTS, token: <code className="font-mono">API_TOKEN</code> }} />
      </EmptyState>
    );
  }

  const mode = transport ?? opts.defaultTransport;
  // Without API_TOKEN the server refuses API-key calls, so only CLI-backed models are offered.
  const available = VISIBILITY_MODEL_ORDER.filter((m) => {
    const via = opts.providers.find((p) => p.model === m)?.resolved[mode];
    return via === "cli" || (via === "api" && opts.apiAllowed !== false);
  });
  const chosen = provider && available.includes(provider as (typeof available)[number]) ? provider : (available.find((m) => m === opts.defaultProvider) ?? available[0] ?? null);

  function ask(history: Message[]) {
    if (!chosen) return;
    void askChat(siteId, site.title, history, { provider: chosen, transport: mode }, { messages: MAX_MESSAGES, chars: MAX_CHARS });
  }

  function send(text: string) {
    const content = text.trim();
    if (!content || pending || !chosen) return;
    setInput("");
    ask([...messages, { role: "user", content }]);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send(input);
    }
  }

  const lastIsUser = messages.at(-1)?.role === "user";
  let body: ReactNode;
  if (!messages.length) {
    body = (
      <div className="py-6 text-center">
        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{t("chat.empty.title", { site: site.title })}</p>
        <p className="mx-auto mt-1 max-w-lg text-xs text-zinc-500">{t("chat.empty.hint")}</p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {SUGGESTION_KEYS.map((key) => t(key)).map((s) => (
            <button key={s} type="button" disabled={!chosen} onClick={() => send(s)} className="rounded-full border border-zinc-200 px-3 py-1.5 text-left text-xs text-zinc-700 hover:border-indigo-300 hover:bg-indigo-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-indigo-950/40">
              {s}
            </button>
          ))}
        </div>
      </div>
    );
  } else {
    body = (
      <div className="space-y-4">
        {messages.map((m, i) => <Bubble key={i} message={m} />)}
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <Card
        title={t("chat.title")}
        subtitle={t("chat.subtitle")}
        action={messages.length > 0 && <Button size="sm" variant="ghost" disabled={pending} onClick={() => clearChat(siteId)}>{t("chat.clear")}</Button>}
      >
        <div className="mb-4 flex flex-wrap items-center gap-3">
          <Segmented label={t("visibility.transport.label")} value={mode} onChange={(next) => select({ transport: next })} options={TRANSPORT_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))} />
          {available.length > 0 && (
            <Segmented label={t("chat.model")} value={chosen ?? available[0]} onChange={(m) => select({ provider: m })} options={available.map((m) => ({ value: m, label: label("model", m) }))} />
          )}
        </div>
        {!chosen && (
          <p role="alert" className="mb-4 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            <RichText message={t("chat.noModel")} slots={CLI_SLOTS} />
          </p>
        )}
        <div className="max-h-[60vh] min-h-[16rem] overflow-y-auto rounded-lg bg-zinc-50 p-4 dark:bg-zinc-950/40" aria-live="polite">
          {body}
          {pending && (
            <div className="mt-4 flex items-center gap-2 text-xs text-zinc-500" role="status">
              <span className="inline-flex gap-1" aria-hidden>
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400 [animation-delay:120ms]" />
                <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-zinc-400 [animation-delay:240ms]" />
              </span>
              {t(mode !== "api" ? "chat.pendingCli" : "chat.pending")}
            </div>
          )}
          {error != null && !pending && (
            <div role="alert" className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
              <span className="min-w-0 flex-1">{errorMessage(error)}</span>
              {lastIsUser && <Button size="sm" variant="secondary" onClick={() => ask(messages)}>{t("chat.retry")}</Button>}
            </div>
          )}
          {error == null && !pending && lastIsUser && (
            <div role="status" className="mt-4 flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              <span className="min-w-0 flex-1">{t("chat.lost")}</span>
              <Button size="sm" variant="secondary" disabled={!chosen} onClick={() => ask(messages)}>{t("chat.askAgain")}</Button>
            </div>
          )}
          <div ref={endRef} />
        </div>
        <form
          className="mt-3 flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
        >
          <textarea
            rows={2}
            maxLength={MAX_CHARS}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t("chat.placeholder")}
            aria-label={t("chat.questionLabel")}
            disabled={!chosen}
            className="min-h-[2.75rem] flex-1 resize-y rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-indigo-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          />
          <Button type="submit" variant="primary" loading={pending} disabled={!chosen || !input.trim()}>
            {t("chat.send")}
          </Button>
        </form>
      </Card>
      <div className="space-y-4">
        <McpCard />
      </div>
    </div>
  );
}
