#!/usr/bin/env node
/**
 * Post-deploy smoke: опубликованный продукт ОТДАЁТ ДАННЫЕ.
 *
 * Зачем это существует. 15–16.08 прод простоял с мёртвым выбором маршрута,
 * и ни одна проверка этого не заметила: unit-тесты зелёные, сборка успешна,
 * `/version.json` отдавал нужный коммит — то есть «задеплоено» было доказано,
 * а «работает» никем не проверялось. Каталог отвечал ошибкой БД, и первый
 * экран планировщика был пуст. Зелёная сборка и живой продукт — разные факты,
 * ровно как «есть точка» и «есть путь».
 *
 * Порядок намеренно такой: ДЕПЛОЙ → СМОУК → отметка здоровья. Проверять
 * новую версию до публикации нечем — до неё её просто нет. Поэтому смоук
 * идёт последним шагом деплоя и красит workflow, если продукт не отвечает;
 * прод при этом остаётся на прежнем контейнере, а факт фиксируется явно,
 * а не растворяется в зелёной галочке.
 *
 * Проверки:
 *   1. Каталог рекомендаций отдаёт непустой список.
 *   2. Первый элемент открывается и содержит не меньше двух валидных точек.
 *   3. MCP: initialize → tools/list → tools/call safety_status.
 *
 * Пишущих вызовов здесь нет и быть не может: смоук идёт по проду, и заявка
 * от него — это настоящая заявка с чужим номером в базе. Список разрешённых
 * инструментов ниже замкнут, а сторож tests/unit/deploy-smoke-gate.test.ts
 * следит, чтобы имена пишущих инструментов не появились в этом файле.
 *
 * Запуск: BASE_URL=https://vedarai.ru node scripts/deploy-smoke.mjs
 */

const BASE = (process.env.BASE_URL || 'https://vedarai.ru').replace(/\/+$/, '');
const TIMEOUT_MS = 20000;

/** Единственные инструменты MCP, которые смоуку позволено звать: только чтение. */
const SMOKE_ALLOWED_MCP_TOOLS = ['safety_status'];

const failures = [];
const notes = [];

function ok(name, detail) {
  console.log(`  OK   ${name}${detail ? ` — ${detail}` : ''}`);
}
function fail(name, detail) {
  console.log(`  FAIL ${name} — ${detail}`);
  failures.push(`${name}: ${detail}`);
}

async function getJson(url, init) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* тело не JSON — вернём как есть */ }
    return { status: res.status, body, text };
  } finally {
    clearTimeout(timer);
  }
}

/* ─── 1. Каталог рекомендаций ────────────────────────────────────────────── */

async function checkCatalog() {
  const url = `${BASE}/api/routes?limit=10&sort=recommended&kind=route&has_waypoints=true`;
  const { status, body, text } = await getJson(url);

  if (status !== 200) {
    fail('каталог', `HTTP ${status}: ${text.slice(0, 200)}`);
    return null;
  }
  if (!body || body.success !== true) {
    // Именно этот случай и был 15.08: HTTP 200, success:false, «Ошибка базы данных».
    fail('каталог', `success не true: ${text.slice(0, 200)}`);
    return null;
  }
  const items = Array.isArray(body.data) ? body.data : [];
  if (items.length === 0) {
    fail('каталог', 'список пуст — первый экран выбора маршрута мёртв');
    return null;
  }
  ok('каталог', `${items.length} маршрутов`);
  return items;
}

/* ─── 2. Деталь пригодного маршрута ──────────────────────────────────────── */

/**
 * Поиск отвечает по существу — отдельная проверка, а не источник удачного
 * примера.
 *
 * Соблазн был такой: перебирать выдачу поиска, пока не найдётся маршрут с
 * двумя координатами, и на нём позеленеть. Так делать нельзя — смоук стал бы
 * охотиться за исправным экземпляром и показывал бы зелёный, даже если
 * сломаны девять маршрутов из десяти. Проверка, которая ищет, чем бы себя
 * удовлетворить, не проверка.
 *
 * Поэтому поиск отвечает только за себя: отвечает ли он и находит ли
 * что-нибудь по заведомо существующему названию.
 */
async function checkSearch() {
  const { status, body, text } = await getJson(
    `${BASE}/api/routes/search?q=${encodeURIComponent('Авачинский')}`,
  );
  if (status !== 200) {
    fail('поиск', `HTTP ${status}: ${text.slice(0, 160)}`);
    return;
  }
  const rows = Array.isArray(body?.routes) ? body.routes : null;
  if (!rows) {
    fail('поиск', `ответ без списка маршрутов: ${text.slice(0, 160)}`);
    return;
  }
  if (rows.length === 0) {
    fail('поиск', '«Авачинский» не нашёл ничего — поиск отвечает, но не работает');
    return;
  }
  ok('поиск', `${rows.length} маршрутов по «Авачинский»`);
}

/**
 * Контракт карточки маршрута — на ОДНОМ заранее выбранном маршруте.
 *
 * Фикстура, а не первый попавшийся из выдачи: тогда проверка отвечает на
 * вопрос «работает ли карточка», а не «нашёлся ли сегодня исправный
 * маршрут». Качество выдачи меряет отдельная проверка ниже — смешивать их
 * значит позволить одной прикрыть другую.
 *
 * Пока фикстура не задана, проверка ЧЕСТНО ПАДАЕТ: невыполненная проверка
 * не имеет права выглядеть зелёной. Первый же прогон подскажет, что вписать
 * (см. «пригодные маршруты» — он печатает id).
 */
async function checkRouteDetailFixture() {
  const fixture = process.env.SMOKE_ROUTE_ID;
  if (!fixture) {
    fail(
      'карточка маршрута (фикстура)',
      'SMOKE_ROUTE_ID не задан — контракт карточки не проверен. '
        + 'Возьмите id из строки «пригодные маршруты» ниже и добавьте в переменные окружения.',
    );
    return;
  }
  await checkRouteDetail({ id: fixture, title: `фикстура ${fixture.slice(0, 8)}` });
}

async function checkRouteDetail(first) {
  if (!first) {
    fail('деталь маршрута', 'кандидата нет');
    return;
  }

  const { status, body, text } = await getJson(`${BASE}/api/routes/${first.id}`);
  if (status !== 200 || !body || body.success !== true) {
    fail('деталь маршрута', `${first.id}: HTTP ${status}, ${text.slice(0, 160)}`);
    return;
  }

  const wps = Array.isArray(body.data?.waypoints) ? body.data.waypoints : [];
  const valid = wps.filter(
    (w) => w && Number.isFinite(Number(w.lat)) && Number.isFinite(Number(w.lng)),
  );
  if (valid.length < 2) {
    // Одна точка — это место, а не маршрут: вести по ней нельзя, и попасть
    // в каталог рекомендаций она не должна была вовсе.
    fail(
      'деталь маршрута',
      `${first.title || first.id}: точек с координатами ${valid.length}, нужно не меньше двух`,
    );
    return;
  }
  ok('деталь маршрута', `${first.title || first.id}: ${valid.length} точек с координатами`);
}

/**
 * Сколько маршрутов в выдаче вообще пригодны для поля.
 *
 * Это ИЗМЕРЕНИЕ, а не подбор: проверка не выбирает удачный экземпляр, она
 * называет долю. Ноль пригодных — падение: выбор маршрута существует, но
 * идти не по чему, и молчать об этом нельзя.
 *
 * Здесь же печатаются id пригодных — из них берётся фикстура SMOKE_ROUTE_ID,
 * чтобы контракт карточки проверялся на заведомо целом маршруте.
 */
async function checkNavigableShare() {
  const { status, body } = await getJson(
    `${BASE}/api/routes/search?q=${encodeURIComponent('Авачинский')}`,
  );
  if (status !== 200 || !Array.isArray(body?.routes) || body.routes.length === 0) {
    fail('пригодные маршруты', 'нечего измерять — поиск не отдал выдачу');
    return;
  }

  const sample = body.routes.filter((r) => r && typeof r.id === 'string').slice(0, 5);
  const navigable = [];

  for (const r of sample) {
    // eslint-disable-next-line no-await-in-loop
    const { status: s, body: b } = await getJson(`${BASE}/api/routes/${r.id}`);
    if (s !== 200 || b?.success !== true) continue;
    const wps = Array.isArray(b.data?.waypoints) ? b.data.waypoints : [];
    const valid = wps.filter(
      (w) => w && Number.isFinite(Number(w.lat)) && Number.isFinite(Number(w.lng)),
    );
    if (valid.length >= 2) navigable.push(r.id);
  }

  if (navigable.length === 0) {
    fail(
      'пригодные маршруты',
      `из ${sample.length} проверенных ни один не имеет двух точек с координатами`,
    );
    return;
  }
  ok('пригодные маршруты', `${navigable.length} из ${sample.length}; годятся в фикстуру: ${navigable.join(', ')}`);
}

/* ─── 3. MCP: рукопожатие и один читающий вызов ──────────────────────────── */

async function mcp(id, method, params) {
  return getJson(`${BASE}/api/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }),
  });
}

async function checkMcp() {
  const init = await mcp(1, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'vedar-deploy-smoke', version: '1.0.0' },
  });
  if (init.status !== 200 || !init.body?.result?.protocolVersion) {
    fail('MCP initialize', `HTTP ${init.status}: ${init.text.slice(0, 160)}`);
    return;
  }
  ok('MCP initialize', `protocol ${init.body.result.protocolVersion}`);

  const list = await mcp(2, 'tools/list');
  const tools = list.body?.result?.tools;
  if (list.status !== 200 || !Array.isArray(tools) || tools.length === 0) {
    fail('MCP tools/list', `HTTP ${list.status}: ${list.text.slice(0, 160)}`);
    return;
  }
  ok('MCP tools/list', `${tools.length} инструментов`);

  const toolName = SMOKE_ALLOWED_MCP_TOOLS[0];
  if (!tools.some((t) => t?.name === toolName)) {
    fail('MCP tools/call', `в каталоге нет читающего инструмента ${toolName}`);
    return;
  }

  const call = await mcp(3, 'tools/call', { name: toolName, arguments: {} });
  if (call.status !== 200) {
    fail('MCP tools/call', `HTTP ${call.status}: ${call.text.slice(0, 160)}`);
    return;
  }
  if (call.body?.error) {
    fail('MCP tools/call', `${toolName}: ${JSON.stringify(call.body.error).slice(0, 160)}`);
    return;
  }
  if (!call.body?.result) {
    fail('MCP tools/call', `${toolName}: ответ без result`);
    return;
  }
  ok('MCP tools/call', `${toolName} ответил`);
  notes.push('Смоук вызвал только читающий инструмент; заявок не создано.');
}

/* ─── Прогон ─────────────────────────────────────────────────────────────── */

console.log(`Post-deploy smoke: ${BASE}`);

// Каждая проверка ловит свой срыв сама: упавший fetch (DNS, обрыв, таймаут) —
// это тоже результат смоука, а не аварийное завершение скрипта. Иначе первая
// же сетевая ошибка обрывала бы прогон, и остальные проверки не выполнялись бы,
// а в логе вместо диагноза был бы стектрейс.
async function run(name, fn) {
  try {
    return await fn();
  } catch (e) {
    fail(name, e instanceof Error ? e.message : String(e));
    return null;
  }
}

await run('каталог', checkCatalog);
await run('поиск', checkSearch);
await run('карточка маршрута (фикстура)', checkRouteDetailFixture);
await run('пригодные маршруты', checkNavigableShare);
await run('MCP', checkMcp);

for (const n of notes) console.log(`  ---  ${n}`);

if (failures.length > 0) {
  console.log('');
  console.log(`Смоук не прошёл (${failures.length}):`);
  for (const f of failures) console.log(`  - ${f}`);
  console.log('');
  console.log('Прод остаётся на прежнем контейнере. Зелёная сборка не означает живой продукт.');
  process.exit(1);
}

console.log('');
console.log('Смоук пройден: опубликованный продукт отдаёт данные.');
