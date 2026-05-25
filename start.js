#!/usr/bin/env node
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = parseInt(process.env.PORT || '3000', 10);
// SERVER_PORT must differ from PORT to avoid bind conflict when Timeweb overrides PORT.
const SERVER_PORT = PORT === 3001 ? 3002 : 3001;

process.stdout.write('[start] port=' + PORT + ' server_port=' + SERVER_PORT + ' node=' + process.version + ' pid=' + process.pid + '\n');

// Track whether Next.js is ready to receive traffic.
let serverReady = false;

// Proxy: answers health checks IMMEDIATELY (before Next.js is ready).
// All other traffic forwarded to Next.js on SERVER_PORT.
// While Next.js is starting, non-health requests get a 503 + auto-refresh page.
// host header fixed to '127.0.0.1' — required by Next.js 15 DNS-rebinding check.
const proxy = http.createServer((req, res) => {
  const urlPath = req.url ? req.url.split('?')[0] : '/';

  // Answer health/ready checks from any path that looks like a health check.
  // Timeweb may use / or /api/health or /health — we answer all of them during boot.
  const isHealthPath = ['/api/health', '/api/ready', '/health', '/ready'].includes(urlPath);

  if (isHealthPath || !serverReady) {
    // During boot: health endpoints always 200; other paths get 503 + refresh.
    if (isHealthPath) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', pid: process.pid, ready: serverReady }));
      return;
    }
    // Non-health request while server not ready yet.
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '5' });
    res.end('<!DOCTYPE html><html><head><meta charset="utf-8"><title>Starting…</title>' +
      '<meta http-equiv="refresh" content="4"></head><body style="font-family:sans-serif;text-align:center;padding:60px">' +
      '<h2>Vedarai — starting…</h2><p>Page will refresh automatically.</p></body></html>');
    return;
  }

  const p = http.request(
    { hostname: '127.0.0.1', port: SERVER_PORT, path: req.url, method: req.method,
      headers: { ...req.headers, host: '127.0.0.1',
        'x-forwarded-host':  req.headers['x-forwarded-host']  || req.headers['host'] || '',
        // Default http, not https: Timeweb sets https in prod; avoids https://localhost in local dev.
        'x-forwarded-proto': req.headers['x-forwarded-proto'] || 'http',
        'x-forwarded-for':   req.headers['x-forwarded-for']   || req.socket.remoteAddress || '127.0.0.1' } },
    r => {
      const outHeaders = { ...r.headers };
      // Rewrite internal redirect URLs so browser never sees 127.0.0.1 or localhost
      const loc = outHeaders['location'];
      if (loc && (loc.includes('127.0.0.1') || loc.includes('localhost'))) {
        const publicProto = req.headers['x-forwarded-proto'] || 'http';
        const publicHost  = req.headers['x-forwarded-host']  || req.headers['host'] || '';
        if (publicHost) {
          outHeaders['location'] = loc.replace(
            /https?:\/\/(?:127\.0\.0\.1|localhost)(:\d+)?/,
            publicProto + '://' + publicHost
          );
        }
      }
      res.writeHead(r.statusCode, outHeaders);
      r.pipe(res);
    }
  );
  p.on('error', () => {
    // Next.js dropped — mark not ready so next health check returns 200 but users see loading.
    serverReady = false;
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '5' });
    res.end('<!DOCTYPE html><html><head><meta charset="utf-8"><title>Starting…</title>' +
      '<meta http-equiv="refresh" content="4"></head><body style="font-family:sans-serif;text-align:center;padding:60px">' +
      '<h2>Vedarai — starting…</h2><p>Page will refresh automatically.</p></body></html>');
  });
  req.pipe(p);
});

proxy.on('error', err => {
  process.stderr.write('[proxy] listen error: ' + err.message + '\n');
  process.exit(1);
});

// Bind proxy BEFORE anything else — health checks answered immediately.
proxy.listen(PORT, '0.0.0.0', () =>
  process.stdout.write('[proxy] listening on :' + PORT + '\n'));

// Run migrations ASYNC (spawn, not execFileSync) so event loop is never blocked.
function runMigrations() {
  return new Promise(resolve => {
    const script = path.join(__dirname, 'scripts', 'migrate-standalone.js');
    if (!fs.existsSync(script)) {
      process.stdout.write('[migrate] script not found — skip\n');
      resolve(); return;
    }
    const child = spawn('node', [script], {
      env: process.env, stdio: 'inherit', cwd: __dirname,
    });
    const timer = setTimeout(() => {
      process.stderr.write('[migrate] timeout after 25s — continuing\n');
      child.kill('SIGTERM');
      resolve();
    }, 25000);
    child.on('close', code => {
      clearTimeout(timer);
      process.stdout.write('[migrate] done code=' + code + '\n');
      resolve();
    });
    child.on('error', err => {
      clearTimeout(timer);
      process.stderr.write('[migrate] spawn error: ' + err.message + '\n');
      resolve();
    });
  });
}

// Detect which server binary to use:
//   1. Docker: .next/standalone/ copied to /app/, so server.js at /app/server.js
//   2. Timeweb buildpack: server.js at /app/.next/standalone/server.js
//   3. Last resort: next start
const standaloneAtRoot  = path.join(__dirname, 'server.js');
const standaloneInBuild = path.join(__dirname, '.next', 'standalone', 'server.js');
const nextBin           = path.join(__dirname, 'node_modules', '.bin', 'next');

process.stdout.write('[start] root/server.js=' + fs.existsSync(standaloneAtRoot) +
  ' build/server.js=' + fs.existsSync(standaloneInBuild) + '\n');

function spawnServer() {
  let cmd, args, cwd, label;

  if (fs.existsSync(standaloneAtRoot)) {
    label = 'docker-standalone';
    cmd = 'node'; args = [standaloneAtRoot]; cwd = __dirname;
  } else if (fs.existsSync(standaloneInBuild)) {
    label = 'timeweb-standalone';
    const standaloneDir = path.join(__dirname, '.next', 'standalone');
    for (const [rel, dst] of [
      ['.next/static',  path.join(standaloneDir, '.next', 'static')],
      ['public',        path.join(standaloneDir, 'public')],
    ]) {
      const src = path.join(__dirname, rel);
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        try { fs.cpSync(src, dst, { recursive: true }); }
        catch (e) { process.stderr.write('[start] copy ' + rel + ' failed: ' + e.message + '\n'); }
      }
    }
    cmd = 'node'; args = [standaloneInBuild]; cwd = standaloneDir;
  } else if (fs.existsSync(nextBin)) {
    label = 'next-start';
    cmd = 'node'; args = [nextBin, 'start', '-p', String(SERVER_PORT), '-H', '127.0.0.1'];
    cwd = __dirname;
  } else {
    process.stderr.write('[start] FATAL: no server binary found — exiting\n');
    process.exit(1);
  }

  process.stdout.write('[start] mode=' + label + ' cmd=' + cmd + ' ' + args.join(' ') + '\n');

  const child = spawn(cmd, args, {
    env: { ...process.env, PORT: String(SERVER_PORT), HOSTNAME: '127.0.0.1' },
    stdio: 'inherit', cwd,
  });

  // Poll until Next.js is actually accepting connections, then flip the ready flag.
  function pollReady() {
    const probe = http.request({ hostname: '127.0.0.1', port: SERVER_PORT, path: '/api/health', method: 'GET' }, r => {
      if (r.statusCode < 500) {
        serverReady = true;
        process.stdout.write('[server] ready — forwarding traffic\n');
      } else {
        setTimeout(pollReady, 1000);
      }
      r.resume();
    });
    probe.on('error', () => setTimeout(pollReady, 1000));
    probe.end();
  }
  setTimeout(pollReady, 2000);

  child.on('error', err => {
    process.stderr.write('[server] spawn error: ' + err.message + '\n');
    serverReady = false;
    setTimeout(spawnServer, 3000);
  });
  child.on('exit', (code, signal) => {
    process.stderr.write('[server] exited code=' + code + ' signal=' + signal + ' — restart in 3s\n');
    serverReady = false;
    setTimeout(spawnServer, 3000);
  });
}

// Start migrations and server IN PARALLEL — don't wait 25s for DB timeout before booting.
runMigrations(); // fire-and-forget
spawnServer();
