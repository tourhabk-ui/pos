#!/usr/bin/env node
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = parseInt(process.env.PORT || '3000', 10);
// SERVER_PORT must differ from PORT to avoid bind conflict when Timeweb overrides PORT.
const SERVER_PORT = PORT === 3001 ? 3002 : 3001;

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
  p.on('error', () => {
    const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><title>Starting...</title>' +
      '<meta http-equiv="refresh" content="4"></head><body style="font-family:sans-serif;text-align:center;padding:60px">' +
      '<h2>Vedarai starting up...</h2><p>Refreshing automatically...</p></body></html>';
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '5' });
    res.end(html);
  });
  req.pipe(p);
});
proxy.listen(PORT, '0.0.0.0', () => process.stdout.write('[proxy] listening on :' + PORT + '\n'));

// Run DB migrations before starting Next.js (non-blocking on failure).
const migrateScript = path.join(__dirname, 'scripts', 'migrate-standalone.js');
if (fs.existsSync(migrateScript)) {
  try {
    execFileSync('node', [migrateScript], {
      env: process.env, stdio: 'inherit', cwd: __dirname, timeout: 20000,
    });
  } catch (e) {
    process.stderr.write('[migrate] error (continuing): ' + e.message + '\n');
  }
}

// Detect which server binary to use:
//   1. Our Dockerfile: .next/standalone/ → /app/, so server.js lands at /app/server.js
//   2. Timeweb buildpack: server.js at /app/.next/standalone/server.js, copy static first
//   3. Last resort: next start

const standaloneAtRoot  = path.join(__dirname, 'server.js');
const standaloneInBuild = path.join(__dirname, '.next', 'standalone', 'server.js');
const nextBin           = path.join(__dirname, 'node_modules', '.bin', 'next');

process.stdout.write('[start] dir=' + __dirname + '\n');
process.stdout.write('[start] server.js@root=' + fs.existsSync(standaloneAtRoot) + '\n');
process.stdout.write('[start] server.js@build=' + fs.existsSync(standaloneInBuild) + '\n');
process.stdout.write('[start] node=' + process.version + '\n');

function spawnServer() {
  let cmd, args, cwd, label;

  if (fs.existsSync(standaloneAtRoot)) {
    label = 'docker-standalone';
    cmd   = 'node';
    args  = [standaloneAtRoot];
    cwd   = __dirname;
  } else if (fs.existsSync(standaloneInBuild)) {
    label = 'timeweb-standalone';
    const standaloneDir = path.join(__dirname, '.next', 'standalone');
    const copies = [
      { src: path.join(__dirname, '.next', 'static'), dst: path.join(standaloneDir, '.next', 'static') },
      { src: path.join(__dirname, 'public'),           dst: path.join(standaloneDir, 'public') },
    ];
    for (const { src, dst } of copies) {
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        try { fs.cpSync(src, dst, { recursive: true }); } catch (e) {
          process.stderr.write('[start] copy failed: ' + e.message + '\n');
        }
      }
    }
    cmd  = 'node';
    args = [standaloneInBuild];
    cwd  = standaloneDir;
  } else {
    label = 'next-start';
    cmd   = 'node';
    args  = [nextBin, 'start', '-p', String(SERVER_PORT), '-H', '127.0.0.1'];
    cwd   = __dirname;
  }

  process.stdout.write('[start] mode=' + label + '\n');
  const child = spawn(cmd, args, {
    env: { ...process.env, PORT: String(SERVER_PORT), HOSTNAME: '127.0.0.1' },
    stdio: 'inherit',
    cwd,
  });

  child.on('error', err => {
    process.stderr.write('[server] spawn error: ' + err.message + '\n');
    setTimeout(spawnServer, 3000);
  });

  child.on('exit', (code, signal) => {
    process.stderr.write('[server] exited code=' + code + ' signal=' + signal + ' — restarting in 3s\n');
    setTimeout(spawnServer, 3000);
  });
}

spawnServer();
