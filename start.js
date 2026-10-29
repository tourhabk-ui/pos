#!/usr/bin/env node
const http = require('http');
const { spawn } = require('child_process');
const { pipeline } = require('stream');
const zlib = require('zlib');
const PORT = parseInt(process.env.PORT || '3000', 10);

// ── Сжатие ответов, которые Next отдаёт несжатыми ─────────────────────────
// Замер 02.10 на проде: страницы и /_next/static приходят gzip, а ответы
// Route Handlers (весь /api/*, sitemap.xml, llms.txt) — сырыми, хотя
// compress: true стоит в next.config.js. /map тянул 341 КБ JSON маршрутов
// там, где gzip даёт 73 КБ; sitemap.xml — 176 КБ. Сжимаем здесь, на прокси,
// только то, что Next не сжал сам (нет content-encoding), только текстовые
// типы и без text/event-stream: SSE через сжатие рвётся у промежуточных
// узлов. Каждая порция сбрасывается сразу (Z_SYNC_FLUSH), поэтому потоковые
// ответы чата остаются потоковыми. Сторож: tests/unit/proxy-compress.test.ts.
// <shouldGzip>
const GZIP_TYPES = /^(application\/(json|xml|javascript|geo\+json|manifest\+json|ld\+json|rss\+xml|atom\+xml)|text\/(plain|xml|css|javascript|csv|html)|image\/svg\+xml)\b/i;
function shouldGzip(method, status, headers, acceptEncoding) {
  if (method === 'HEAD') return false;
  if (status < 200 || status === 204 || status === 206 || status === 304) return false;
  if (headers['content-encoding']) return false;
  if (!/\bgzip\b/i.test(String(acceptEncoding || ''))) return false;
  if (!GZIP_TYPES.test(String(headers['content-type'] || ''))) return false;
  if (/no-transform/i.test(String(headers['cache-control'] || ''))) return false;
  if (headers['content-length'] !== undefined && Number(headers['content-length']) < 1024) return false;
  return true;
}
// </shouldGzip>
// ── Надзор за Next ────────────────────────────────────────────────────────
// До 14.10 Next запускался голым spawn без обработчика выхода, а /api/health
// прокси отвечал 200 безусловно. Умри Next (убит по памяти, упёрся в предел
// кучи) — прокси продолжал отвечать «ok» на проверку здоровья и 503 «starting»
// на всё остальное, а задачи SAFETY_JOBS ниже звонили в мёртвый порт.
// Контейнер выглядел здоровым, перезапускать его было некому: сайт и сторожа
// стояли бы до следующего выката. Случалось ли это на проде, не установлено —
// /api/health о таком падении молчал по построению.
//
// Теперь прокси поднимает Next заново: пауза растёт с каждым быстрым падением
// (1, 2, 4… до 30 с), и /api/health говорит правду — 503, пока Next лежит или
// падает по кругу. Пока Next запускается, ответ по-прежнему 200: проверка
// здоровья Timeweb ждёт выката не дольше трёх минут (Dockerfile).
// Сторож — tests/unit/next-supervisor.test.ts: функция на граничных данных и
// настоящий start.js с подставным server.js.
// <nextSupervisor>
const RESTART_BASE_MS = 1000;
const RESTART_MAX_MS = 30000;
// Прожил меньше минуты — выход «быстрый». Три быстрых подряд — петля падений:
// следующий запуск, скорее всего, упадёт так же, и 200 был бы неправдой.
const QUICK_EXIT_MS = 60000;
const CRASH_LOOP_EXITS = 3;

function createNextSupervisor({ spawnChild, setTimer, clearTimer, now, log, onStopped }) {
  let child = null;
  let timer = null;
  let state = 'starting';
  let startedAt = 0;
  let restarts = 0;
  let quickExits = 0;
  let lastExit = null;

  function onExit(c, code, signal) {
    if (c !== child) return; // 'error' и 'exit' одного процесса — один выход
    child = null;
    const lived = now() - startedAt;
    lastExit = { code, signal, lived_s: Math.round(lived / 1000), at: new Date(now()).toISOString() };
    if (state === 'stopping') { state = 'stopped'; onStopped(); return; }
    quickExits = lived < QUICK_EXIT_MS ? quickExits + 1 : 0;
    restarts += 1;
    state = 'down';
    const delay = Math.min(RESTART_BASE_MS * 2 ** quickExits, RESTART_MAX_MS);
    log(`[next] Next завершился (code ${code}, signal ${signal}), прожив ${lastExit.lived_s} с; перезапуск №${restarts} через ${delay} мс`);
    timer = setTimer(start, delay);
  }

  function start() {
    timer = null;
    if (state === 'stopping' || state === 'stopped') return;
    const c = spawnChild();
    child = c;
    state = 'running';
    startedAt = now();
    c.once('exit', (code, signal) => onExit(c, code, signal));
    c.on('error', (e) => {
      log(`[next] ошибка процесса Next: ${e.message}`);
      // Не запустился вовсе — это тоже выход, иначе перезапуска не будет.
      if (c.pid === undefined) onExit(c, null, null);
    });
  }

  function stop(signal) {
    if (state === 'stopping' || state === 'stopped') return;
    if (timer !== null) { clearTimer(timer); timer = null; }
    if (child) { state = 'stopping'; child.kill(signal); return; }
    state = 'stopped';
    onStopped();
  }

  function health() {
    const t = now();
    const running = state === 'running';
    const crashLoop = quickExits >= CRASH_LOOP_EXITS && !(running && t - startedAt >= QUICK_EXIT_MS);
    const ok = (state === 'starting' || running) && !crashLoop;
    return {
      status: ok ? 200 : 503,
      body: {
        status: ok ? 'ok' : 'down',
        next: {
          state: crashLoop ? 'crash_loop' : state,
          uptime_s: running ? Math.round((t - startedAt) / 1000) : null,
          restarts,
          last_exit: lastExit,
        },
      },
    };
  }

  return { start, stop, health };
}
// </nextSupervisor>

const nextSupervisor = createNextSupervisor({
  // MIGRATIONS_STARTUP_STATE — исход наката для /api/cron/health (A08): Next
  // запускается после наката, и перезапуски несут то же состояние.
  spawnChild: () => spawn('node', ['server.js'], { env: { ...process.env, PORT: '3001', HOSTNAME: '127.0.0.1', MIGRATIONS_STARTUP_STATE: JSON.stringify(migrationsState) }, stdio: 'inherit', cwd: __dirname }),
  setTimer: setTimeout,
  clearTimer: clearTimeout,
  now: Date.now,
  log: (m) => console.error(m),
  onStopped: () => process.exit(0),
});

// pipeline, а не pipe: умри Next посреди ответа, pipe оставлял клиента висеть
// над недописанным ответом, пока тот не сдавался сам (замер 14.10: curl ждал
// до своего таймаута). pipeline рвёт соединение клиенту. Обрыв не пишется в
// лог отдельно: это либо ушедший клиент (норма), либо выход Next — о нём уже
// пишет надзор строкой [next].
function streamDone() {}

const proxy = http.createServer((req, res) => {
  if (['/api/health','/api/ready','/health','/ready'].includes(req.url)) {
    // Отвечает прокси, а не Next: пока Next запускается, тот молчит. Но ответ
    // называет состояние Next, а uptime_s — время с запуска контейнера.
    // migrations — исход наката при старте (A08); на код ответа не влияет.
    const h = nextSupervisor.health();
    res.writeHead(h.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ...h.body, uptime_s: Math.round(process.uptime()), migrations: migrationsState }));
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
    r => {
      if (shouldGzip(req.method, r.statusCode, r.headers, req.headers['accept-encoding'])) {
        const headers = { ...r.headers, 'content-encoding': 'gzip' };
        delete headers['content-length'];
        headers['vary'] = headers['vary'] ? `${headers['vary']}, Accept-Encoding` : 'Accept-Encoding';
        if (typeof headers['etag'] === 'string' && !headers['etag'].startsWith('W/')) headers['etag'] = `W/${headers['etag']}`;
        res.writeHead(r.statusCode, headers);
        const gz = zlib.createGzip({ level: 6, flush: zlib.constants.Z_SYNC_FLUSH });
        gz.on('error', (e) => { console.error('[proxy] gzip error:', e.message); res.destroy(); });
        pipeline(r, gz, res, streamDone);
        return;
      }
      res.writeHead(r.statusCode, r.headers);
      pipeline(r, res, streamDone);
    });
  p.on('error', () => { res.writeHead(503); res.end('starting'); });
  req.pipe(p);
});
proxy.listen(PORT, '0.0.0.0', () => console.log('[proxy] listening'));

// ── Накат миграций до старта Next (аудит 15.10, A08 — ответ на вопрос 8) ──
//
// Долг 08.09 (#1717): упавшая миграция старт не останавливала, контейнер
// поднимался с новым кодом на старой схеме, а catch писал «(continuing)» в лог
// выката, который никто не читает. Цена росла: с 943 без колонки
// operator_bookings.access_token ломается СОЗДАНИЕ брони.
//
// Выходов было три: падать, отвечать 503 на readiness, работать громко.
// Выбран третий. Упади процесс или проверка готовности — в цикле перезапусков
// лягут SOS-мост, сейсмо-ингест и офлайн-пакеты поля (SAFETY_JOBS ниже), а
// они важнее новой фичи, которой нужна колонка. Поэтому сервер стартует, но
// отказ называется везде, где его прочтут:
//  - /api/health этого прокси отдаёт migrations: ok | failed | unknown, имя
//    файла и SQLSTATE — без текста ошибки: сообщение PostgreSQL умеет
//    цитировать значения, а значением бывает телефон туриста. Код ответа
//    по-прежнему судит только Next (иначе Timeweb снял бы контейнер);
//  - Next получает то же состояние в env MIGRATIONS_STARTUP_STATE, и крон
//    /api/cron/health будит владельца CRIT-ом, пока контейнер так живёт;
//  - сверка deploy.yml не пишет запись выката образу с failed.
// Раннер ничего о себе не сообщил — «неизвестно», а не «ok» (§4.0).
// Сторож — tests/unit/start-migrations-state.test.ts: правило на граничных
// данных и настоящий start.js с подставным раннером.
// <migrationsState>
const MIGRATE_TIMEOUT_DEFAULT_MS = 60000;
// Пределы — не вкус. execFileSync держит цикл событий, и прокси на время
// наката не отвечает даже на /api/health, а проверка здоровья Timeweb ждёт
// выката не дольше трёх минут (Dockerfile). Накат дольше 150 с сам уронил бы
// выкат; меньше секунды — опечатка, а не намерение.
const MIGRATE_TIMEOUT_MIN_MS = 1000;
const MIGRATE_TIMEOUT_MAX_MS = 150000;

/** Таймаут наката из env: пусто — умолчание; мусор — умолчание и строка в лог. */
function migrateTimeoutMs(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { ms: MIGRATE_TIMEOUT_DEFAULT_MS, warning: null };
  const text = String(raw).trim();
  const n = Number(text);
  if (/^\d+$/.test(text) && n >= MIGRATE_TIMEOUT_MIN_MS && n <= MIGRATE_TIMEOUT_MAX_MS) return { ms: n, warning: null };
  return {
    ms: MIGRATE_TIMEOUT_DEFAULT_MS,
    warning: `MIGRATE_TIMEOUT_MS «${text.slice(0, 40)}» — не целое число миллисекунд от ${MIGRATE_TIMEOUT_MIN_MS} до ${MIGRATE_TIMEOUT_MAX_MS}; беру ${MIGRATE_TIMEOUT_DEFAULT_MS}`,
  };
}

// Отчёт раннера уходит в открытый /api/health — каждое поле проходит форму:
// имя файла миграции и SQLSTATE, ничего больше.
const MIGRATION_FILE_RE = /^[A-Za-z0-9_.-]{1,200}\.sql$/;
const SQLSTATE_RE = /^(?:[0-9][0-9A-Z]|XX|P0|HV|F0)[0-9A-Z]{3}$/;
const cleanFile = (v) => (typeof v === 'string' && MIGRATION_FILE_RE.test(v) ? v : null);
const cleanSqlstate = (v) => (typeof v === 'string' && SQLSTATE_RE.test(v) ? v : null);

/**
 * Исход наката. exec — как кончился раннер: null — кодом 0, иначе
 * { timedOut, status, signal }; report — что раннер записал о себе
 * (scripts/migrate-standalone.js, MIGRATE_STATE_FILE) или null.
 */
function migrationsOutcome(exec, report, at) {
  const r = report && typeof report === 'object' && !Array.isArray(report) ? report : null;
  const phase = r ? r.phase : null;
  const failed = r && Array.isArray(r.failed) ? r.failed.filter((f) => f && typeof f === 'object') : [];
  const first = failed[0] || null;
  const out = { state: 'unknown', reason: 'no_report', file: null, sqlstate: null, failed_count: null, at };
  if (exec) {
    // Раннер оборван или упал сам. Файл — тот, на котором он стоял, иначе
    // первый упавший; не известен — null, и это «неизвестно какой», а не «никакой».
    const signal = typeof exec.signal === 'string' && /^[A-Z0-9]+$/.test(exec.signal) ? exec.signal : null;
    const reason = exec.timedOut ? 'timeout'
      : Number.isInteger(exec.status) ? `exit_${exec.status}`
      : signal ? `signal_${signal}` : 'spawn_failed';
    return {
      ...out,
      state: 'failed',
      reason,
      file: phase === 'running' ? cleanFile(r.file) : first ? cleanFile(first.file) : null,
      sqlstate: phase === 'fatal' ? cleanSqlstate(r.sqlstate) : first ? cleanSqlstate(first.sqlstate) : null,
      failed_count: failed.length > 0 ? failed.length : null,
    };
  }
  if (phase === 'done') {
    if (!Number.isInteger(r.errors) || r.errors < 0) return { ...out, reason: 'report_malformed' };
    if (r.errors === 0) return { ...out, state: 'ok', reason: 'applied', failed_count: 0 };
    return { ...out, state: 'failed', reason: 'file_failed', file: first ? cleanFile(first.file) : null, sqlstate: first ? cleanSqlstate(first.sqlstate) : null, failed_count: r.errors };
  }
  // Раннер не дошёл до базы — до файлов не дошло, и отстаёт ли схема, не
  // известно: неприменённых миграций могло не быть вовсе. Это «не знаю», а не
  // «схема отстаёт» (§4.0; ревью A08): иначе выкат без единой новой миграции
  // назывался бы отстающим, а тревога — ложной.
  if (phase === 'fatal') return { ...out, state: 'unknown', reason: 'fatal', sqlstate: cleanSqlstate(r.sqlstate) };
  // Вышел кодом 0, а последнее слово — «начинаю файл»: до итога не дошёл.
  if (phase === 'running') return { ...out, state: 'failed', reason: 'interrupted', file: cleanFile(r.file) };
  if (phase === 'skipped') return { ...out, reason: r.reason === 'no_database_url' ? 'no_database_url' : 'skipped' };
  return out;
}
// </migrationsState>

// Пока накат не кончился, состояние не известно (ответить в это время прокси
// всё равно не может — см. пределы таймаута выше).
let migrationsState = { state: 'unknown', reason: 'not_finished', file: null, sqlstate: null, failed_count: null, at: null };

function runStartupMigrations() {
  const { execFileSync } = require('child_process');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const timeout = migrateTimeoutMs(process.env.MIGRATE_TIMEOUT_MS);
  if (timeout.warning) console.error(`[migrate] ${timeout.warning}`);
  const stateFile = path.join(os.tmpdir(), `vedar-migrate-state-${process.pid}.json`);
  // Чужой отчёт прошлого процесса с тем же pid за свой не сходит.
  const removeStateFile = () => {
    try {
      fs.rmSync(stateFile, { force: true });
    } catch (e) {
      console.error(`[migrate] файл отчёта раннера не удалён (${e.code || e.name})`);
    }
  };
  removeStateFile();
  let exec = null;
  try {
    execFileSync('node', ['scripts/migrate-standalone.js'], {
      env: { ...process.env, MIGRATE_STATE_FILE: stateFile }, stdio: 'inherit', cwd: __dirname, timeout: timeout.ms,
    });
  } catch (e) {
    exec = { timedOut: e.code === 'ETIMEDOUT', status: typeof e.status === 'number' ? e.status : null, signal: e.signal || null };
  }
  let report = null;
  try {
    report = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch (e) {
    // Нет файла — раннер о себе не сообщил (исход «неизвестно» скажет сам).
    // Есть, но не читается — назвать, иначе «неизвестно» без причины.
    if (e.code !== 'ENOENT') console.error(`[migrate] отчёт раннера не прочитан (${e.code || e.name})`);
  }
  removeStateFile();
  const s = migrationsOutcome(exec, report, new Date().toISOString());
  if (s.state === 'failed') {
    console.error(`[migrate] НАКАТ НЕ ЗАВЕРШЁН (${s.reason}${exec && exec.timedOut ? `, таймаут ${timeout.ms} мс` : ''}): файл ${s.file || 'неизвестно'}${s.sqlstate ? `, SQLSTATE ${s.sqlstate}` : ''}. Сервер стартует на прежней схеме; /api/health отдаёт migrations.state=failed.`);
  } else if (s.state === 'unknown') {
    console.error(`[migrate] исход наката неизвестен (${s.reason}); /api/health отдаёт migrations.state=unknown.`);
  }
  return s;
}

try {
  migrationsState = runStartupMigrations();
} catch (e) {
  // Сломался учёт, а не накат: старт Next он задержать не вправе.
  migrationsState = { ...migrationsState, reason: 'state_error', at: new Date().toISOString() };
  console.error(`[migrate] исход наката не установлен — сбой учёта в start.js (${e && e.name})`);
}
nextSupervisor.start();

// ── Остановка контейнера ─────────────────────────────────────────────────
// Docker шлёт SIGTERM главному процессу — этому прокси. Обработчика не было,
// и Next сигнала не получал: процесс №1 без обработчика сигнал игнорирует, и
// через 10 с Docker убивал всё SIGKILL посреди начатых ответов. Теперь сигнал
// уходит Next — он дописывает начатое и выходит сам, а за ним прокси. Ждём не
// дольше 8 с, чтобы уйти раньше SIGKILL.
const SHUTDOWN_GRACE_MS = 8000;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.error(`[next] ${sig}: останавливаю Next и выхожу`);
    nextSupervisor.stop(sig);
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
  });
}

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
  // Прогноз Камчатского УГМС (29.10, владелец: «есть же камчатский гидромет»).
  // Две страницы kammeteo.ru раз в час; аренда окна 60 мин — в роуте.
  { path: '/api/cron/ugms-forecast',             everyMin: 60, timeoutMs: 60000,  startAfterMs: 375000 },
  // Проверка дневного бюджета AI (29.09, слово владельца «добавь для бюджета»).
  // Watchdog трижды за день ловил молчание часовых кронов у планировщика GitHub;
  // этот только читает llm_usage_log и шлёт алерт о превышении, денег не трогает,
  // поэтому вторая нога ему безопасна. Аренда окна 60 мин — в роуте: без неё
  // один алерт о превышении ушёл бы дважды. Таймаут не меньше --max-time workflow.
  { path: '/api/cron/llm-budget-check',          everyMin: 60, timeoutMs: 60000,  startAfterMs: 390000 },
  // Восстановление брошенных броней (30.09, слово владельца «go»). Watchdog
  // ловил его молчание у планировщика GitHub (5 ч). Автоотмена не трогает бронь
  // с деньгами (paid_at / payment_status в самом условии роута), сухой прогон
  // 29.09 показал cancelled 0. Аренда окна 60 мин — в роуте, кроме ?dry=1.
  { path: '/api/cron/abandoned-bookings',        everyMin: 60, timeoutMs: 60000,  startAfterMs: 420000 },
  // Последние два safety-крона, шедшие только расписанием GitHub (14.10).
  // Замер по Actions API: KVERT за 10 суток — 30 прогонов из ~41, разрыв до
  // 13,5 ч при объявленных шести. Аренда окна 6 ч — в обоих роутах, таймауты
  // не меньше --max-time workflow.
  { path: '/api/cron/kvert-acc',                 everyMin: 360, timeoutMs: 60000, startAfterMs: 450000 },
  { path: '/api/cron/safety-check',              everyMin: 360, timeoutMs: 60000, startAfterMs: 480000 },
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

// ── Прогрев планов после деплоя ───────────────────────────────────────────
// /plans/[slug] стоит на revalidate 86400, но кэш ISR живёт в контейнере и
// после каждого деплоя пуст: первый посетитель каждой из 17 страниц ждал
// 6–8 с, повторный — 0,45 с (аудит 02.10; деплоев бывает несколько в день).
// Через 90 с после старта читаем /plans, вынимаем ссылки /plans/<slug> и
// обходим их ПО ОДНОЙ: два ядра на контейнер, залп из 17 тяжёлых страниц
// конкурировал бы с живыми запросами. Список планов не дублируется сюда из
// lib/plans/presets (tsx в runner недоступен) — его называет сама страница.
// Сторож: tests/unit/plans-warmup.test.ts.
// <warmPlans>
function fetchLocal(path, timeoutMs) {
  return new Promise((resolve, reject) => {
    const r = http.request({
      hostname: '127.0.0.1', port: 3001, path, method: 'GET',
      headers: { 'host': '127.0.0.1:3001', 'accept': 'text/html' },
      timeout: timeoutMs,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('timeout', () => { r.destroy(new Error('timeout')); });
    r.on('error', reject);
    r.end();
  });
}

async function warmPlans() {
  const hub = await fetchLocal('/plans', 30000);
  if (hub.status !== 200) { console.error(`[warm-plans] /plans HTTP ${hub.status} — прогрев не начат`); return; }
  const slugs = [...new Set([...hub.body.matchAll(/href="\/plans\/([a-z0-9-]+)"/g)].map(m => m[1]))];
  if (slugs.length === 0) { console.error('[warm-plans] на /plans не нашлось ссылок /plans/<slug> — прогревать нечего'); return; }
  let ok = 0, bad = 0;
  const t0 = Date.now();
  for (const slug of slugs) {
    try {
      const r = await fetchLocal(`/plans/${slug}`, 45000);
      if (r.status === 200) ok++; else { bad++; console.error(`[warm-plans] /plans/${slug} HTTP ${r.status}`); }
    } catch (e) { bad++; console.error(`[warm-plans] /plans/${slug} error:`, e.message); }
  }
  console.log(`[warm-plans] прогрето ${ok} из ${slugs.length}, отказов ${bad}, за ${Math.round((Date.now() - t0) / 1000)} с`);
}

setTimeout(() => { warmPlans().catch(e => console.error('[warm-plans] error:', e.message)); }, 90000);
// </warmPlans>
