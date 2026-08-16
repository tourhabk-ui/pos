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

async function checkRouteDetail(items) {
  if (!items) return;
  const first = items.find((r) => r && typeof r.id === 'string');
  if (!first) {
    fail('деталь маршрута', 'в выдаче каталога нет элемента с id');
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

const items = await run('каталог', checkCatalog);
await run('деталь маршрута', () => checkRouteDetail(items));
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
