#!/usr/bin/env node
// healthcheck-server.js — Minimal HTTP health/readiness server for NanoClaw pods
// No dependencies. Node.js http module only.

'use strict';

const http = require('http');
const { execSync } = require('child_process');

const PORT = parseInt(process.env.HEALTHCHECK_PORT || '3000', 10);
const startTime = Date.now();

// NanoClaw readiness: check if gateway process is running
function isNanoClawReady() {
  try {
    // Check if openclaw gateway is listening (pid file or process grep)
    execSync('pgrep -f "openclaw" >/dev/null 2>&1', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'healthy',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      timestamp: new Date().toISOString(),
    }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/ready') {
    const ready = isNanoClawReady();
    const code = ready ? 200 : 503;
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: ready ? 'ready' : 'not_ready',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      timestamp: new Date().toISOString(),
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[healthcheck] listening on :${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[healthcheck] SIGTERM received, shutting down');
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('[healthcheck] SIGINT received, shutting down');
  server.close(() => process.exit(0));
});
