import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  createSelfHostedServer,
  createSelfhostAuthentication,
  discoverOperations,
} from '../dist/selfhost-tools.js';
import { getFreePort, parseSseJson } from './helpers/exchange-mcp.mjs';

test('self-hosted MCP authenticates, discovers and forwards the consumer API', async (t) => {
  const calls = [];
  const api = http.createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const multipart = req.headers['content-type']?.startsWith(
      'multipart/form-data'
    );
    const body = text && !multipart ? JSON.parse(text) : undefined;
    calls.push({
      path: req.url,
      method: req.method,
      body,
      raw: multipart ? text : undefined,
      authorization: req.headers.authorization,
    });
    res.setHeader('Content-Type', 'application/json');
    if (req.headers.authorization !== 'Bearer fc-test-valid') {
      res.writeHead(401);
      res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
      return;
    }
    if (req.url === '/v2/crawl/ongoing') {
      res.end(JSON.stringify({ success: true, crawls: [] }));
      return;
    }
    if (req.url === '/v2/batch/scrape/fail') {
      res.writeHead(404);
      res.end(JSON.stringify({ success: false, error: 'Unknown job' }));
      return;
    }
    res.end(
      JSON.stringify({
        success: true,
        method: req.method,
        path: req.url,
        received: body ?? null,
      })
    );
  });
  await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => api.close(resolve)));
  const url = `http://127.0.0.1:${api.address().port}`;
  const server = createSelfHostedServer(url);
  const port = await getFreePort();
  await server.start({
    transportType: 'httpStream',
    httpStream: {
      port,
      host: '127.0.0.1',
      endpoint: '/mcp',
      stateless: true,
      allowedHosts: ['127.0.0.1'],
    },
  });
  t.after(() => server.stop());
  const rpc = async (method, params = {}, token = 'fc-test-valid') => {
    const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const text = await r.text();
    return {
      status: r.status,
      payload:
        r.ok && text
          ? text.startsWith('{')
            ? JSON.parse(text)
            : parseSseJson(text)
          : text,
    };
  };
  const call = async (name, args) =>
    (await rpc('tools/call', { name, arguments: args })).payload.result;

  await t.test(
    'rejects absent and invalid keys before tool discovery',
    async () => {
      assert.equal((await rpc('tools/list', {}, '')).status, 401);
      assert.equal(
        (
          await rpc(
            'initialize',
            {
              protocolVersion: '2025-03-26',
              capabilities: {},
              clientInfo: { name: 'test', version: '1' },
            },
            'fc-test-invalid'
          )
        ).status,
        401
      );
    }
  );
  await t.test(
    'serves the standard protocol and all configured tools',
    async () => {
      const initialized = await rpc('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      });
      assert.equal(initialized.status, 200);
      const tools = (await rpc('tools/list')).payload.result.tools;
      const names = tools.map((t) => t.name);
      for (const name of [
        'firecrawl_scrape',
        'firecrawl_map',
        'firecrawl_crawl',
        'firecrawl_agent',
        'firecrawl_parse',
        'firecrawl_monitor_create',
        'firecrawl_browser_create',
        'firecrawl_batch_scrape',
        'firecrawl_find_tools',
        'firecrawl_api',
      ])
        assert.ok(names.includes(name), name);
      assert.equal(new Set(names).size, names.length);
      for (const name of [
        'firecrawl_research_search_papers',
        'firecrawl_gov_search',
        'firecrawl_developer_search',
        'alexandria_library_read',
        'people_company_enrich',
      ])
        assert.ok(!names.includes(name), name);
      assert.ok(
        !initialized.payload.result.instructions.includes(
          'Alexandria providers in data.tools'
        )
      );
    }
  );
  await t.test(
    'discovery exposes full schemas and executable local API operations',
    async () => {
      const r = await call('firecrawl_find_tools', {
        operation: 'POST /v2/scrape',
      });
      assert.equal(r.structuredContent.catalogue, 'self-hosted-api');
      assert.ok(r.structuredContent.tools[0].bodySchema.properties.formats);
      assert.equal(r.structuredContent.tools[0].executor, 'firecrawl_api');
      assert.ok(
        discoverOperations({ includeUnavailable: true, limit: 100 }).tools.some(
          (o) => !o.available
        )
      );
      assert.ok(
        discoverOperations({ limit: 100 }).tools.every((o) => o.available)
      );
      for (const query of ['audio', 'stealth', 'redactPII', 'video'])
        assert.ok(
          discoverOperations({ query }).tools.some(
            (o) => o.operation === 'POST /v2/scrape'
          ),
          query
        );
    }
  );
  await t.test(
    'preserves new scrape features and compatibility option objects',
    async () => {
      const r = await call('firecrawl_scrape', {
        url: 'https://example.org',
        formats: ['markdown', 'screenshot', 'json', 'audio', 'video'],
        actions: [{ type: 'wait', milliseconds: 10 }],
        proxy: 'stealth',
        lockdown: true,
        redactPII: {
          mode: 'aggressive',
          entities: ['EMAIL'],
          replaceStyle: 'mask',
        },
        maxAge: 0,
        screenshotOptions: { fullPage: true },
        jsonOptions: { schema: { type: 'object' } },
        apiOptions: { timeout: 90000, headers: { 'x-test': 'yes' } },
      });
      assert.ok(!r.isError, JSON.stringify(r));
      const body = calls.at(-1).body;
      assert.equal(body.proxy, 'stealth');
      assert.equal(body.lockdown, true);
      assert.equal(body.maxAge, 0);
      assert.deepEqual(body.redactPII, {
        mode: 'aggressive',
        entities: ['EMAIL'],
        replaceStyle: 'mask',
      });
      assert.deepEqual(body.formats[1], { type: 'screenshot', fullPage: true });
      assert.deepEqual(body.formats[2], {
        type: 'json',
        schema: { type: 'object' },
      });
      assert.equal(body.timeout, 90000);
      assert.equal(body.headers['x-test'], 'yes');
    }
  );
  await t.test(
    'direct batch/browser tools forward native bodies and path/query values',
    async () => {
      await call('firecrawl_batch_scrape', {
        body: {
          urls: ['https://example.org'],
          formats: ['markdown'],
          maxAge: 0,
        },
      });
      assert.equal(calls.at(-1).path, '/v2/batch/scrape');
      assert.equal(calls.at(-1).body.maxAge, 0);
      await call('firecrawl_browser_execute', {
        pathParameters: { sessionId: 'session-1' },
        body: { code: 'console.log(1)', language: 'node' },
      });
      assert.equal(calls.at(-1).path, '/v2/browser/session-1/execute');
      await call('firecrawl_api', {
        operation: 'GET /v2/team/activity',
        query: { limit: 2, cursor: 'a&b' },
      });
      assert.equal(calls.at(-1).path, '/v2/team/activity?limit=2&cursor=a%26b');
      assert.equal(calls.at(-1).authorization, 'Bearer fc-test-valid');
    }
  );
  await t.test(
    'parses inline files as multipart without cloud upload-reference storage',
    async () => {
      const r = await call('firecrawl_parse', {
        filename: 'test.html',
        contentType: 'text/html',
        fileBase64: Buffer.from(
          '<html><body>Document test</body></html>'
        ).toString('base64'),
        formats: ['markdown'],
        redactPII: true,
      });
      assert.ok(!r.isError, JSON.stringify(r));
      assert.equal(calls.at(-1).path, '/v2/parse');
      assert.ok(calls.at(-1).raw.includes('filename="test.html"'));
      assert.ok(calls.at(-1).raw.includes('Document test'));
      assert.ok(calls.at(-1).raw.includes('"redactPII":true'));
      const missing = await call('firecrawl_parse', {});
      assert.equal(missing.isError, true);
      assert.equal(missing.structuredContent.code, 'FILE_REQUIRED');
    }
  );
  await t.test(
    'blocks arbitrary endpoints, unavailable upstreams, and path traversal',
    async () => {
      const count = calls.length;
      for (const args of [
        { operation: 'POST /admin/secret/clear' },
        { operation: 'GET /v2/research/papers' },
        { operation: 'GET /v2/crawl/{jobId}', pathParameters: { jobId: '..' } },
        {
          operation: 'GET /v2/crawl/{jobId}',
          pathParameters: { jobId: '../team/activity' },
        },
        { operation: 'GET /v2/crawl/{jobId}' },
      ])
        assert.equal((await call('firecrawl_api', args)).isError, true);
      assert.equal(calls.length, count);
    }
  );
  await t.test('propagates REST failures as MCP tool errors', async () => {
    const r = await call('firecrawl_batch_scrape_status', {
      pathParameters: { jobId: 'fail' },
    });
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent.status, 404);
    assert.equal(r.structuredContent.error, 'Unknown job');
  });
});

test('authentication fails closed when the API is unavailable', async () => {
  const auth = createSelfhostAuthentication('http://api.invalid', async () => {
    throw new Error('unreachable');
  });
  await assert.rejects(
    auth({ headers: { authorization: 'Bearer fc-test-valid' } }),
    (r) => r instanceof Response && r.status === 503
  );
});
