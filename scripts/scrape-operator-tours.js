#!/usr/bin/env node
/**
 * scripts/scrape-operator-tours.js
 *
 * Парсит сайты туроператоров → извлекает туры через AI (не regex) → сохраняет в operator_tours.
 *
 * Usage:
 *   node scripts/scrape-operator-tours.js --dry-run         -- парсинг без записи в БД
 *   node scripts/scrape-operator-tours.js --taras           -- только volcano/sea/rafting/thermal (для Тараса)
 *   node scripts/scrape-operator-tours.js --operator=slug   -- один конкретный оператор
 *   node scripts/scrape-operator-tours.js --debug           -- дамп HTML первого оператора
 *   node scripts/scrape-operator-tours.js                   -- все операторы
 */

'use strict';

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
      if (m && !process.env[m[1]])
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    });
    break;
  }
}
loadDotEnv();

const BRIGHTDATA_TOKEN = process.env.BRIGHTDATA_API_TOKEN;
const DATABASE_URL     = process.env.DATABASE_URL;
const AI_KEY           = process.env.OPENROUTER_API_KEY || process.env.DEEPSEEK_API_KEY;

const DRY_RUN      = process.argv.includes('--dry-run');
const TARAS_MODE   = process.argv.includes('--taras');
const DEBUG        = process.argv.includes('--debug');
const OP_SLUG      = process.argv.find(a => a.startsWith('--operator='))?.split('=')[1];

const TARAS_CATEGORIES = ['volcano', 'sea', 'rafting', 'thermal'];

if (!DATABASE_URL) { console.error('DATABASE_URL not set'); process.exit(1); }
if (!AI_KEY && !DRY_RUN) { console.warn('⚠  No AI key (OPENROUTER_API_KEY/DEEPSEEK_API_KEY) — will skip AI extraction'); }

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('sslmode=no-verify') ? { rejectUnauthorized: false } : undefined,
  max: 3,
});

// ── HTTP fetch ────────────────────────────────────────────────────────────────

const HDRS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
};

async function fetchBD(url) {
  if (!BRIGHTDATA_TOKEN) return null;
  try {
    const res = await fetch('https://api.brightdata.com/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${BRIGHTDATA_TOKEN}` },
      body: JSON.stringify({ zone: 'mcp_unlocker', url, format: 'raw' }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) { console.warn(`  BD ${res.status}`); return null; }
    return await res.text();
  } catch (e) { console.warn(`  BD error: ${e.message}`); return null; }
}

async function fetchDirect(url) {
  try {
    const res = await fetch(url, { headers: HDRS, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    return await res.text();
  } catch { return null; }
}

async function smartFetch(url) {
  if (BRIGHTDATA_TOKEN) {
    const html = await fetchBD(url);
    if (html) return html;
    console.log('  BD failed, trying direct...');
  }
  return fetchDirect(url);
}

// ── AI extraction via OpenRouter/DeepSeek ────────────────────────────────────

async function extractToursAI(html, pageUrl) {
  if (!AI_KEY) return [];

  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{3,}/g, '\n')
    .trim()
    .slice(0, 8000);

  const prompt = `Извлеки туры с сайта туроператора Камчатки.

URL: ${pageUrl}

ПРАВИЛА:
1. price_from: null если цены нет на странице — НЕ выдумывай
2. price_unit: "с человека"→"per_person", "за группу"→"per_group", непонятно→"unknown"
3. departures: null если дат нет — НЕ придумывай
4. Только реальные туры со страницы

Категории: volcano, sea, rafting, thermal, fishing, trekking, helicopter, jeep, other

Ответ JSON:
{
  "tours": [
    {
      "title": "...",
      "category": "volcano",
      "price_from": 5500,
      "price_unit": "per_person",
      "group_size_max": null,
      "price_note": "5500 руб/чел",
      "includes": "трансфер, гид",
      "duration_hours": 10,
      "departures": [{"date_from": "2026-08-04", "date_to": null, "seats_left": 8}],
      "description": "...",
      "source_url": "${pageUrl}"
    }
  ]
}

Текст страницы:
${text}`;

  // Try OpenRouter first, then DeepSeek direct
  const endpoints = [];
  if (process.env.OPENROUTER_API_KEY) {
    endpoints.push({
      url: 'https://openrouter.ai/api/v1/chat/completions',
      key: process.env.OPENROUTER_API_KEY,
      model: 'deepseek/deepseek-chat',
    });
  }
  if (process.env.DEEPSEEK_API_KEY) {
    endpoints.push({
      url: 'https://api.deepseek.com/chat/completions',
      key: process.env.DEEPSEEK_API_KEY,
      model: 'deepseek-chat',
    });
  }

  for (const ep of endpoints) {
    try {
      const res = await fetch(ep.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.key}` },
        body: JSON.stringify({
          model: ep.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          max_tokens: 2000,
          response_format: { type: 'json_object' },
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) continue;
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) continue;

      const parsed = JSON.parse(content);
      if (!Array.isArray(parsed.tours)) continue;

      // Basic validation
      return parsed.tours.filter(t =>
        t.title && typeof t.title === 'string' &&
        ['volcano','sea','rafting','thermal','fishing','trekking','helicopter','jeep','other'].includes(t.category) &&
        ['per_person','per_group','unknown'].includes(t.price_unit)
      );
    } catch (e) {
      console.warn(`  AI error (${ep.url}): ${e.message}`);
    }
  }
  return [];
}

// ── Find tour pages on operator website ───────────────────────────────────────

async function findTourPages(website, html) {
  const links = new Set();
  const base = new URL(website);

  // Regex to find tour/excursion links
  const linkRe = /href="([^"]+)"/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const href = m[1];
    try {
      const u = new URL(href, website);
      if (u.hostname !== base.hostname) continue;
      const p = u.pathname.toLowerCase();
      if (/тур|tour|excur|экскурс|маршрут|route|program|прогр|поход|вулкан|рыбалк|сплав|морск/i.test(p + u.href)) {
        links.add(u.href.replace(/#.*$/, ''));
      }
    } catch { /* skip */ }
  }

  // Limit to 10 most promising pages
  return [...links].slice(0, 10);
}

// ── DB save ───────────────────────────────────────────────────────────────────

async function saveTour(tour, operatorId) {
  const { rows } = await pool.query(
    `SELECT id FROM operator_tours WHERE operator_id = $1 AND title = $2 LIMIT 1`,
    [operatorId, tour.title],
  );

  if (rows.length > 0) {
    await pool.query(
      `UPDATE operator_tours SET
         price_unit    = $2,
         price_note    = COALESCE($3, price_note),
         includes      = COALESCE($4, includes),
         source_url    = $5,
         parsed_at     = NOW(),
         is_stale      = FALSE,
         base_price    = COALESCE($6, base_price),
         activity_type = $7,
         description   = COALESCE($8, description),
         duration_hours= COALESCE($9, duration_hours),
         group_size_max= COALESCE($10, group_size_max)
       WHERE id = $1`,
      [rows[0].id, tour.price_unit, tour.price_note, tour.includes, tour.source_url,
       tour.price_from, tour.category, tour.description, tour.duration_hours, tour.group_size_max],
    );
    return { status: 'updated', id: rows[0].id };
  }

  const { rows: inserted } = await pool.query(
    `INSERT INTO operator_tours (
       operator_id, title, activity_type, description, duration_hours,
       base_price, price_unit, group_size_max, price_note, includes,
       source_url, parsed_at, is_stale,
       max_participants, currency
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),FALSE,COALESCE($8,10),'RUB')
     RETURNING id`,
    [operatorId, tour.title, tour.category, tour.description, tour.duration_hours,
     tour.price_from, tour.price_unit, tour.group_size_max, tour.price_note, tour.includes,
     tour.source_url],
  );

  const tourId = inserted[0].id;

  // Save departures → tour_availability
  if (tour.departures?.length) {
    for (const dep of tour.departures) {
      if (!dep.date_from) continue;
      try {
        await pool.query(
          `INSERT INTO tour_availability (tour_id, date, available_slots, is_available)
           VALUES ($1, $2::date, COALESCE($3, 10), TRUE)
           ON CONFLICT (tour_id, date) DO UPDATE SET
             available_slots = COALESCE(EXCLUDED.available_slots, tour_availability.available_slots),
             is_available    = TRUE`,
          [tourId, dep.date_from, dep.seats_left],
        );
      } catch { /* skip bad dates */ }
    }
  }

  return { status: 'inserted', id: tourId };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n=== Tour Scraper ===`);
  console.log(`Mode: ${DEBUG ? 'DEBUG' : DRY_RUN ? 'DRY-RUN' : 'LIVE'}${TARAS_MODE ? ' [TARAS: volcano/sea/rafting/thermal]' : ''}`);

  // Load operators from partners table
  let query = `SELECT id, slug, company_name AS name, website, external_source_url
               FROM partners
               WHERE website IS NOT NULL AND website != ''`;
  if (OP_SLUG) query += ` AND slug = '${OP_SLUG.replace(/'/g, "''")}'`;
  query += ` ORDER BY company_name`;

  const { rows: operators } = await pool.query(query);
  console.log(`\nOperators to process: ${operators.length}`);

  if (operators.length === 0) {
    console.log('No operators with websites. Run scrape-operators-visitkamchatka.js first.');
    await pool.end();
    return;
  }

  const stats = { operators: 0, tours_found: 0, tours_saved: 0, errors: 0 };

  for (const op of operators) {
    console.log(`\n[${op.name}] ${op.website}`);
    stats.operators++;

    const mainHtml = await smartFetch(op.website);
    if (!mainHtml) {
      console.log('  → Failed to fetch main page');
      stats.errors++;
      continue;
    }

    if (DEBUG) {
      console.log('\n--- HTML PREVIEW ---');
      console.log(mainHtml.slice(0, 2000));
      break;
    }

    // Try AI extraction on main page first
    let allTours = await extractToursAI(mainHtml, op.website);
    console.log(`  Main page: ${allTours.length} tours found`);

    // If few tours found, try tour sub-pages
    if (allTours.length < 3) {
      const tourPages = await findTourPages(op.website, mainHtml);
      console.log(`  Tour sub-pages: ${tourPages.length}`);

      for (const pageUrl of tourPages.slice(0, 5)) {
        const pageHtml = await smartFetch(pageUrl);
        if (!pageHtml) continue;
        const pageTours = await extractToursAI(pageHtml, pageUrl);
        console.log(`    ${pageUrl} → ${pageTours.length} tours`);
        allTours = [...allTours, ...pageTours];
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    // Filter for Taras if needed
    const toProcess = TARAS_MODE
      ? allTours.filter(t => TARAS_CATEGORIES.includes(t.category))
      : allTours;

    console.log(`  Total after filter: ${toProcess.length} tours`);
    stats.tours_found += toProcess.length;

    if (DRY_RUN) {
      toProcess.forEach(t => {
        const price = t.price_from ? `${t.price_from}₽ ${t.price_unit}` : 'цена не указана';
        const dates = t.departures?.map(d => d.date_from).filter(Boolean).join(', ') || 'даты не указаны';
        console.log(`  [dry] ${t.category} · ${t.title} · ${price} · ${dates}`);
      });
      continue;
    }

    for (const tour of toProcess) {
      try {
        const result = await saveTour(tour, op.id);
        console.log(`  [${result.status}] ${tour.title}`);
        stats.tours_saved++;
      } catch (e) {
        console.error(`  [error] ${tour.title}: ${e.message}`);
        stats.errors++;
      }
    }

    await new Promise(r => setTimeout(r, 2000));
  }

  console.log(`\n✅ Done:`);
  console.log(`  Operators: ${stats.operators}`);
  console.log(`  Tours found: ${stats.tours_found}`);
  console.log(`  Tours saved: ${stats.tours_saved}`);
  console.log(`  Errors: ${stats.errors}`);

  if (!DRY_RUN && stats.tours_saved > 0) {
    console.log(`\nTours for Taras (volcano 03-07.08):`);
    const { rows } = await pool.query(`
      SELECT p.company_name, ot.title, ot.base_price, ot.price_unit, ot.group_size_max,
             ot.includes, ta.date, ta.available_slots
      FROM operator_tours ot
      JOIN partners p ON p.id = ot.operator_id
      LEFT JOIN tour_availability ta ON ta.tour_id = ot.id
        AND ta.date BETWEEN '2026-08-03' AND '2026-08-07'
      WHERE ot.activity_type IN ('volcano','trekking')
      ORDER BY ta.date NULLS LAST, ot.base_price NULLS LAST
      LIMIT 20
    `);
    rows.forEach(r => {
      const price = r.base_price
        ? `${Number(r.base_price).toLocaleString('ru-RU')}₽ ${r.price_unit === 'per_person' ? '/чел' : r.price_unit === 'per_group' ? `/группа до ${r.group_size_max}` : '(уточнить)'}`
        : 'цена не указана';
      console.log(`  ${r.company_name} — ${r.title} — ${price} — ${r.date ?? 'даты не указаны'}`);
    });
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
