#!/usr/bin/env node
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = parseInt(process.env.PORT || '3000', 10);
const SERVER_PORT = 3001;

// Proxy: health checks answered immediately; real requests forwarded to Next.js.
// host header fixed to '127.0.0.1' — required by Next.js 15 DNS-rebinding check.
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
proxy.listen(PORT, '0.0.0.0', () => process.stdout.write('[proxy] listening on :' + PORT + '\n'));

// Run DB migrations before starting Next.js (non-blocking on failure).
const migrateScript = path.join(__dirname, 'scripts', 'migrate-standalone.js');
if (fs.existsSync(migrateScript)) {
  try {
    execFileSync('node', [migrateScript], {
      env: process.env, stdio: 'inherit', cwd: __dirname, timeout: 60000,
    });
  } catch (e) {
    process.stderr.write('[migrate] error during startup (continuing): ' + e.message + '\n');
  }
}

// Detect which server binary to use:
//
//   1. Our Dockerfile (multi-stage):
//      .next/standalone/ → /app/, so server.js is at /app/server.js
//
//   2. Timeweb buildpack (npm ci → npm run build → npm start):
//      server.js is at /app/.next/standalone/server.js
//      Static assets must be copied into the standalone dir before starting.
//
//   3. Last resort: `next start`

const standaloneAtRoot  = path.join(__dirname, 'server.js');
const standaloneInBuild = path.join(__dirname, '.next', 'standalone', 'server.js');
const nextBin           = path.join(__dirname, 'node_modules', '.bin', 'next');

let child;

if (fs.existsSync(standaloneAtRoot)) {
  // Case 1: Our multi-stage Docker build
  process.stdout.write('[start] mode=docker-standalone\n');
  child = spawn('node', [standaloneAtRoot], {
    env: { ...process.env, PORT: String(SERVER_PORT), HOSTNAME: '127.0.0.1' },
    stdio: 'inherit',
    cwd: __dirname,
  });

} else if (fs.existsSync(standaloneInBuild)) {
  // Case 2: Timeweb buildpack — standalone server exists, copy static files first
  process.stdout.write('[start] mode=timeweb-standalone\n');
  const standaloneDir = path.join(__dirname, '.next', 'standalone');

  const copies = [
    { src: path.join(__dirname, '.next', 'static'), dst: path.join(standaloneDir, '.next', 'static') },
    { src: path.join(__dirname, 'public'),           dst: path.join(standaloneDir, 'public') },
  ];
  for (const { src, dst } of copies) {
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      try {
        fs.cpSync(src, dst, { recursive: true });
        process.stdout.write('[start] copied ' + path.basename(src) + ' -> standalone/\n');
      } catch (e) {
        process.stderr.write('[start] copy failed (' + path.basename(src) + '): ' + e.message + '\n');
      }
    }
  }

  child = spawn('node', [standaloneInBuild], {
    env: { ...process.env, PORT: String(SERVER_PORT), HOSTNAME: '127.0.0.1' },
    stdio: 'inherit',
    cwd: standaloneDir,
  });

} else {
  // Case 3: Fallback
  process.stdout.write('[start] mode=next-start (fallback)\n');
  child = spawn('node', [nextBin, 'start', '-p', String(SERVER_PORT), '-H', '127.0.0.1'], {
    env: { ...process.env, PORT: String(SERVER_PORT), HOSTNAME: '127.0.0.1' },
    stdio: 'inherit',
    cwd: __dirname,
  });
}

child.on('error', err => process.stderr.write('[server] failed to start: ' + err.message + '\n'));
child.on('exit', (code, signal) => {
  process.stderr.write('[server] exited: code=' + code + ' signal=' + signal + '\n');
  process.exit(code || 1);
});
