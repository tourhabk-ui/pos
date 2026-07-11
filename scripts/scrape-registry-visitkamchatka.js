#!/usr/bin/env node
/**
 * scripts/scrape-registry-visitkamchatka.js
 *
 * Импорт ОФИЦИАЛЬНОГО РЕЕСТРА туроператоров Камчатки с
 * visitkamchatka.ru/registry/ → таблица official_registry_operators (issue #368).
 *
 * Это НЕ то же самое, что scrape-operators-visitkamchatka.js:
 *   - tour-operators/ — маркетинговый каталог (пишет в partners)
 *   - registry/       — официальный реестр (источник истины для верификации)
 *
 * Использует тот же smartFetch (Bright Data → direct), что и остальные скрейперы.
 * После наполнения таблицы сверка запускается через
 * POST /api/admin/registry/reconcile (или lib/services/operator-registry.service).
 *
 * ВАЖНО: портал местами протухший (даты бронирования 2022). Даты записей
 * реестра сохраняем в registry_date — актуальность проверять по ним + scraped_at.
 *
 * Usage:
 *   node scripts/scrape-registry-visitkamchatka.js            -- полный импорт
 *   node scripts/scrape-registry-visitkamchatka.js --debug    -- дамп структуры, без записи
 *   node scripts/scrape-registry-visitkamchatka.js --dry-run  -- парсинг без записи
 */

'use strict';

const { JSDOM } = require('jsdom');
const { Pool }  = require('pg');
const fs        = require('fs');
const path      = require('path');

// ── Env ──────────────────────────────────────────────────────────────────────

function loadDotEnv() {
  for (const f of ['.env.local', '.env']) {
    const full = path.resolve(process.cwd(), f);
    if (!fs.existsSync(full)) continue;
    fs.readFileSync(full, 'utf8').split('\n').forEach(line => {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    });
    break;
  }
}
loadDotEnv();

const BRIGHTDATA_TOKEN = process.env.BRIGHTDATA_API_TOKEN;
const DATABASE_URL     = process.env.DATABASE_URL;
const DEBUG   = process.argv.includes('--debug');
const DRY_RUN = process.argv.includes('--dry-run') || DEBUG;

if (!DATABASE_URL && !DEBUG) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL.includes('sslmode=no-verify') ? { rejectUnauthorized: false } : undefined,
      max: 3,
    })
  : null;

const REGISTRY_URL = 'https://visitkamchatka.ru/registry/';
const HDRS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
};

// ── Fetch ─────────────────────────────────────────────────────────────────────

async function fetchBrightData(url, timeoutMs = 30_000) {
  if (!BRIGHTDATA_TOKEN) return null;
  try {
    const res = await fetch('https://api.brightdata.com/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${BRIGHTDATA_TOKEN}` },
      body: JSON.stringify({ zone: 'mcp_unlocker', url, format: 'raw' }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) { console.warn(`  BD HTTP ${res.status}`); return null; }
    return await res.text();
  } catch (e) {
    console.warn(`  BD error: ${e.message}`);
    return null;
  }
}

async function fetchDirect(url, timeoutMs = 15_000) {
  try {
    const res = await fetch(url, { headers: HDRS, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) { console.warn(`  Direct HTTP ${res.status}`); return null; }
    return await res.text();
  } catch (e) {
    console.warn(`  Direct error: ${e.message}`);
    return null;
  }
}

async function smartFetch(url) {
  if (BRIGHTDATA_TOKEN) {
    console.log(`  → Bright Data: ${url}`);
    const html = await fetchBrightData(url);
    if (html) return html;
    console.log('  → BD failed, falling back to direct fetch');
  } else {
    console.log(`  → Direct fetch (no BRIGHTDATA_API_TOKEN): ${url}`);
  }
  return fetchDirect(url);
}

// ── Извлечение полей ──────────────────────────────────────────────────────────

// Должно совпадать с normalizeOperatorName в operator-registry.service.ts
const ORG_FORM_TOKENS = new Set([
  'ооо', 'оао', 'зао', 'пао', 'ао', 'ип', 'нп', 'ано', 'тоо',
  'туроператор', 'турагентство', 'турфирма', 'турагент',
  'туристическая', 'туристический', 'туристическое',
  'компания', 'фирма',
  'общество', 'ограниченной', 'ответственностью',
  'индивидуальный', 'предприниматель',
]);

function normalizeName(raw) {
  if (!raw) return '';
  return raw
    .toLowerCase()
    .replace(/[^a-zа-яё0-9]+/g, ' ')
    .split(' ')
    .filter(tok => tok.length > 0 && !ORG_FORM_TOKENS.has(tok))
    .join(' ')
    .trim();
}

function extractInn(text) {
  const m = text.match(/ИНН[:\s]*?(\d{10,12})/i);
  return m ? m[1] : null;
}

function extractOgrn(text) {
  const m = text.match(/ОГРН(?:ИП)?[:\s]*?(\d{13,15})/i);
  return m ? m[1] : null;
}

function extractRegistryNumber(text) {
  // РТО-номер / реестровый номер: «РТО 012345», «№ РТО-0012345», «реестровый номер …»
  const m =
    text.match(/(?:РТО|реестров\w*\s*(?:номер|№))[:\s№-]*([А-Яа-яA-Za-z0-9./\-]{3,25})/i);
  return m ? m[1].replace(/\s+/g, '') : null;
}

function extractDate(text) {
  // dd.mm.yyyy → ISO yyyy-mm-dd (для проверки актуальности — портал протухший)
  const m = text.match(/\b(\d{2})\.(\d{2})\.(\d{4})\b/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

function extractStatus(text) {
  const m = text.match(/(действующ\w*|исключ\w*|прекращ\w*|приостановлен\w*|аннулирован\w*)/i);
  return m ? m[1] : null;
}

function extractPhone(text) {
  const m = text.match(/(?:\+7|8)[\s\-]?\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}/);
  return m ? m[0].replace(/\s/g, '') : null;
}

function extractEmail(text) {
  const m = text.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
  return m ? m[0].toLowerCase() : null;
}

function extractRegion(text) {
  const m = text.match(/(Камчатск\w+\s+кра\w+|Петропавловск-Камчатск\w+|Елизовск\w+)/i);
  return m ? m[1] : null;
}

// ── Парсинг ───────────────────────────────────────────────────────────────────

function debugStructure(html) {
  const dom = new JSDOM(html, { url: REGISTRY_URL });
  const doc = dom.window.document;

  console.log('\n=== PAGE TITLE ===');
  console.log(doc.querySelector('title')?.textContent);

  console.log('\n=== TABLES ===');
  doc.querySelectorAll('table').forEach((t, i) => {
    const rows = t.querySelectorAll('tr').length;
    console.log(`  table[${i}] rows=${rows}`);
    const head = [...t.querySelectorAll('th')].map(th => th.textContent.trim()).filter(Boolean);
    if (head.length) console.log('    headers:', head.join(' | '));
  });

  console.log('\n=== ТОП КЛАССОВ ===');
  const classCounts = {};
  doc.querySelectorAll('[class]').forEach(el => {
    el.className.split(/\s+/).forEach(c => { if (c) classCounts[c] = (classCounts[c] || 0) + 1; });
  });
  Object.entries(classCounts).sort((a, b) => b[1] - a[1]).slice(0, 25)
    .forEach(([cls, cnt]) => console.log(`  .${cls}  ×${cnt}`));

  console.log('\n=== RAW HTML (первые 3000 символов) ===');
  console.log(html.slice(0, 3000));
}

function recordFromText(name, text, sourceUrl) {
  const cleanName = name.replace(/\s+/g, ' ').trim();
  if (!cleanName || cleanName.length < 3 || cleanName.length > 250) return null;
  return {
    name: cleanName,
    name_normalized: normalizeName(cleanName),
    inn: extractInn(text),
    ogrn: extractOgrn(text),
    registry_number: extractRegistryNumber(text),
    region: extractRegion(text),
    registry_status: extractStatus(text),
    registry_date: extractDate(text),
    contacts: {
      phone: extractPhone(text),
      email: extractEmail(text),
    },
    source_url: sourceUrl,
  };
}

/** Стратегия 1: таблица реестра (наиболее вероятный формат гос-реестра). */
function parseTables(html) {
  const dom = new JSDOM(html, { url: REGISTRY_URL });
  const doc = dom.window.document;
  const results = [];

  for (const table of doc.querySelectorAll('table')) {
    const rows = [...table.querySelectorAll('tr')];
    if (rows.length < 2) continue;

    for (const tr of rows) {
      const cells = [...tr.querySelectorAll('td')];
      if (cells.length === 0) continue;
      const rowText = tr.textContent || '';
      // Название — самая длинная ячейка с буквами, не цифрами
      const nameCell = cells
        .map(c => c.textContent.trim())
        .filter(t => /[А-Яа-яA-Za-z]{4,}/.test(t) && !/^\d+$/.test(t))
        .sort((a, b) => b.length - a.length)[0];
      if (!nameCell) continue;
      const rec = recordFromText(nameCell, rowText, REGISTRY_URL);
      if (rec) results.push(rec);
    }
    if (results.length > 0) {
      console.log(`  Таблица: ${results.length} записей`);
      break;
    }
  }
  return results;
}

/** Стратегия 2 (fallback): блоки-карточки с ИНН/ОГРН. */
function parseCards(html) {
  const dom = new JSDOM(html, { url: REGISTRY_URL });
  const doc = dom.window.document;
  const results = [];
  const idRe = /(ИНН|ОГРН|РТО)/i;

  doc.querySelectorAll('div,article,li,section').forEach(el => {
    const text = el.textContent || '';
    if (!idRe.test(text) || text.length > 3000) return;
    const h = el.querySelector('h2,h3,h4,strong,b,a');
    const name = h?.textContent?.trim();
    if (!name) return;
    const rec = recordFromText(name, text, REGISTRY_URL);
    if (rec && (rec.inn || rec.ogrn || rec.registry_number)) results.push(rec);
  });

  if (results.length > 0) console.log(`  Карточки: ${results.length} записей`);
  return results;
}

function dedupe(records) {
  const seen = new Map();
  for (const r of records) {
    if (!r.name_normalized) continue;
    const existing = seen.get(r.name_normalized);
    if (!existing) { seen.set(r.name_normalized, r); continue; }
    // Оставляем более полную запись
    const score = x => (x.inn ? 2 : 0) + (x.ogrn ? 1 : 0) + (x.registry_number ? 1 : 0);
    if (score(r) > score(existing)) seen.set(r.name_normalized, r);
  }
  return [...seen.values()];
}

// ── DB upsert ───────────────────────────────────────────────────────────────

async function upsert(rec) {
  if (!pool) return 'skip';
  const { rowCount } = await pool.query(
    `INSERT INTO official_registry_operators
       (name, name_normalized, inn, ogrn, registry_number, region,
        registry_status, contacts, source_url, registry_date, raw, scraped_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, NOW())
     ON CONFLICT (name_normalized) DO UPDATE SET
       name            = EXCLUDED.name,
       inn             = COALESCE(EXCLUDED.inn, official_registry_operators.inn),
       ogrn            = COALESCE(EXCLUDED.ogrn, official_registry_operators.ogrn),
       registry_number = COALESCE(EXCLUDED.registry_number, official_registry_operators.registry_number),
       region          = COALESCE(EXCLUDED.region, official_registry_operators.region),
       registry_status = COALESCE(EXCLUDED.registry_status, official_registry_operators.registry_status),
       contacts        = EXCLUDED.contacts,
       source_url      = EXCLUDED.source_url,
       registry_date   = COALESCE(EXCLUDED.registry_date, official_registry_operators.registry_date),
       raw             = EXCLUDED.raw,
       scraped_at      = NOW()`,
    [
      rec.name, rec.name_normalized, rec.inn, rec.ogrn, rec.registry_number,
      rec.region, rec.registry_status, JSON.stringify(rec.contacts),
      rec.source_url, rec.registry_date, JSON.stringify(rec),
    ],
  );
  return rowCount > 0 ? 'upserted' : 'noop';
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n=== Registry Scraper: ${REGISTRY_URL} ===`);
  console.log(`Mode: ${DEBUG ? 'DEBUG' : DRY_RUN ? 'DRY-RUN' : 'LIVE'}`);
  if (!BRIGHTDATA_TOKEN) console.warn('BRIGHTDATA_API_TOKEN не задан — прямой fetch');

  console.log('\n[1/3] Загрузка страницы реестра...');
  const html = await smartFetch(REGISTRY_URL);
  if (!html) { console.error('Не удалось загрузить страницу реестра'); process.exit(1); }
  console.log(`  Получено ${html.length} байт`);

  if (DEBUG) { debugStructure(html); process.exit(0); }

  console.log('\n[2/3] Парсинг...');
  let records = parseTables(html);
  if (records.length === 0) records = parseCards(html);
  records = dedupe(records);

  if (records.length === 0) {
    console.warn('  Записи не распознаны. Запустите с --debug для дампа структуры.');
    process.exit(1);
  }
  console.log(`  Распознано ${records.length} операторов реестра`);
  console.log('  Пример:', JSON.stringify(records[0], null, 2));

  if (DRY_RUN) { console.log('\nDRY-RUN — в БД не пишем.'); process.exit(0); }

  console.log('\n[3/3] Запись в official_registry_operators...');
  let ok = 0;
  for (const rec of records) {
    try { await upsert(rec); ok++; }
    catch (e) { console.error(`  Ошибка upsert "${rec.name}": ${e.message}`); }
  }
  console.log(`  Записано/обновлено: ${ok}/${records.length}`);

  await pool.end();
  console.log('\nГотово. Запустите сверку: POST /api/admin/registry/reconcile');
}

main().catch(e => { console.error(e); process.exit(1); });
