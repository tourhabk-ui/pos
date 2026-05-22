#!/usr/bin/env node
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = parseInt(process.env.PORT || '3000', 10);
// SERVER_PORT must differ from PORT to avoid bind conflict when Timeweb overrides PORT.
const SERVER_PORT = PORT === 3001 ? 3002 : 3001;

process.stdout.write('[start] port=' + PORT + ' server_port=' + SERVER_PORT + ' node=' + process.version + ' pid=' + process.pid + '\n');

// Proxy: answers health checks IMMEDIATELY (before Next.js is ready).
// All other traffic forwarded to Next.js on SERVER_PORT.
// host header fixed to '127.0.0.1' — required by Next.js 15 DNS-rebinding check.
const proxy = http.createServer((req, res) => {
  if (['/api/health', '/api/ready', '/health', '/ready'].includes(req.url)) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', pid: process.pid }));
    return;
  }
  const p = http.request(
    { hostname: '127.0.0.1', port: SERVER_PORT, path: req.url, method: req.method,
      headers: { ...req.headers, host: '127.0.0.1',
        'x-forwarded-host':  req.headers['x-forwarded-host']  || req.headers['host'] || '',
        'x-forwarded-proto': req.headers['x-forwarded-proto'] || 'https',
        'x-forwarded-for':   req.headers['x-forwarded-for']   || req.socket.remoteAddress || '127.0.0.1' } },
    r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); }
  );
  p.on('error', () => {
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '5' });
    res.end('<!DOCTYPE html><html><head><meta charset="utf-8"><title>Starting…</title>' +
      '<meta http-equiv="refresh" content="4"></head><body style="font-family:sans-serif;text-align:center;padding:60px">' +
      '<h2>Vedarai — starting…</h2><p>Page will refresh automatically.</p></body></html>');
  });
  req.pipe(p);
});

// Bind proxy BEFORE migrations — event loop stays free so health checks are answered.
proxy.listen(PORT, '0.0.0.0', () =>
  process.stdout.write('[proxy] listening on :' + PORT + '\n'));

// Run migrations ASYNC (spawn, not execFileSync) so event loop is never blocked.
// Resolves when done, errors, or times out — server always starts afterwards.
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

  child.on('error', err => {
    process.stderr.write('[server] spawn error: ' + err.message + '\n');
    setTimeout(spawnServer, 3000);
  });
  child.on('exit', (code, signal) => {
    process.stderr.write('[server] exited code=' + code + ' signal=' + signal + ' — restart in 3s\n');
    setTimeout(spawnServer, 3000);
  });
}

runMigrations().then(spawnServer);
