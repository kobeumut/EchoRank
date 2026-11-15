"use client";

// Site assistant conversations live here, outside the chat page, so a question keeps being answered while the
// user browses other screens (client-side navigation keeps this module alive). Messages are mirrored to
// sessionStorage per site; a finished answer is announced to `onChatCompleted` listeners (see ChatNotifier).
import { useSyncExternalStore } from "react";
import { apiFetch } from "./api";
import type { TransportMode } from "./types";

export type ChatAnswer = { answer: string; citations: string[]; provider: string; transport: "api" | "cli"; modelId: string; answeredAt: string };
export type Message = { role: "user" | "assistant"; content: string; meta?: Omit<ChatAnswer, "answer"> };
export type ChatState = { messages: Message[]; pending: boolean; error: unknown };
export type ChatCompletion = { siteId: string; siteTitle: string; ok: boolean };

const EMPTY: ChatState = { messages: [], pending: false, error: null };
const states = new Map<string, ChatState>();
const listeners = new Set<() => void>();
const completionListeners = new Set<(completion: ChatCompletion) => void>();
/** Site whose chat page is on screen; its answers need no notification. */
let viewing: string | null = null;

const storageKey = (siteId: string) => `aiv-chat:${siteId}`;
function loadMessages(siteId: string): Message[] {
  try {
    const raw = sessionStorage.getItem(storageKey(siteId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as Message[]) : [];
  } catch {
    return [];
  }
}
function saveMessages(siteId: string, messages: Message[]) {
  try {
    sessionStorage.setItem(storageKey(siteId), JSON.stringify(messages));
  } catch {
    /* private mode / quota: the conversation just is not kept across reloads */
  }
}

export function getChat(siteId: string): ChatState {
  if (typeof window === "undefined") return EMPTY;
  let state = states.get(siteId);
  if (!state) {
    state = { ...EMPTY, messages: loadMessages(siteId) };
    states.set(siteId, state);
  }
  return state;
}

function update(siteId: string, patch: Partial<ChatState>) {
  const next = { ...getChat(siteId), ...patch };
  states.set(siteId, next);
  if (patch.messages) saveMessages(siteId, next.messages);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useChat(siteId: string): ChatState {
  return useSyncExternalStore(subscribe, () => getChat(siteId), () => EMPTY);
}

export function clearChat(siteId: string) {
  if (!getChat(siteId).pending) update(siteId, { messages: [], error: null });
}

/** Sends `history` (its last message is the question); one question at a time per site. */
export async function askChat(siteId: string, siteTitle: string, history: Message[], body: { provider: string; transport: TransportMode }, limits: { messages: number; chars: number }) {
  if (getChat(siteId).pending) return;
  update(siteId, { messages: history, pending: true, error: null });
  let ok = false;
  try {
    const payload = history.slice(-limits.messages).map((m) => ({ role: m.role, content: m.content.slice(0, limits.chars) }));
    const { answer, ...meta } = await apiFetch<ChatAnswer>(`/api/sites/${siteId}/chat`, { method: "POST", json: { messages: payload, ...body } });
    update(siteId, { messages: [...history, { role: "assistant", content: answer, meta }], pending: false });
    ok = true;
  } catch (error) {
    update(siteId, { pending: false, error });
  }
  for (const listener of completionListeners) listener({ siteId, siteTitle, ok });
}

/** The chat page marks its site as on screen while mounted. */
export function setViewingChat(siteId: string | null) {
  viewing = siteId;
}
export const isViewingChat = (siteId: string) => viewing === siteId;

export function onChatCompleted(listener: (completion: ChatCompletion) => void) {
  completionListeners.add(listener);
  return () => {
    completionListeners.delete(listener);
  };
}

const SELECTION_KEY = "aiv-chat-selection";
export type ChatSelection = { transport: TransportMode | null; provider: string | null };
/** Last chosen connection type and model, kept across visits (per browser). */
export function loadSelection(): ChatSelection {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(SELECTION_KEY) ?? "{}");
    const value = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    const transport = value.transport === "auto" || value.transport === "api" || value.transport === "cli" ? value.transport : null;
    return { transport, provider: typeof value.provider === "string" ? value.provider : null };
  } catch {
    return { transport: null, provider: null };
  }
}
export function saveSelection(selection: ChatSelection) {
  try {
    localStorage.setItem(SELECTION_KEY, JSON.stringify(selection));
  } catch {
    /* storage blocked: the choice resets on the next visit */
  }
}
