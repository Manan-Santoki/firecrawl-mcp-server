# Firecrawl Community MCP

This branch extends the official Firecrawl MCP server 3.40.0 at upstream commit
`fa179a79b4968b346e29c5ba10a5ca17918f82ad`. Its separate `dist/selfhost.js`
entrypoint targets the release-4 community API. The upstream CLI remains intact.

## Connect an AI agent

Use an MCP client with Streamable HTTP and custom authentication headers:

```json
{
  "mcpServers": {
    "firecrawl": {
      "type": "http",
      "url": "https://firecrawl.msantoki.com/mcp",
      "headers": {
        "Authorization": "Bearer <YOUR_FIRECRAWL_API_KEY>"
      }
    }
  }
}
```

The configuration shape varies by client. Enter the key in its secure secret
setting. The MCP URL and bearer header are the same across clients. A client
which only supports stdio needs a Streamable HTTP bridge. OAuth-only clients
need an OAuth adapter; this deployment authenticates with Firecrawl API keys.

## Tools

Existing map, crawl/status, agent/status, monitor, interaction, feedback,
and credit tools retain upstream behavior. Scrape and search use native API
requests to preserve community fields. Scrape accepts all native formats,
actions, proxy modes, cache/index controls, lockdown, PII options and arbitrary
additional API fields. Formats may be strings or native objects. `apiOptions`
also forwards fields not yet represented in a client schema.

New direct tools cover batch scrape, job cancellation/errors, agent
list/thread/trace/skill/snapshots, browser create/list/status/execute/close/replay,
profile deletion, extraction, parse formats, activity, queues and token usage.
These direct tools take `body`, `query`, and `pathParameters` using native API
field names. The server validates the actual API request.

`firecrawl_find_tools` discovers the complete local consumer API catalogue and
returns request schemas and executable `firecrawl_api` calls. It replaces the
unavailable cloud Alexandria catalogue. It does not manufacture provider data.

For example:

```json
{
  "name": "firecrawl_find_tools",
  "arguments": { "query": "batch scrape", "detail": "full" }
}
```

```json
{
  "name": "firecrawl_api",
  "arguments": {
    "operation": "POST /v2/batch/scrape",
    "body": {
      "urls": ["https://example.org"],
      "formats": ["markdown"],
      "maxAge": 0
    }
  }
}
```

`firecrawl_api` supports every enabled operation in
`src/selfhost-catalogue.json`, including less common team settings and Slack
integration routes. It is restricted to catalogue operations at the configured
API origin, rejects redirects and traversal, and forwards the caller's key.
It does not expose operator-secret routes or internal/public callbacks.
`firecrawl_parse` accepts `fileBase64`, `filename`, optional `contentType`,
formats and native parse options. It sends a multipart upload to the API and
works without cloud upload-reference storage. The general `firecrawl_api` tool
supports the same fields for `POST /v2/parse`. Inline files are limited to 6 MiB
decoded and MCP requests to 8 MiB. For larger files, send multipart/form-data
directly from the client machine to the API's `POST /v2/parse`.
The upstream filePath/uploadRef flow remains available when its API storage is
configured; it currently reports a missing upload-reference configuration on
this deployment. A hosted server cannot read a path on the client machine.

Browser listing works on release 4, but session creation currently reports
`HANGAR_URL is missing` despite the older community browser service running.
The MCP tools preserve that API error. This is an API/backend integration gap.

The registry includes deployment-unavailable endpoints for diagnostics only
(`includeUnavailable: true`). Research/developer/government indexes, Labs,
support and Alexandria require upstream services. They are not advertised as
working tools. Browser availability depends on the community browser service.
Self-hosted credit/token responses may contain unlimited placeholder values.

## Run and verify

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm exec tsup
pnpm exec tsc --noEmit
node --test tests/selfhost-api.test.mjs
FIRECRAWL_API_URL=https://firecrawl.msantoki.com \
FIRECRAWL_MCP_ALLOWED_HOSTS=firecrawl.msantoki.com,firecrawl-mcp.msantoki.com \
node dist/selfhost.js
```

The process has no shared API key. Each request must carry a valid bearer key
or `x-firecrawl-api-key`/`x-api-key`. It validates against `/v2/crawl/ongoing`
and caches successful validations for 30 seconds by a SHA-256 fingerprint.
It never uses the gateway's placeholder usage responses for validation.

The Docker image includes both entrypoints. For this profile override its
entrypoint to `["node", "dist/selfhost.js"]`. `/ready` is a credential-free
process readiness probe. Pin the image by digest in production.

The catalogue is based on the deployment OpenAPI plus source-verified release-4
additions. API validation is authoritative. Update the registry when introducing
new public API routes, and add mock integration tests for changes to the MCP
boundary. Availability records mean documented/configured, not end-to-end
verification of every optional backend or account integration.
