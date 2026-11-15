import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isPrivateAddress } from "../distribution/net";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";

/** True for non-IP strings and every private / reserved / mapped address (shared with distribution/net.ts). */
export const isBlockedReportAddress = (ip: string) => isPrivateAddress(ip);

/** DNS-pinned connection: no redirect following, private/mapped IPs, credentials, or unbounded bodies. */
export async function publicRequest(raw: string, body?: string) {
  const url = new URL(raw);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.hash) throw new Error("Invalid outbound target");
  if (body !== undefined && url.protocol !== "https:") throw new Error("Webhook requires HTTPS");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some((a) => isBlockedReportAddress(a.address))) throw new Error("Outbound target must resolve to public addresses");
  const address = addresses[0];
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: body === undefined ? "GET" : "POST", agent: false,
      // Pin the checked address while preserving the original Host header and TLS server name.
      family: address.family,
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
      headers: body === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      signal: AbortSignal.timeout(15_000),
    }, (res) => {
      let size = 0; const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 16_384) res.destroy(new Error("Outbound response too large"));
        else chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.on("error", reject);
    request.end(body);
  });
}
