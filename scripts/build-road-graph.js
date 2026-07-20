/**
 * scripts/build-road-graph.js
 *
 * Запускается на раннере GitHub Actions (workflow import-road-graph.yml):
 * 1. Качает дороги Камчатки с Overpass (несколько зеркал, bbox плитками —
 *    один запрос на весь край упирается в таймауты Overpass).
 * 2. Строит граф (road-graph-builder.js — чистые функции, покрыты тестами).
 * 3. Заливает чанками в прод: POST /api/admin/import/road-graph (CRON_SECRET).
 *
 * Без npm-зависимостей: fetch встроен в Node 20, npm ci на раннере не нужен.
 *
 * Env: CRON_SECRET (обязателен), BASE_URL (default https://vedarai.ru),
 *      DRY_RUN=1 — построить и напечатать статистику, не заливая.
 */

'use strict';

const { buildGraph, chunk } = require('./road-graph-builder.js');

const BASE_URL = process.env.BASE_URL || 'https://vedarai.ru';
const CRON_SECRET = process.env.CRON_SECRET;
const DRY_RUN = process.env.DRY_RUN === '1';

const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

// Камчатский край, плитки с юга на север. Дороги сосредоточены на юге
// (Петропавловск/Елизово/Мильково) — там плитки мельче.
const TILES = [
  [50.5, 155.0, 53.5, 159.5],
  [53.5, 155.0, 55.5, 160.5],
  [55.5, 155.0, 58.0, 162.5],
  [58.0, 155.0, 62.5, 167.0],
];

const HIGHWAY_RE = 'motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|living_street|track|road|path|footway|bridleway|cycleway';

async function fetchTile([s, w, n, e]) {
  const q = `[out:json][timeout:180];way[highway~"^(${HIGHWAY_RE})$"](${s},${w},${n},${e});out geom;`;
  for (const mirror of OVERPASS_MIRRORS) {
    try {
      const res = await fetch(mirror, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(q),
        signal: AbortSignal.timeout(220_000),
      });
      if (!res.ok) {
        console.log(`  ${mirror}: HTTP ${res.status}, пробую следующее зеркало`);
        continue;
      }
      const json = await res.json();
      return json.elements || [];
    } catch (e2) {
      console.log(`  ${mirror}: ${e2.message}, пробую следующее зеркало`);
    }
  }
  throw new Error(`Все зеркала Overpass недоступны для плитки ${s},${w},${n},${e}`);
}

async function post(body) {
  const res = await fetch(`${BASE_URL}/api/admin/import/road-graph`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${CRON_SECRET}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(110_000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok !== true) {
    throw new Error(`POST ${body.mode}: HTTP ${res.status} ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json;
}

async function main() {
  if (!CRON_SECRET && !DRY_RUN) {
    console.error('CRON_SECRET не задан');
    process.exit(1);
  }

  console.log('Качаю дороги Камчатки с Overpass...');
  const elements = [];
  for (const tile of TILES) {
    console.log(`Плитка ${tile.join(', ')}:`);
    const els = await fetchTile(tile);
    console.log(`  ways: ${els.length}`);
    elements.push(...els);
    // Пауза между плитками — вежливость к Overpass
    await new Promise((r) => setTimeout(r, 5000));
  }

  // Дедуп way по id (плитки перекрывают дороги на границах)
  const seen = new Set();
  const unique = elements.filter((e) => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });
  console.log(`Всего ways: ${elements.length}, уникальных: ${unique.length}`);

  const { nodes, edges } = buildGraph(unique);
  console.log(`Граф: узлов ${nodes.size}, рёбер ${edges.length}`);

  if (DRY_RUN) {
    console.log('DRY_RUN — заливка пропущена');
    return;
  }

  const { import_id } = await post({ mode: 'reset', note: `runner import, ways=${unique.length}` });
  console.log(`Импорт-сессия #${import_id}`);

  const nodeRows = [...nodes.entries()].map(([id, p]) => [id, p.lat, p.lng]);
  for (const part of chunk(nodeRows, 8000)) {
    const r = await post({ mode: 'nodes', rows: part });
    console.log(`  узлы +${r.inserted}`);
  }

  const edgeRows = edges.map((e) => [e.from, e.to, e.length_m, e.highway, e.surface, e.name, e.geometry]);
  for (const part of chunk(edgeRows, 1500)) {
    const r = await post({ mode: 'edges', rows: part });
    console.log(`  рёбра +${r.inserted}`);
  }

  // BIGSERIAL id приходит из pg строкой — finish ждёт число (run 2 упал тут)
  const fin = await post({ mode: 'finish', import_id: Number(import_id) });
  console.log(`ГОТОВО: узлов ${fin.nodes}, рёбер ${fin.edges}`);
}

main().catch((e) => {
  console.error('ОШИБКА:', e.message);
  process.exit(1);
});
