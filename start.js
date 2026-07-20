#!/usr/bin/env node
const http = require('http');
const { spawn } = require('child_process');
const PORT = parseInt(process.env.PORT || '3000', 10);
const proxy = http.createServer((req, res) => {
  if (['/api/health','/api/ready','/health','/ready'].includes(req.url)) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  // Next.js 15.5.16 DNS-rebinding check compares incoming Host header against HOSTNAME.
  // Override host to match the internal bind address; preserve real host via x-forwarded-host.
  const forwardedHeaders = {
    ...req.headers,
    'host':               '127.0.0.1:3001',
    'x-forwarded-host':  req.headers['x-forwarded-host']  || req.headers['host'] || '',
    'x-forwarded-proto': req.headers['x-forwarded-proto'] || 'https',
    'x-forwarded-for':   req.headers['x-forwarded-for']   || req.socket.remoteAddress || '127.0.0.1',
  };
  const p = http.request({ hostname:'127.0.0.1', port:3001, path:req.url, method:req.method, headers:forwardedHeaders },
    r => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  p.on('error', () => { res.writeHead(503); res.end('starting'); });
  req.pipe(p);
});
proxy.listen(PORT, '0.0.0.0', () => console.log('[proxy] listening'));

// Run DB migrations before starting Next.js (non-blocking on failure)
const { execFileSync } = require('child_process');
try {
  execFileSync('node', ['scripts/migrate-standalone.js'], {
    env: process.env, stdio: 'inherit', cwd: __dirname, timeout: 60000,
  });
} catch (e) {
  console.error('[migrate] error during startup migration (continuing):', e.message);
}

spawn('node', ['server.js'], { env: { ...process.env, PORT: '3001', HOSTNAME: '127.0.0.1' }, stdio: 'inherit', cwd: __dirname });

// ── Safety heartbeat ─────────────────────────────────────────────────────
// Планировщик GitHub Actions (schedule */5) — best-effort: под нагрузкой он
// задерживал сейсмо/цунами-ингест на 1–3 часа вместо 5 минут (монитор молчал
// часами при SLA ≤5 мин). Этот всегда-живой супервизор сам дёргает серверный
// ингест каждые 5 минут: сервер напрямую тянет USGS + МЧС RSS (эти источники
// хостинг не блокирует), поэтому землетрясения и цунами свежие ≤5 мин
// независимо от GitHub. Telegram КБГС по-прежнему добирает GitHub-воркфлоу
// (t.me для хостинга гео-заблокирован). Секрет из коробки не уходит.
const SAFETY_INGEST_INTERVAL_MS = 5 * 60 * 1000;

function triggerSafetyIngest() {
  const secret = process.env.CRON_SECRET;
  if (!secret) return;
  const r = http.request({
    hostname: '127.0.0.1',
    port: 3001,
    path: '/api/cron/safety-ingest',
    method: 'GET',
    // server.js (Next 15) сверяет Host с HOSTNAME=127.0.0.1 (DNS-rebinding guard)
    headers: { 'host': '127.0.0.1:3001', 'authorization': `Bearer ${secret}` },
    timeout: 90000,
  }, res => {
    res.resume(); // сливаем тело, не копим в памяти
    if (res.statusCode !== 200) console.error(`[safety-heartbeat] HTTP ${res.statusCode}`);
  });
  r.on('timeout', () => { console.error('[safety-heartbeat] timeout'); r.destroy(); });
  r.on('error', e => console.error('[safety-heartbeat] error:', e.message));
  r.end();
}

if (process.env.CRON_SECRET) {
  // Пауза на прогрев server.js, затем сразу прогон и далее каждые 5 минут.
  setTimeout(() => {
    triggerSafetyIngest();
    setInterval(triggerSafetyIngest, SAFETY_INGEST_INTERVAL_MS);
  }, 45000);
  console.log('[safety-heartbeat] scheduled every 5 min');
} else {
  console.error('[safety-heartbeat] CRON_SECRET not set — in-process heartbeat disabled');
}
