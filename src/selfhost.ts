import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  createFirecrawlMcpServer,
  type AuthenticationRequest,
  type SessionData,
  type ToolDefinition,
} from './server.js';
import catalogue from './selfhost-catalogue.json';

type Operation = (typeof catalogue.operations)[number];
const operations = catalogue.operations;
const record = z.record(z.string(), z.unknown());
const knownTools: Record<string, string> = {
  'POST /v2/scrape': 'firecrawl_scrape',
  'POST /v2/search': 'firecrawl_search',
  'POST /v2/map': 'firecrawl_map',
  'POST /v2/crawl': 'firecrawl_crawl',
  'GET /v2/crawl/{jobId}': 'firecrawl_check_crawl_status',
  'POST /v2/agent': 'firecrawl_agent',
  'GET /v2/agent/{jobId}': 'firecrawl_agent_status',
  'POST /v2/parse': 'firecrawl_parse',
  'POST /v2/feedback': 'firecrawl_feedback',
  'POST /v2/search/{jobId}/feedback': 'firecrawl_search_feedback',
  'GET /v2/team/credit-usage': 'firecrawl_credit_usage',
  'GET /v2/team/credit-usage/historical': 'firecrawl_credit_usage',
  'POST /v2/monitor': 'firecrawl_monitor_create',
  'GET /v2/monitor': 'firecrawl_monitor_list',
  'GET /v2/monitor/{monitorId}': 'firecrawl_monitor_get',
  'PATCH /v2/monitor/{monitorId}': 'firecrawl_monitor_update',
  'DELETE /v2/monitor/{monitorId}': 'firecrawl_monitor_delete',
  'POST /v2/monitor/{monitorId}/run': 'firecrawl_monitor_run',
  'GET /v2/monitor/{monitorId}/checks': 'firecrawl_monitor_checks',
  'GET /v2/monitor/{monitorId}/checks/{checkId}': 'firecrawl_monitor_check',
  'POST /v2/scrape/{jobId}/interact': 'firecrawl_interact',
  'DELETE /v2/scrape/{jobId}/interact': 'firecrawl_interact_stop',
};

const extraTools: Record<string, string> = {
  'POST /v2/batch/scrape': 'firecrawl_batch_scrape',
  'GET /v2/batch/scrape/{jobId}': 'firecrawl_batch_scrape_status',
  'DELETE /v2/batch/scrape/{jobId}': 'firecrawl_batch_scrape_cancel',
  'GET /v2/batch/scrape/{jobId}/errors': 'firecrawl_batch_scrape_errors',
  'GET /v2/scrape/{jobId}': 'firecrawl_scrape_status',
  'DELETE /v2/crawl/{jobId}': 'firecrawl_crawl_cancel',
  'GET /v2/crawl/{jobId}/errors': 'firecrawl_crawl_errors',
  'GET /v2/crawl/ongoing': 'firecrawl_crawl_ongoing',
  'POST /v2/crawl/params-preview': 'firecrawl_crawl_params_preview',
  'DELETE /v2/agent/{jobId}': 'firecrawl_agent_cancel',
  'GET /v2/agent': 'firecrawl_agent_list',
  'GET /v2/agent/{jobId}/trace': 'firecrawl_agent_trace',
  'GET /v2/agent/{jobId}/skill': 'firecrawl_agent_skill',
  'GET /v2/agent/threads/{threadId}': 'firecrawl_agent_thread',
  'GET /v2/agent/{jobId}/snapshots/{snapshotId}': 'firecrawl_agent_snapshot',
  'POST /v2/browser': 'firecrawl_browser_create',
  'GET /v2/browser': 'firecrawl_browser_list',
  'GET /v2/browser/{sessionId}': 'firecrawl_browser_status',
  'POST /v2/browser/{sessionId}/execute': 'firecrawl_browser_execute',
  'DELETE /v2/browser/{sessionId}': 'firecrawl_browser_close',
  'GET /v2/browser/{sessionId}/replay': 'firecrawl_browser_replay',
  'GET /v2/browser/{sessionId}/replay/{pageId}':
    'firecrawl_browser_replay_page',
  'DELETE /v2/browser/profiles/{name}': 'firecrawl_browser_profile_delete',
  'POST /v2/extract': 'firecrawl_extract',
  'GET /v2/extract/{jobId}': 'firecrawl_extract_status',
  'GET /v2/concurrency-check': 'firecrawl_concurrency',
  'GET /v2/team/queue-status': 'firecrawl_queue_status',
  'GET /v2/team/activity': 'firecrawl_activity',
  'GET /v2/team/token-usage': 'firecrawl_token_usage',
  'GET /v2/team/token-usage/historical': 'firecrawl_token_usage_historical',
  'GET /v2/parse/formats': 'firecrawl_parse_formats',
};

export const SELFHOST_INSTRUCTIONS =
  "Firecrawl Community accesses this self-hosted API using the caller's API key. Use firecrawl_scrape for a known URL (Markdown, HTML, screenshot, branding, JSON, audio/video, actions, stealth, caching, lockdown and PII redaction), firecrawl_map to discover URLs, firecrawl_search to find sources, and firecrawl_crawl for multiple pages. Use firecrawl_find_tools to discover the complete local REST operation catalogue and input schemas, then firecrawl_api to call any available operation using its exact operation string. Native HTTP API fields go in body, query parameters in query, and path variables in pathParameters. Common operations also have direct named tools. firecrawl_find_tools is local API discovery; it does not supply the unavailable cloud Alexandria provider catalogue. Unsupported research/developer/government/provider upstreams are not advertised as working tools. Features can still fail when a dependency is unavailable. Creating jobs, monitors, browser actions, integrations or changing account settings may have external side effects. Poll asynchronous job IDs until completed or failed; follow pagination. Credit/token figures may be unlimited self-hosted placeholders, not billing data.";

function output(value: unknown, isError = false) {
  const structuredContent =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { data: value };
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    structuredContent,
    ...(isError ? { isError: true } : {}),
  };
}

export function createApiTransport(
  apiUrl: string,
  fetcher: typeof fetch = fetch
) {
  const base = new URL(apiUrl.replace(/\/$/, '') + '/');
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new Error(
      'FIRECRAWL_API_URL must be an HTTP(S) origin or base path without credentials, query or fragment'
    );
  }
  return async (operation: Operation, args: any, key: string) => {
    if (!operation.available)
      return output(
        {
          code: 'FEATURE_UNAVAILABLE',
          operation: operation.operation,
          message: operation.description,
        },
        true
      );
    let route = operation.path;
    for (const name of route.matchAll(/\{([^}]+)\}/g)) {
      const value = args.pathParameters?.[name[1]];
      if (
        typeof value !== 'string' ||
        !value ||
        /[\\/?#]/.test(value) ||
        value === '.' ||
        value === '..'
      ) {
        return output(
          { code: 'INVALID_PATH_PARAMETER', parameter: name[1] },
          true
        );
      }
      route = route.replace(name[0], encodeURIComponent(value));
    }
    const url = new URL(base.toString().replace(/\/$/, '') + route);
    for (const [name, value] of Object.entries(args.query ?? {})) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value))
        for (const item of value) url.searchParams.append(name, String(item));
      else url.searchParams.set(name, String(value));
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${key}`,
      'X-Firecrawl-Origin': 'community-mcp',
    };
    let body: string | ArrayBuffer | FormData | undefined;
    if (args.fileBase64 !== undefined) {
      if (
        !['PUT /v2/parse/upload/{uploadId}', 'POST /v2/parse'].includes(
          operation.operation
        )
      )
        return output({ code: 'INVALID_UPLOAD_OPERATION' }, true);
      const bytes = Uint8Array.from(Buffer.from(args.fileBase64, 'base64'));
      if (bytes.length > 6 * 1024 * 1024)
        return output(
          {
            code: 'FILE_TOO_LARGE',
            message:
              'Inline MCP files are limited to 6 MiB. Upload larger files directly to the native multipart /v2/parse endpoint.',
          },
          true
        );
      if (operation.operation === 'POST /v2/parse') {
        if (!args.filename) return output({ code: 'FILENAME_REQUIRED' }, true);
        const form = new FormData();
        form.append(
          'file',
          new Blob([bytes], {
            type: args.contentType || 'application/octet-stream',
          }),
          args.filename
        );
        form.append('options', JSON.stringify(args.body ?? {}));
        body = form;
      } else {
        body = bytes.buffer;
        headers['Content-Type'] =
          args.contentType || 'application/octet-stream';
      }
    } else if (args.body !== undefined) {
      if (['GET', 'DELETE'].includes(operation.method))
        return output(
          {
            code: 'BODY_NOT_SUPPORTED',
            message: 'Use query for this operation.',
          },
          true
        );
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(args.body);
    }
    try {
      const response = await fetcher(url, {
        method: operation.method,
        headers,
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(240_000),
      });
      const text = await response.text();
      let data: any;
      try {
        data = JSON.parse(text);
      } catch {
        data = { text };
      }
      const failed = !response.ok || data?.success === false;
      return output(
        failed
          ? { status: response.status, operation: operation.operation, ...data }
          : data,
        failed
      );
    } catch (error) {
      const message = String(error).split(key).join('[REDACTED]');
      return output(
        { code: 'API_REQUEST_FAILED', operation: operation.operation, message },
        true
      );
    }
  };
}

export function createSelfhostAuthentication(
  apiUrl: string,
  fetcher: typeof fetch = fetch
) {
  const cache = new Map<string, number>();
  return async (
    request: AuthenticationRequest | undefined
  ): Promise<SessionData> => {
    const h = request?.headers ?? {};
    const auth =
      typeof h.authorization === 'string' ? h.authorization.trim() : '';
    const headerKey = h['x-firecrawl-api-key'] ?? h['x-api-key'];
    const key = /^Bearer\s+/i.test(auth)
      ? auth.replace(/^Bearer\s+/i, '').trim()
      : typeof headerKey === 'string'
        ? headerKey.trim()
        : '';
    const deny = (
      status = 401,
      message = 'A valid Firecrawl API key is required. Send Authorization: Bearer <key>.'
    ) => {
      throw new Response(JSON.stringify({ error: message }), {
        status,
        headers: {
          'Content-Type': 'application/json',
          'WWW-Authenticate': 'Bearer realm="Firecrawl Community MCP"',
        },
      });
    };
    if (!key || key.length > 512 || /[\s\x00-\x1f]/.test(key)) deny();
    const fingerprint = createHash('sha256').update(key).digest('hex');
    if ((cache.get(fingerprint) ?? 0) < Date.now()) {
      let response: Response;
      try {
        // Usage routes are gateway stubs on this installation: never validate a key there.
        response = await fetcher(
          apiUrl.replace(/\/$/, '') + '/v2/crawl/ongoing',
          {
            headers: { Authorization: `Bearer ${key}` },
            redirect: 'error',
            signal: AbortSignal.timeout(10_000),
          }
        );
      } catch {
        return deny(
          503,
          'The Firecrawl API could not be reached for credential validation.'
        );
      }
      if ([401, 403].includes(response.status)) deny();
      if (!response.ok)
        deny(503, 'The Firecrawl API could not validate credentials.');
      const result = (await response.json().catch(() => null)) as any;
      if (result?.success !== true)
        deny(503, 'Unexpected credential validation response from Firecrawl.');
      if (cache.size >= 1000) cache.clear();
      cache.set(fingerprint, Date.now() + 30_000);
    }
    return { firecrawlApiKey: key, authType: 'api-key' };
  };
}

export function discoverOperations(args: any = {}) {
  const terms = String(args.query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const names = args.tools ?? args.capabilities;
  const matches = operations.filter(
    (o) =>
      (args.includeUnavailable || o.available) &&
      (!args.operation || o.operation === args.operation) &&
      (!names?.length ||
        names.some((n: string) =>
          [
            knownTools[o.operation],
            extraTools[o.operation],
            o.operation,
          ].includes(n)
        )) &&
      (!args.categories?.length ||
        args.categories.some((c: string) => o.path.includes('/' + c))) &&
      terms.every((t: string) =>
        `${o.operation} ${o.summary} ${o.description} ${knownTools[o.operation] ?? extraTools[o.operation] ?? ''} ${JSON.stringify(o.bodySchema)} ${o.path.includes('scrape') ? 'youtube audio video media stealth actions cache index lockdown pii redaction' : ''}`
          .toLowerCase()
          .includes(t)
      )
  );
  const offset = args.offset ?? 0;
  const limit = args.limit ?? 10;
  return {
    catalogue: 'self-hosted-api',
    source: catalogue.source,
    note: 'Local Firecrawl API operation discovery. Cloud Alexandria providers and private search indexes are not configured. Availability means documented/configured, not that every dependency has been smoke-tested.',
    total: matches.length,
    offset,
    nextOffset: offset + limit < matches.length ? offset + limit : null,
    tools: matches.slice(offset, offset + limit).map((o) => ({
      operation: o.operation,
      tool:
        knownTools[o.operation] ?? extraTools[o.operation] ?? 'firecrawl_api',
      executor: 'firecrawl_api',
      summary: o.summary,
      available: o.available,
      ...(args.detail === 'full' || args.operation || names?.length
        ? {
            description: o.description,
            parameters: o.parameters,
            bodySchema: o.bodySchema,
          }
        : {}),
      call: {
        name: 'firecrawl_api',
        arguments: {
          operation: o.operation,
          ...(o.path.includes('{')
            ? {
                pathParameters: Object.fromEntries(
                  [...o.path.matchAll(/\{([^}]+)\}/g)].map((m) => [
                    m[1],
                    `<${m[1]}>`,
                  ])
                ),
              }
            : {}),
        },
      },
    })),
  };
}

const apiArguments = z.object({
  operation: z
    .string()
    .describe(
      'Exact operation from firecrawl_find_tools, e.g. POST /v2/batch/scrape'
    ),
  pathParameters: z.record(z.string(), z.string()).optional(),
  query: record.optional(),
  body: record
    .optional()
    .describe('Native API JSON body; all API options are forwarded unchanged.'),
  fileBase64: z
    .string()
    .optional()
    .describe(
      'Base64 document bytes, up to 6 MiB, for POST /v2/parse or PUT /v2/parse/upload/{uploadId}.'
    ),
  filename: z
    .string()
    .optional()
    .describe('Required with fileBase64 for POST /v2/parse.'),
  contentType: z.string().optional(),
});

const format = z.union([
  z.string(),
  z.object({ type: z.string() }).passthrough(),
]);
const scrapeArguments = z
  .object({
    url: z.string(),
    formats: z.array(format).optional(),
    onlyMainContent: z.boolean().optional(),
    maxAge: z.number().optional(),
    storeInCache: z.boolean().optional(),
    proxy: z.enum(['basic', 'stealth', 'enhanced', 'auto']).optional(),
    actions: z
      .array(record)
      .optional()
      .describe(
        'Browser actions: wait, click, write, press, scroll, screenshot, scrape, executeJavascript.'
      ),
    redactPII: z
      .union([z.boolean(), record])
      .optional()
      .describe('true or {mode, entities, replaceStyle}'),
    lockdown: z.boolean().optional(),
    mobile: z.boolean().optional(),
    parsers: z.array(z.union([z.string(), record])).optional(),
    jsonOptions: z
      .object({ prompt: z.string().optional(), schema: record.optional() })
      .optional(),
    screenshotOptions: record.optional(),
    queryOptions: record.optional(),
    pdfOptions: record.optional(),
    apiOptions: record
      .optional()
      .describe(
        'Additional native API fields; e.g. timeout, headers, includeTags, excludeTags, location, waitFor, zeroDataRetention.'
      ),
  })
  .passthrough();

export function normalizeScrape(args: any) {
  const {
    apiOptions,
    jsonOptions,
    screenshotOptions,
    queryOptions,
    pdfOptions,
    ...fields
  } = args;
  const body = { ...apiOptions, ...fields };
  body.formats = (body.formats ?? ['markdown']).map((f: any) => {
    const type = typeof f === 'string' ? f : f.type;
    const options =
      type === 'json'
        ? jsonOptions
        : type === 'screenshot'
          ? screenshotOptions
          : type === 'query'
            ? queryOptions
            : undefined;
    return options
      ? { type, ...options, ...(typeof f === 'object' ? f : {}) }
      : f;
  });
  if (pdfOptions)
    body.parsers = (body.parsers ?? ['pdf']).map((p: any) =>
      p === 'pdf' ? { type: 'pdf', ...pdfOptions } : p
    );
  return body;
}

export function createSelfHostedServer(
  apiUrl: string,
  fetcher: typeof fetch = fetch
) {
  const transport = createApiTransport(apiUrl, fetcher);
  const operation = (id: string) => operations.find((o) => o.operation === id)!;
  const call = (id: string, args: any, session?: SessionData) =>
    transport(operation(id), args, session?.firecrawlApiKey ?? '');
  const directNames = new Set(Object.values(extraTools));
  const allowedBuiltins = new Set(
    [...Object.values(knownTools)].filter(
      (n) =>
        ![
          'firecrawl_scrape',
          'firecrawl_search',
          'firecrawl_extract',
          'firecrawl_parse',
        ].includes(n)
    )
  );
  return createFirecrawlMcpServer({
    apiUrl,
    transport: 'httpStream',
    logging: false,
    safeMode: false,
    fileAccess: 'upload',
    requireCredential: true,
    unstable_hooks: {
      authenticate: createSelfhostAuthentication(apiUrl, fetcher),
      instructions: SELFHOST_INSTRUCTIONS,
      toolFilter: (name) => allowedBuiltins.has(name) && !directNames.has(name),
      configureHttp: (app) => {
        app.get('/ready', (c) =>
          c.json({
            ok: true,
            profile: 'selfhost-api-parity',
            upstream: '3.40.0',
            operations: operations.length,
          })
        );
      },
      registerExtraTools: (registrar, context) => {
        const nativeParse = context.builtInTool('firecrawl_parse')!;
        registrar.addTool({
          name: 'firecrawl_parse',
          description:
            'Parse a document through the native multipart API. Supply fileBase64 and filename (up to 6 MiB decoded) plus formats and any native parse options. This works without configured upload-reference storage. For larger files, upload directly from the client to POST /v2/parse as multipart/form-data. filePath/uploadRef also support the upstream two-phase flow when the API has upload-reference storage configured; filePath alone cannot read the client filesystem.',
          parameters: z
            .object({
              fileBase64: z.string().optional(),
              filename: z.string().optional(),
              contentType: z.string().optional(),
              filePath: z.string().optional(),
              uploadRef: z.string().optional(),
              formats: z.array(format).optional(),
              apiOptions: record.optional(),
              redactPII: z.union([z.boolean(), record]).optional(),
              jsonOptions: record.optional(),
              pdfOptions: record.optional(),
            })
            .passthrough(),
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            openWorldHint: false,
          },
          execute: async (args, ctx) => {
            const {
              fileBase64,
              filename,
              contentType,
              filePath,
              uploadRef,
              ...options
            } = args;
            if (fileBase64 !== undefined)
              return call(
                'POST /v2/parse',
                {
                  fileBase64,
                  filename: filename || filePath?.split(/[\\/]/).pop(),
                  contentType,
                  body: normalizeScrape(options),
                },
                ctx.session
              );
            if (!filePath && !uploadRef)
              return output(
                {
                  code: 'FILE_REQUIRED',
                  message:
                    'Supply fileBase64 and filename, or use the configured filePath/uploadRef upload flow.',
                },
                true
              );
            const result = await nativeParse.execute(args, ctx);
            if (typeof result === 'object' && result?.isError)
              return {
                ...result,
                content: [
                  ...result.content,
                  {
                    type: 'text' as const,
                    text: 'If upload references are not configured, use fileBase64 and filename for native multipart parsing (up to 6 MiB), or send a larger multipart upload directly to the API.',
                  },
                ],
              };
            return result;
          },
        });
        registrar.addTool({
          name: 'firecrawl_find_tools',
          description:
            'Discover this self-hosted Firecrawl API: find tools by task or keyword, inspect native REST input schemas, and return executable firecrawl_api calls. This is a local API catalogue, not cloud Alexandria provider discovery. Include unavailable operations only to diagnose missing upstreams.',
          parameters: z.object({
            query: z.string().optional(),
            operation: z.string().optional(),
            tools: z.array(z.string()).optional(),
            capabilities: z.array(z.string()).optional(),
            categories: z.array(z.string()).optional(),
            detail: z.enum(['summary', 'full']).optional(),
            includeUnavailable: z.boolean().optional(),
            limit: z.number().int().min(1).max(100).optional(),
            offset: z.number().int().min(0).optional(),
          }),
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            openWorldHint: false,
          },
          execute: async (args) => output(discoverOperations(args)),
        });
        registrar.addTool({
          name: 'firecrawl_api',
          description:
            'Call any available consumer REST operation discovered with firecrawl_find_tools, forwarding all native API options. No arbitrary URLs, operator/admin endpoints, credentials, internal callbacks or unavailable upstreams. POST/PUT/PATCH/DELETE may create jobs, run browser actions, change settings or integrations, or delete resources. Use the operation contract before calling.',
          parameters: apiArguments,
          annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            openWorldHint: true,
          },
          execute: async (args, ctx) => {
            const op = operations.find((o) => o.operation === args.operation);
            if (!op)
              return output(
                {
                  code: 'UNKNOWN_OPERATION',
                  message:
                    'Use firecrawl_find_tools to select a supported operation.',
                },
                true
              );
            return transport(op, args, ctx.session?.firecrawlApiKey ?? '');
          },
        });
        registrar.addTool({
          name: 'firecrawl_scrape',
          description:
            'Scrape a known URL using all community API features: Markdown/HTML, screenshots, branding, JSON, audio/video, browser actions, stealth proxy, index/cache, lockdown and PII redaction. Formats accept strings or native option objects. Extra API fields can be passed directly or in apiOptions. Actions can modify a live site.',
          parameters: scrapeArguments,
          annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            openWorldHint: true,
          },
          execute: async (args, ctx) =>
            call(
              'POST /v2/scrape',
              { body: normalizeScrape(args) },
              ctx.session
            ),
        });
        registrar.addTool({
          name: 'firecrawl_search',
          description:
            'Search the self-hosted web/news/images provider. query is the search text; all other native API search options, including scrapeOptions, are forwarded. Private developer/government indexes and Alexandria providers are not configured on this deployment.',
          parameters: z
            .object({
              query: z.string(),
              limit: z.number().int().optional(),
              sources: z.array(z.union([z.string(), record])).optional(),
              categories: z.array(z.union([z.string(), record])).optional(),
              scrapeOptions: record.optional(),
              apiOptions: record.optional(),
            })
            .passthrough(),
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            openWorldHint: true,
          },
          execute: async ({ query, apiOptions, ...args }, ctx) =>
            call(
              'POST /v2/search',
              { body: { ...apiOptions, ...args, query } },
              ctx.session
            ),
        });
        for (const [id, name] of Object.entries(extraTools)) {
          const op = operation(id);
          if (!op?.available) continue;
          registrar.addTool({
            name,
            description: `${op.summary}. ${op.method} ${op.path}. Put native REST fields in body, URL variables in pathParameters, and URL query options in query. Inspect the full contract with firecrawl_find_tools({operation: ${JSON.stringify(id)}}). ${op.description}`,
            parameters: apiArguments.omit({
              operation: true,
              fileBase64: true,
              contentType: true,
              filename: true,
            }),
            annotations: {
              readOnlyHint: op.method === 'GET',
              destructiveHint:
                op.method === 'DELETE' || ['PUT', 'PATCH'].includes(op.method),
              openWorldHint: true,
            },
            execute: async (args, ctx) => call(id, args, ctx.session),
          } as ToolDefinition);
        }
      },
    },
  });
}
