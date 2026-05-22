#!/usr/bin/env node
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = parseInt(process.env.PORT || '3000', 10);
const SERVER_PORT = 3001;

// Proxy: health checks answered immediately; real requests forwarded to Next.js.
// host header fixed to '127.0.0.1' — required by Next.js 15 DNS-rebinding check
// (HOSTNAME=127.0.0.1 on the spawned server rejects any other host value).
const proxy = http.createServer((req, res) => {
  if (['/api/health', '/api/ready', '/health', '/ready'].includes(req.url)) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  const forwardedHeaders = {
    ...req.headers,
    'host':               '127.0.0.1',
    'x-forwarded-host':  req.headers['x-forwarded-host']  || req.headers['host'] || '',
    'x-forwarded-proto': req.headers['x-forwarded-proto'] || 'https',
    'x-forwarded-for':   req.headers['x-forwarded-for']   || req.socket.remoteAddress || '127.0.0.1',
  };
  const p = http.request(
    { hostname: '127.0.0.1', port: SERVER_PORT, path: req.url, method: req.method, headers: forwardedHeaders },
    r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); }
  );
  p.on('error', () => { res.writeHead(503); res.end('starting'); });
  req.pipe(p);
});
proxy.listen(PORT, '0.0.0.0', () => process.stdout.write('[proxy] listening\n'));

// Run DB migrations before starting Next.js (non-blocking on failure).
const migrateScript = path.join(__dirname, 'scripts', 'migrate-standalone.js');
if (fs.existsSync(migrateScript)) {
  try {
    execFileSync('node', [migrateScript], {
      env: process.env, stdio: 'inherit', cwd: __dirname, timeout: 60000,
    });
  } catch (e) {
    process.stderr.write(`[migrate] error during startup (continuing): ${e.message}\n`);
  }
}

// Detect which server binary to use:
//   - Our Dockerfile copies .next/standalone/ → /app/, so server.js lands at /app/server.js
//   - Timeweb's own Dockerfile runs `npm run build` in-place; server.js stays at
//     /app/.next/standalone/server.js and static files remain at /app/.next/static + /app/public
//     → fall back to `next start` which knows the project layout.
const standaloneAtRoot = path.join(__dirname, 'server.js');
const nextBin = path.join(__dirname, 'node_modules', '.bin', 'next');

let child;
if (fs.existsSync(standaloneAtRoot)) {
  // Our multi-stage Docker build (server.js copied to container root)
  child = spawn('node', [standaloneAtRoot], {
    env: { ...process.env, PORT: String(SERVER_PORT), HOSTNAME: '127.0.0.1' },
    stdio: 'inherit',
    cwd: __dirname,
  });
} else {
  // Timeweb build or any build where standalone was not promoted to root.
  // `next start` serves from the standard .next/ output and handles static files correctly.
  child = spawn('node', [nextBin, 'start', '-p', String(SERVER_PORT), '-H', '127.0.0.1'], {
    env: { ...process.env, PORT: String(SERVER_PORT), HOSTNAME: '127.0.0.1' },
    stdio: 'inherit',
    cwd: __dirname,
  });
}

child.on('error', err => process.stderr.write(`[server] failed to start: ${err.message}\n`));
child.on('exit', (code, signal) => {
  if (code !== 0 || signal) {
    process.stderr.write(`[server] exited: code=${code} signal=${signal}\n`);
  }
});
