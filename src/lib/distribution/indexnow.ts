import { randomBytes } from "node:crypto";
import type { Site } from "@prisma/client";
import { getDistributionSettings, getIntegration, INTEGRATION_KEYS, setIntegration } from "./config";
import { assertPublicHttpUrl, OUTBOUND_TIMEOUT_MS, readSnippet } from "./net";

// IndexNow (https://www.indexnow.org/documentation): one POST notifies every participating
// engine (Bing, Yandex, Seznam, Naver, ...). ChatGPT search is grounded on Bing's index, so this
// is the fastest signal available for it, but it is a crawl hint, not an inclusion guarantee.

export const DEFAULT_INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
/** Protocol limit per request. */
export const INDEXNOW_MAX_URLS = 10_000;
const KEY_PATTERN = /^[a-zA-Z0-9-]{8,128}$/;

export function isValidIndexNowKey(key: string) {
  return KEY_PATTERN.test(key);
}

export function generateIndexNowKey() {
  return randomBytes(16).toString("hex");
}

/** Per-site key; single-site deployments can set the INDEXNOW_KEY environment variable instead. */
export function getIndexNowKey(site: Site): string | undefined {
  const key = getIntegration(site, INTEGRATION_KEYS.indexnowKey) ?? (process.env.INDEXNOW_KEY || undefined);
  return key && isValidIndexNowKey(key) ? key : undefined;
}

export async function ensureIndexNowKey(site: Site, opts: { rotate?: boolean } = {}) {
  const existing = getIntegration(site, INTEGRATION_KEYS.indexnowKey);
  if (existing && isValidIndexNowKey(existing) && !opts.rotate) return { key: existing, created: false };
  const key = generateIndexNowKey();
  await setIntegration(site, INTEGRATION_KEYS.indexnowKey, key);
  return { key, created: true };
}

/** Where the key file must be served, plus its exact content. */
export function describeKeyFile(site: Site, key: string) {
  const { indexnow } = getDistributionSettings(site);
  const keyLocation = indexnow.keyLocation ?? `${site.url}/${key}.txt`;
  return {
    key,
    keyLocation,
    fileName: new URL(keyLocation).pathname.split("/").pop() || `${key}.txt`,
    fileContent: key,
    contentType: "text/plain; charset=utf-8",
    instructions:
      `Serve a UTF-8 text file at ${keyLocation} whose only content is the key. ` +
      "Search engines fetch it to prove you own the host before accepting submissions.",
  };
}

/** Fetches the published key file and checks it matches. */
export async function verifyKeyFile(site: Site, key: string) {
  const { keyLocation } = describeKeyFile(site, key);
  await assertPublicHttpUrl(keyLocation);
  try {
    const res = await fetch(keyLocation, { redirect: "follow", signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS) });
    const body = (await readSnippet(res, 1_000)).replace(/^﻿/, "").trim();
    const valid = res.ok && body === key;
    return {
      keyLocation,
      valid,
      httpStatus: res.status,
      reason: valid ? null : res.ok ? "Key file content does not match the key" : `Key file returned HTTP ${res.status}`,
    };
  } catch (err) {
    return { keyLocation, valid: false, httpStatus: null, reason: (err as Error).message };
  }
}

export interface IndexNowResult {
  ok: boolean;
  status: number | null;
  /** Retrying may help (429, 5xx, network, 403 while the key file propagates). */
  retryable: boolean;
  message: string;
  urls: string[];
}

const STATUS_TEXT: Record<number, string> = {
  200: "URLs submitted",
  202: "URLs received; key validation pending",
  400: "Bad request (invalid format)",
  403: "Key not valid (key file missing or content mismatch)",
  422: "URLs do not belong to the host or key does not match the schema",
  429: "Too many requests (potential spam)",
};

/**
 * Submits URLs for one host. All URLs must share `site`'s host (callers validate on enqueue).
 * Splits into protocol-sized batches; returns one result per batch.
 */
export async function submitIndexNow(site: Site, urls: string[], key: string): Promise<IndexNowResult[]> {
  const settings = getDistributionSettings(site);
  const endpoint = settings.indexnow.endpoint ?? process.env.INDEXNOW_ENDPOINT ?? DEFAULT_INDEXNOW_ENDPOINT;
  const host = new URL(site.url).host;
  const keyLocation = settings.indexnow.keyLocation;
  const results: IndexNowResult[] = [];

  for (let i = 0; i < urls.length; i += INDEXNOW_MAX_URLS) {
    const batch = urls.slice(i, i + INDEXNOW_MAX_URLS);
    const body = JSON.stringify({ host, key, ...(keyLocation ? { keyLocation } : {}), urlList: batch });
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8" },
        body,
        signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
      });
      const ok = res.status === 200 || res.status === 202;
      const detail = ok ? "" : await readSnippet(res, 300);
      results.push({
        ok,
        status: res.status,
        retryable: !ok && res.status !== 400 && res.status !== 422,
        message: [STATUS_TEXT[res.status] ?? `HTTP ${res.status}`, detail].filter(Boolean).join(": "),
        urls: batch,
      });
    } catch (err) {
      results.push({ ok: false, status: null, retryable: true, message: (err as Error).message, urls: batch });
    }
  }
  return results;
}
