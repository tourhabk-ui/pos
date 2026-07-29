#!/usr/bin/env node
/**
 * scripts/scrape-operators-visitkamchatka.js
 *
 * Импорт лицензированных туроператоров Камчатки с visitkamchatka.ru/tour-operators/
 * → таблица partners (external_source='visitkamchatka')
 *
 * Использует тот же smartFetch (Bright Data → direct) что и scrape-routes-brightdata.js
 *
 * Usage:
 *   node scripts/scrape-operators-visitkamchatka.js              -- полный импорт
 *   node scripts/scrape-operators-visitkamchatka.js --debug      -- дамп HTML структуры, без записи в БД
 *   node scripts/scrape-operators-visitkamchatka.js --dry-run    -- парсинг без записи в БД
 *   node scripts/scrape-operators-visitkamchatka.js --enrich     -- дополнительно скрейпит сайты операторов
 */

'use strict';

const { JSDOM } = require('jsdom');
const { Pool }  = require('pg');
const fs        = require('fs');
const path      = require('path');
const crypto    = require('crypto');

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
const DEBUG   = process.argv.includes('--debug');
const DRY_RUN = process.argv.includes('--dry-run') || DEBUG;
const ENRICH  = process.argv.includes('--enrich');

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

const OPERATORS_URL = 'https://visitkamchatka.ru/tour-operators/';
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

// ── Debug: показывает реальную структуру страницы ────────────────────────────

function debugStructure(html) {
  const dom = new JSDOM(html, { url: OPERATORS_URL });
  const doc = dom.window.document;

  console.log('\n=== PAGE TITLE ===');
  console.log(doc.querySelector('title')?.textContent);

  console.log('\n=== H1/H2 ===');
  doc.querySelectorAll('h1,h2').forEach(h => {
    const text = h.textContent.trim().slice(0, 80);
    if (text) console.log(`  <${h.tagName.toLowerCase()}> ${text}`);
  });

  console.log('\n=== LINKS TO /tour-operators/ ===');
  let opLinks = 0;
  doc.querySelectorAll('a[href]').forEach(a => {
    if (a.href?.includes('tour-operator') && opLinks++ < 20) {
      console.log(`  ${a.href} → "${a.textContent.trim().slice(0, 60)}"`);
    }
  });

  console.log('\n=== DIVS с классами (топ-20 уникальных классов) ===');
  const classCounts = {};
  doc.querySelectorAll('[class]').forEach(el => {
    el.className.split(/\s+/).forEach(c => {
      if (c) classCounts[c] = (classCounts[c] || 0) + 1;
    });
  });
  Object.entries(classCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30)
    .forEach(([cls, cnt]) => console.log(`  .${cls}  ×${cnt}`));

  console.log('\n=== ПЕРВЫЕ 3 КАРТОЧКИ (любой элемент с телефоном) ===');
  const phoneRe = /(?:\+7|8)[\s\-]?\(?\d{3}\)?[\s\-]?\d{3}/;
  let found = 0;
  doc.querySelectorAll('div,article,li,section').forEach(el => {
    if (found >= 3) return;
    const text = el.textContent || '';
    if (phoneRe.test(text) && text.length < 2000 && text.trim().length > 30) {
      found++;
      console.log(`\n  [${el.tagName}.${el.className.split(' ')[0]}]`);
      console.log('  ' + text.replace(/\s+/g, ' ').trim().slice(0, 300));
    }
  });

  console.log('\n=== RAW HTML (первые 3000 символов) ===');
  console.log(html.slice(0, 3000));
}

// ── Парсинг операторов ────────────────────────────────────────────────────────

function extractTgLinks(text) {
  const re = /(?:https?:\/\/)?t\.me\/([a-zA-Z0-9_]{4,})/g;
  const links = [];
  const skip = new Set(['share', 'addstickers', 'joinchat', 'proxy', 'socks', 'iv', 's']);
  let m;
  while ((m = re.exec(text)) !== null) {
    if (!skip.has(m[1])) links.push(`https://t.me/${m[1]}`);
  }
  return [...new Set(links)];
}

function extractPhone(text) {
  const m = text.match(/(?:\+7|8)[\s\-]?\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}/);
  return m ? m[0].replace(/\s/g, '') : undefined;
}

function extractEmail(text) {
  const m = text.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
  return m ? m[0].toLowerCase() : undefined;
}

function toSlug(name) {
  const MAP = {
    а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'yo',ж:'zh',з:'z',
    и:'i',й:'j',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',
    с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',щ:'shch',
    ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya',
  };
  return 'vk-op-' + name.toLowerCase()
    .replace(/[а-яё]/g, c => MAP[c] ?? c)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

/**
 * Стратегия 1: ищем ссылки на страницы индивидуальных операторов
 * (visitkamchatka.ru/tour-operators/nazvanie/)
 */
function extractOperatorLinks(html) {
  const dom = new JSDOM(html, { url: OPERATORS_URL });
  const doc = dom.window.document;
  const links = new Set();
  const base = new URL(OPERATORS_URL);
  doc.querySelectorAll('a[href]').forEach(a => {
    try {
      const href = new URL(a.href, OPERATORS_URL);
      if (
        href.hostname === base.hostname &&
        href.pathname.startsWith('/tour-operators/') &&
        href.pathname !== '/tour-operators/' &&
        href.pathname.length > '/tour-operators/'.length
      ) {
        links.add(href.href.replace(/#.*$/, '').replace(/\/$/, '') + '/');
      }
    } catch { /* skip */ }
  });
  return [...links];
}

/**
 * Стратегия 2: карточки прямо на странице листинга
 */
function parseOperatorCards(html, sourceUrl) {
  const dom = new JSDOM(html, { url: sourceUrl || OPERATORS_URL });
  const doc = dom.window.document;
  const results = [];

  // Пробуем разные селекторы карточек — Bitrix, WordPress, кастомные
  const cardSelectors = [
    '.company-item', '.operator-item', '.partner-item',
    '.company-card', '.operator-card', '.company',
    'article.company', 'article.operator', 'article.item',
    '.b-operator', '.b-company', '.item-company',
    '[class*="company"]', '[class*="operator"]',
    '.catalog-item', '.catalog__item', '.b-catalog__item',
  ];

  let cards = [];
  for (const sel of cardSelectors) {
    const found = [...doc.querySelectorAll(sel)];
    if (found.length > 2) { cards = found; console.log(`  Found ${found.length} cards via "${sel}"`); break; }
  }

  // Fallback: ищем любой блок с телефоном и заголовком
  if (cards.length === 0) {
    const phoneRe = /(?:\+7|8)[\s\-]?\(?\d{3}\)?[\s\-]?\d{3}/;
    doc.querySelectorAll('div,article,li').forEach(el => {
      const t = el.textContent || '';
      if (phoneRe.test(t) && t.length < 3000 && t.trim().length > 50) {
        const h = el.querySelector('h2,h3,h4,strong,b');
        if (h && h.textContent.trim().length > 3) cards.push(el);
      }
    });
    if (cards.length > 0) console.log(`  Fallback: found ${cards.length} phone-containing blocks`);
  }

  for (const card of cards) {
    const nameEl = card.querySelector('h1,h2,h3,h4,strong,b,.company-name,.operator-name,.title');
    const name = nameEl?.textContent?.trim()?.replace(/\s+/g, ' ');
    if (!name || name.length < 3 || name.length > 200) continue;

    const text = card.textContent || '';
    const tgLinks = extractTgLinks(card.innerHTML || '');
    const linkEl = card.querySelector('a[href*="http"]:not([href*="visitkamchatka"]):not([href*="t.me"])');
    const website = linkEl?.href;
    const operatorPageLink = card.querySelector(`a[href*="tour-operators"]`)?.href;

    results.push({
      name,
      slug: toSlug(name),
      phone: extractPhone(text),
      email: extractEmail(text),
      website: website || undefined,
      telegram_group_url: tgLinks[0] || undefined,
      external_source_url: sourceUrl || OPERATORS_URL,
      operator_page_url: operatorPageLink || undefined,
    });
  }

  return results;
}

/**
 * Парсинг страницы конкретного оператора
 */
function parseOperatorPage(html, url) {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;

  const h1 = doc.querySelector('h1');
  const name = h1?.textContent?.trim();
  if (!name || name.length < 3) return null;

  const text = doc.body?.textContent || '';
  const tgLinks = extractTgLinks(doc.body?.innerHTML || '');

  // Сайт — внешняя ссылка на не-visitkamchatka домен
  let website;
  doc.querySelectorAll('a[href]').forEach(a => {
    if (!website && a.href && !a.href.includes('visitkamchatka') && !a.href.includes('t.me')) {
      try {
        const u = new URL(a.href);
        if (u.protocol.startsWith('http')) website = u.origin;
      } catch { /* skip */ }
    }
  });

  // Лицензия
  const licenseMatch = text.match(/(?:лиценз|рег\.?\s*№|реестр)[^\n]{0,50}(\d[\d\-/А-Яа-я]{4,20})/i);

  // Описание — первый длинный параграф
  const firstP = [...doc.querySelectorAll('p')].find(p => p.textContent.trim().length > 60);
  const description = firstP?.textContent?.trim()?.slice(0, 500);

  return {
    name,
    slug: toSlug(name),
    phone: extractPhone(text),
    email: extractEmail(text),
    website,
    telegram_group_url: tgLinks[0],
    license_number: licenseMatch?.[1],
    description,
    external_source_url: url,
  };
}

// ── Поиск TG на сайте оператора ──────────────────────────────────────────────

async function findTgOnWebsite(website) {
  if (!website) return undefined;
  try {
    const html = await fetchDirect(website, 10_000);
    if (!html) return undefined;
    const links = extractTgLinks(html);
    return links[0];
  } catch { return undefined; }
}

// ── DB upsert ─────────────────────────────────────────────────────────────────

async function upsertOperator(op) {
  if (!pool) return 'skip';
  const { rows } = await pool.query(
    `SELECT id FROM partners WHERE slug = $1 OR (external_source = 'visitkamchatka' AND company_name = $2) LIMIT 1`,
    [op.slug, op.name],
  );

  if (rows.length > 0) {
    await pool.query(
      `UPDATE partners SET
         company_name        = COALESCE(NULLIF($2,''), company_name),
         external_source     = 'visitkamchatka',
         external_source_url = $3,
         telegram_group_url  = COALESCE($4, telegram_group_url),
         license_number      = COALESCE($5, license_number),
         updated_at          = NOW()
       WHERE id = $1`,
      [rows[0].id, op.name, op.external_source_url, op.telegram_group_url ?? null, op.license_number ?? null],
    );
    return 'updated';
  }

  await pool.query(
    `INSERT INTO partners (slug, company_name, name, external_source, external_source_url,
       telegram_group_url, license_number, is_verified, is_public, commission_current)
     VALUES ($1,$2,$2,'visitkamchatka',$3,$4,$5,false,false,0)
     ON CONFLICT (slug) DO UPDATE SET
       external_source     = EXCLUDED.external_source,
       external_source_url = EXCLUDED.external_source_url,
       telegram_group_url  = COALESCE(EXCLUDED.telegram_group_url, partners.telegram_group_url),
       updated_at          = NOW()`,
    [op.slug, op.name, op.external_source_url, op.telegram_group_url ?? null, op.license_number ?? null],
  );
  return 'inserted';
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n=== Operator Scraper: ${OPERATORS_URL} ===`);
  console.log(`Mode: ${DEBUG ? 'DEBUG' : DRY_RUN ? 'DRY-RUN' : 'LIVE'}${ENRICH ? ' +ENRICH' : ''}`);
  if (!BRIGHTDATA_TOKEN) console.warn('⚠  BRIGHTDATA_API_TOKEN not set — using direct fetch');

  // ── Шаг 1: Листинг страницы ──
  console.log('\n[1/3] Fetching operator listing page...');
  const listingHtml = await smartFetch(OPERATORS_URL);
  if (!listingHtml) {
    console.error('Failed to fetch listing page');
    process.exit(1);
  }
  console.log(`  Got ${listingHtml.length} bytes`);

  if (DEBUG) {
    debugStructure(listingHtml);
    process.exit(0);
  }

  // ── Шаг 2: Ищем либо карточки на листинге, либо ссылки на страницы операторов ──
  console.log('\n[2/3] Parsing operators...');
  const operators = parseOperatorCards(listingHtml, OPERATORS_URL);
  const operatorLinks = extractOperatorLinks(listingHtml);

  console.log(`  Cards on listing: ${operators.length}`);
  console.log(`  Links to operator pages: ${operatorLinks.length}`);

  // Если нашли ссылки на отдельные страницы — скрейпим каждую
  if (operatorLinks.length > 0 && operators.length === 0) {
    console.log('  → Scraping individual operator pages...');
    const concurrency = 5;
    for (let i = 0; i < operatorLinks.length; i += concurrency) {
      const batch = operatorLinks.slice(i, i + concurrency);
      const results = await Promise.allSettled(
        batch.map(async url => {
          process.stdout.write(`    ${i + batch.indexOf(url) + 1}/${operatorLinks.length} ${url} ...`);
          const html = await smartFetch(url);
          if (!html) { console.log(' [failed]'); return null; }
          const op = parseOperatorPage(html, url);
          console.log(op ? ` ${op.name}` : ' [no name found]');
          return op;
        })
      );
      results.forEach(r => {
        if (r.status === 'fulfilled' && r.value) operators.push(r.value);
      });
      // Пауза между батчами чтобы не нагружать BD
      if (i + concurrency < operatorLinks.length) await new Promise(r => setTimeout(r, 2000));
    }
  }

  console.log(`\n  Total operators parsed: ${operators.length}`);

  if (operators.length === 0) {
    console.error('\n❌ No operators found. Run with --debug to inspect the HTML structure.');
    process.exit(1);
  }

  // ── Шаг 3: Обогащение (--enrich) — ищем TG на сайтах ──
  if (ENRICH) {
    console.log('\n[ENRICH] Finding Telegram links on operator websites...');
    const withoutTg = operators.filter(op => !op.telegram_group_url && op.website);
    console.log(`  ${withoutTg.length} operators without TG, checking their websites...`);
    for (const op of withoutTg.slice(0, 20)) {
      const tg = await findTgOnWebsite(op.website);
      if (tg) { op.telegram_group_url = tg; console.log(`  ${op.name} → ${tg}`); }
    }
  }

  // ── Шаг 4: Показ результатов / Сохранение ──
  console.log('\n[3/3] Saving to database...');
  const stats = { inserted: 0, updated: 0, errors: 0 };

  for (const op of operators) {
    const tgMark = op.telegram_group_url ? ` TG:${op.telegram_group_url}` : '';
    const phoneMark = op.phone ? ` ☎${op.phone}` : '';

    if (DRY_RUN) {
      console.log(`  [dry] ${op.name}${phoneMark}${tgMark}`);
      continue;
    }

    try {
      const status = await upsertOperator(op);
      console.log(`  [${status}] ${op.name}${phoneMark}${tgMark}`);
      if (status === 'inserted') stats.inserted++;
      else stats.updated++;
    } catch (e) {
      console.error(`  [error] ${op.name}: ${e.message}`);
      stats.errors++;
    }
  }

  console.log(`\n✅ Done: ${operators.length} parsed, ${stats.inserted} inserted, ${stats.updated} updated, ${stats.errors} errors`);

  const withTg = operators.filter(op => op.telegram_group_url).length;
  console.log(`📱 Telegram groups found: ${withTg}/${operators.length}`);

  if (pool) await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
