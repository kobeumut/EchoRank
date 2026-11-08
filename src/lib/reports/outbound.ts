import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";

const blocked = new BlockList();
for (const [address, prefix] of [ ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4] ] as const) blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32]] as const) blocked.addSubnet(address, prefix, "ipv6");
export const isBlockedReportAddress = (ip: string) => !isIP(ip) || blocked.check(ip, isIP(ip) === 6 ? "ipv6" : "ipv4");

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
