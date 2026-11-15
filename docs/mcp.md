# Site assistant & MCP server

Two ways to ask questions about a tracked site:

- **Site assistant** (dashboard → *Asistan*, `/sites/:id/chat`): a chatbot that answers in the dashboard.
- **MCP server** (`/api/mcp` or `npm run -s mcp`): Claude Code, Codex or any other MCP client reads the same data and can apply the fixes in your site's codebase.

Both use the same grounding: `buildSiteContext` (`src/lib/services/site-context.ts`) turns the platform's data into one compact Markdown briefing. It covers the latest scores and failing checks (with example URLs), the top 20 open actions, crawled pages and their issue counts, knowledge-graph counts, LLM visibility, competitor Share of Model, the last AI bot test and pending AutoGEO suggestions. Every crawled or model-generated string is clipped to one line, and the briefing is capped at 40 000 characters.

## Site assistant (chatbot)

| Method | Endpoint | |
| --- | --- | --- |
| `GET` | `/api/sites/:id/chat` | `{ providers, defaultTransport, defaultProvider, enabled }`: which models can answer (names only) |
| `POST` | `/api/sites/:id/chat` | Ask a question; body below |

```json
{
  "messages": [
    { "role": "user", "content": "GEO skorum neden düşük?" },
    { "role": "assistant", "content": "…" },
    { "role": "user", "content": "Önce hangi 3 aksiyonu yapmalıyım?" }
  ],
  "provider": "claude",
  "transport": "cli"
}
```

Response: `{ answer, citations, provider, transport, modelId, answeredAt }`.

- **Stateless.** The client sends the conversation on every turn: at most 20 messages of up to 4 000 characters each, and the last one must come from the user. When the history gets long, the oldest turns are dropped first. The dashboard keeps the conversation in `sessionStorage` for the current tab only; nothing is written to the database.
- **Transports.** These are the same as for visibility checks (see [visibility.md](visibility.md)): `api` keys, the `claude` / `codex` / `agy` CLIs, or `auto`. If you don't pass `provider`, the first model configured for the transport answers, in this order: claude, chatgpt, gemini, perplexity. Web search stays on, as it does for visibility checks.
- **Cost guard.** `POST` makes paid or quota-consuming model calls, so it works like `POST /visibility`: it needs `API_TOKEN` to be configured (otherwise `503`) and a bearer token or dashboard session (otherwise `401`). At most 2 answers run at once per process; a third request gets `429` with `details.code = "busy"`.
- **Errors** carry only a sanitized code, never raw provider or CLI output:

  | Code | Status |
  | --- | --- |
  | `not_configured` | `503` |
  | `rate_limited` | `429` |
  | `timeout` | `504` |
  | anything else | `502` |

- **Prompt injection.** The briefing sits inside `<site_data>` and the model is told to treat it as data only. Crawled strings are clipped, and the CLIs run in the same restricted sandbox as visibility checks.

## MCP server

The server is stateless: it offers tools only, with no sessions and no server-initiated messages. It is implemented in `src/lib/mcp/` and is reachable over two transports.

### Streamable HTTP (`POST /api/mcp`)

Use this when the Next.js server is running, locally or deployed. With `API_TOKEN` set, the proxy requires `Authorization: Bearer <API_TOKEN>`. Without it, the endpoint is open, like the rest of the API. Requests that carry a foreign `Origin` header are rejected (DNS-rebinding guard). Responses are plain JSON, notifications get `202`, and `GET` / `DELETE` return `405`.

**Claude Code:**

```bash
claude mcp add --transport http echorank http://localhost:3000/api/mcp \
  --header "Authorization: Bearer $API_TOKEN"
# add --scope project to share it with the team through .mcp.json
```

**Codex:**

```bash
export ECHORANK_TOKEN=<API_TOKEN>
codex mcp add echorank --url http://localhost:3000/api/mcp --bearer-token-env-var ECHORANK_TOKEN
```

or in `~/.codex/config.toml`:

```toml
[mcp_servers.echorank]
url = "http://localhost:3000/api/mcp"
bearer_token_env_var = "ECHORANK_TOKEN"
```

### stdio (`npm run -s mcp`)

Use this for local use without running the web server. It reads the database directly (`DATABASE_URL` from `.env`). Start it through `npm --prefix` so the working directory is the repo root. Keep `-s`: it stops npm from printing its banner to stdout, which is reserved for protocol messages.

```bash
claude mcp add echorank -- npm --prefix /path/to/EchoRank run -s mcp
codex mcp add echorank -- npm --prefix /path/to/EchoRank run -s mcp
```

`start_audit` over stdio runs the audit inside the stdio process, which needs `GEO_AUDIT_BIN`. When the client closes the connection, the process waits for in-flight work to finish before it exits.

### Tools

Every tool that takes `site` accepts a site ID, a full URL or a bare domain (`example.com`, with or without `www.`).

| Tool | Writes? | Returns |
| --- | --- | --- |
| `list_sites` | | Sites with their latest scores and open action counts |
| `get_site_context` | | The Markdown briefing the assistant uses |
| `get_scores` | | Scores, deltas, pillar metrics, history, per-model visibility |
| `list_actions` | | Prioritized fixes with `details`: evidence, affected URLs and a ready-made snippet with instructions |
| `update_action_status` | ✓ | Sets an action to `open` / `in_progress` / `resolved` / `dismissed` |
| `list_pages` | | Crawled pages. Filters: `query`, `pageType`, `issue` (`missing_meta`, `missing_h1`, `thin`, `error_status`) |
| `get_page` | | One page's extracted data (JSON-LD, headings, …) and the open actions that target it |
| `get_visibility` | | Per-model citation rates and recent checks |
| `list_content_suggestions` | | AutoGEO rewrites: original vs. suggested snippet, diff, expected gain |
| `get_bot_access` | | Last live AI crawler test |
| `get_graph_summary` | | Entity counts, orphan pages, products without a category |
| `list_audits` | | Audit history and whether this server runs audits |
| `start_audit` | ✓ | Queues a crawl + audit (requests go to the site; no LLM cost) |

The MCP server never calls an LLM. Paid visibility checks and the site assistant stay behind the REST API's token check, and the calling agent is the model. If a tool fails (unknown site, invalid arguments, `409` while an audit is running), the error comes back as a tool result with `isError: true`, so the agent can read it and recover.

**Typical agent flow:**

1. "List the critical schema fixes for example.com": the agent calls `list_actions` with `{ site: "example.com", category: "schema", impact: "high" }`.
2. The agent applies each snippet in the repo, then calls `update_action_status` with `resolved`.
3. The agent calls `start_audit` and polls `list_audits`. Checks that still fail reopen their actions.
