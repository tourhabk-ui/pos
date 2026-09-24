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
  // ДОЛГ, записанный 08.09 при разборе #1717 — не чинится здесь намеренно.
  //
  // Порядок «миграция до server.js» соблюдён, но защёлки нет: упавшая
  // миграция НЕ останавливает старт, и контейнер поднимается с новым кодом
  // на старой схеме. Раньше это стоило молчащей фичи. С миграцией 943 цена
  // выросла: без колонки operator_bookings.access_token ломается СОЗДАНИЕ
  // брони (`RETURNING access_token`), то есть путь до денег.
  //
  // Три выхода, решает владелец: падать при отказе migrate; отвечать 503 на
  // readiness, пока схема отстаёт; либо оставить как есть и ловить пробой
  // после выката (сейчас так — .github/triggers/probe-url.json различает
  // 404 «ключ не подошёл» и 503 «проверка не смогла выполниться»).
  //
  // Пока выхода нет, «миграция до старта» даёт ЛОЖНОЕ чувство защёлки, и
  // эта строка существует, чтобы следующий читатель не принял её за неё.
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
// Расширено 29.08 с одного ингеста на весь safety-разряд. Повод — замер:
// планировщик GitHub доставлял 1-4% запрошенного (safety-ingest просит 288
// прогонов в сутки, получал 2-4), и четыре safety-крона молчали по 4-6 часов
// при зелёных прогонах, живом секрете и работающем проде. Сломана была
// доставка расписания, а не что-либо чинимое с нашей стороны.
//
// Дубля не будет: эти роуты сперва берут аренду окна
// (lib/agents/cron-lease.ts), и второй планировщик в том же окне уходит с
// названной причиной. Именно аренда делает безопасным то, что источников
// запуска теперь трое — GitHub, cron-job.org и вот этот супервизор.
// Исключение ровно одно — `safety-ingest`: аренды он не берёт, потому что
// повторный прогон у него безвреден ДОКАЗАННО (контент-дедуп плюс
// `ON CONFLICT (external_id) DO NOTHING` в seismic-parser, проверено на
// настоящем PostgreSQL в tests/integration/alert-dedup.pg.test.ts). Сторож
// `cron-second-leg` требует, чтобы эта улика была на месте: исчезнет она —
// исключение перестанет действовать.
//
// Слабое место названо прямо: если прод лежит, не идёт ни один из них И
// не идёт Watchdog, который об этом сообщил бы. Независимая конечность —
// по-прежнему GitHub с cron-job.org; здесь мы чиним частоту, а не надзор.
//
// ── Расширение 21.09: рычаг тот же, адресатов больше ─────────────────────
//
// Владелец спросил, почему трое суток нет ни сейсмики, ни предупреждений по
// вулканам. Замер по Actions API за 5,3 суток: `cron-safety-ingest` дал 40
// прогонов вместо 1524 (медианный разрыв 188 минут при объявленных пяти),
// `cron-safety-heartbeat` — 6 вместо 30. То есть сведение семи файлов в один
// 20.09 голодание НЕ сняло: рычаг не в числе расписаний, а в том, что запуск
// вообще живёт у GitHub.
//
// Заодно снята собственная ложная тревога. Измерив `cron-watchdog.yml` (30
// прогонов вместо 203), я готов был доложить, что SOS-таймаут с порогом 15
// минут опаздывает в шесть раз. Неправда: `/api/cron/watchdog` стоит в этом
// списке с 29.08 и идёт каждые 30 минут независимо от GitHub. Мерить надо
// было обе ноги, а не одну.
//
// Но у тех, кто в списке НЕ стоял, второй ноги и правда не было — и именно
// они давали тревоги: «Volcano OS Worker не отмечался 3ч» (20.09), «Volcano
// OS Merge Gate не отмечался 5ч» (21.09), health молчал 3–5 ч при
// объявленном часе (19.09, разбор «Наблюдатель без наблюдателя»). Из семи
// кронов, сведённых 20.09, прод-дублёр был у трёх; добавлены остальные
// четыре и health.
//
// Merge Gate сюда НЕ добавлен и добавлен быть не может: он гейт пул-реквестов
// и живёт на стороне GitHub по своей природе. Его простой этим не лечится.
//
// Цена входа: аренду окна (lib/agents/cron-lease.ts) до 21.09 брали только
// четыре роута из шести, а из пяти новых — ни один. Без неё «второй
// планировщик» означал бы не запас, а вред: health слал бы один и тот же
// алерт дважды (у tgAlert дедупа нет), а leads-process — гонку двух прогонов
// за одним лидом, то есть два вызова LLM и два предложения на одну заявку
// (проверка `status = 'ai_processing'` стоит ПОСЛЕ выборки и от гонки не
// защищает). Поэтому аренда заведена всем пяти в том же коммите: запас без
// замка — это не запас.
const SAFETY_JOBS = [
  { path: '/api/cron/safety-ingest',     everyMin: 5,  timeoutMs: 120000, startAfterMs: 45000 },
  { path: '/api/cron/sos-events-bridge', everyMin: 30, timeoutMs: 60000,  startAfterMs: 60000 },
  { path: '/api/cron/danger-analysis',   everyMin: 30, timeoutMs: 180000, startAfterMs: 90000 },
  { path: '/api/cron/rescue',            everyMin: 30, timeoutMs: 180000, startAfterMs: 120000 },
  { path: '/api/cron/watchdog',          everyMin: 30, timeoutMs: 120000, startAfterMs: 150000 },
  { path: '/api/cron/checkin-watchdog',  everyMin: 60, timeoutMs: 120000, startAfterMs: 180000 },
  // Добавлены 21.09. Таймауты — те же, что стоят в cron-safety-heartbeat.yml
  // и cron-health.yml: вторая нога не должна ждать МЕНЬШЕ workflow, иначе
  // супервизор перестанет ждать раньше, чем крон успеет, и запишет отказ
  // там, где его нет — то есть два планировщика вынесут разный приговор
  // одному коду.
  //
  // Тем же правилом подняты два старых значения, расходившихся в опасную
  // сторону с 29.08: safety-ingest ждал 90 с при 120 у workflow,
  // checkin-watchdog — 60 при 120. Нашёл их сторож `cron-second-leg`, а не
  // глаз: пока список ног никто не сверял с workflow, расхождение было
  // невидимым. Дать больше времени безвредно — работу всё равно ограничивает
  // `maxDuration` самого роута.
  { path: '/api/cron/kernel-worker',             everyMin: 30, timeoutMs: 180000, startAfterMs: 210000 },
  { path: '/api/cron/leads-process',             everyMin: 30, timeoutMs: 120000, startAfterMs: 240000 },
  { path: '/api/cron/telegram-webhook-watchdog', everyMin: 30, timeoutMs: 30000,  startAfterMs: 270000 },
  { path: '/api/cron/channel-sync',              everyMin: 30, timeoutMs: 120000, startAfterMs: 300000 },
  { path: '/api/cron/health',                    everyMin: 60, timeoutMs: 60000,  startAfterMs: 330000 },
  // Сводка вулканов КФ ЕГС для радара (24.09, «показывай обе шкалы»).
  // Суточная сводка — раз в час хватает; аренда окна 60 мин в роуте.
  { path: '/api/cron/emsd-vmon-sync',            everyMin: 60, timeoutMs: 60000,  startAfterMs: 360000 },
];

function triggerCron(job) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return;
  const r = http.request({
    hostname: '127.0.0.1',
    port: 3001,
    path: job.path,
    method: 'GET',
    // server.js (Next 15) сверяет Host с HOSTNAME=127.0.0.1 (DNS-rebinding guard)
    headers: { 'host': '127.0.0.1:3001', 'authorization': `Bearer ${secret}` },
    timeout: job.timeoutMs,
  }, res => {
    res.resume(); // сливаем тело, не копим в памяти
    if (res.statusCode !== 200) console.error(`[safety-heartbeat] ${job.path} HTTP ${res.statusCode}`);
  });
  r.on('timeout', () => { console.error(`[safety-heartbeat] ${job.path} timeout`); r.destroy(); });
  r.on('error', e => console.error(`[safety-heartbeat] ${job.path} error:`, e.message));
  r.end();
}

if (process.env.CRON_SECRET) {
  // Разнесённые старты: два ядра на контейнер, и одновременный залп шести
  // задач конкурировал бы с обслуживанием живых запросов.
  for (const job of SAFETY_JOBS) {
    setTimeout(() => {
      triggerCron(job);
      setInterval(() => triggerCron(job), job.everyMin * 60 * 1000);
    }, job.startAfterMs);
  }
  console.log(`[safety-heartbeat] scheduled ${SAFETY_JOBS.length} safety crons in-process`);
} else {
  console.error('[safety-heartbeat] CRON_SECRET not set — in-process heartbeat disabled');
}
