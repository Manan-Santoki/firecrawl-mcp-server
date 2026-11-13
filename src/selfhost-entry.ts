#!/usr/bin/env node
import { createSelfHostedServer } from './selfhost.js';

const apiUrl = process.env.FIRECRAWL_API_URL;
if (!apiUrl)
  throw new Error(
    'FIRECRAWL_API_URL is required; this profile never defaults to the cloud API.'
  );
const host = process.env.HOST || '0.0.0.0';
const allowedHosts = [
  'localhost',
  '127.0.0.1',
  '[::1]',
  ...(process.env.FIRECRAWL_MCP_ALLOWED_HOSTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
];
const server = createSelfHostedServer(apiUrl);
await server.start({
  transportType: 'httpStream',
  httpStream: {
    host,
    port: Number(process.env.PORT || 3000),
    endpoint: '/mcp',
    stateless: true,
    allowedHosts,
    maxBodySize: 8_388_608,
  },
});
process.on('SIGTERM', async () => {
  await server.stop();
  process.exit(0);
});
process.on('SIGINT', async () => {
  await server.stop();
  process.exit(0);
});
