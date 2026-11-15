// MCP over stdio for local agents (Claude Code, Codex, …): newline-delimited JSON-RPC on stdin/stdout, reading the
// database directly (DATABASE_URL from .env), so the Next.js server does not need to be running.
// Start through npm so the working directory is the project root: `npm --prefix <repo> run -s mcp` (see docs/mcp.md).
import { createInterface } from "node:readline";
import { prisma } from "../src/lib/db";
import { handleMcpPayload, PARSE_ERROR, rpcError } from "../src/lib/mcp/server";

// stdout carries protocol messages only: anything a library logs goes to stderr.
console.log = console.info = console.debug = console.warn = console.error;
const send = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);

const pending = new Set<Promise<unknown>>();
const track = (work: Promise<unknown>) => {
  pending.add(work);
  void work.finally(() => pending.delete(work));
};

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  if (!line.trim()) return;
  let payload: unknown;
  try {
    payload = JSON.parse(line);
  } catch {
    send(rpcError(null, PARSE_ERROR, "Parse error"));
    return;
  }
  // Requests run concurrently; responses carry their id, so order does not matter.
  track(handleMcpPayload(payload, { defer: (task) => track(task().catch((err) => console.error("deferred task failed", err))) })
    .then((response) => { if (response !== null) send(response); }));
});
lines.on("close", async () => {
  // The client closed stdin: finish in-flight requests (and started audits), then exit.
  while (pending.size) await Promise.allSettled([...pending]);
  await prisma.$disconnect();
  process.exit(0);
});
