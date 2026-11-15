import { after } from "next/server";
import { isSameOrigin } from "@/lib/auth";
import { handleMcpPayload, PARSE_ERROR, rpcError } from "@/lib/mcp/server";

/**
 * MCP Streamable HTTP endpoint (stateless, JSON responses only). Auth is the API's: with API_TOKEN set the proxy
 * requires `Authorization: Bearer <API_TOKEN>`. See docs/mcp.md for Claude Code / Codex setup.
 */
export async function POST(request: Request) {
  // DNS-rebinding guard: a browser page on another origin must not drive a locally running server.
  if (request.headers.get("origin") && !isSameOrigin(request)) {
    return Response.json(rpcError(null, -32000, "Forbidden origin"), { status: 403 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(await request.text());
  } catch {
    return Response.json(rpcError(null, PARSE_ERROR, "Parse error"), { status: 400 });
  }
  const response = await handleMcpPayload(payload, { defer: (task) => after(task) });
  return response === null ? new Response(null, { status: 202 }) : Response.json(response);
}

/** No server-initiated stream: this server never sends requests or notifications on its own. */
export function GET() {
  return new Response(null, { status: 405, headers: { allow: "POST" } });
}

/** Stateless: there is no session to terminate. */
export function DELETE() {
  return new Response(null, { status: 405, headers: { allow: "POST" } });
}
