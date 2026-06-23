#!/usr/bin/env node
/**
 * scripts/scrape-guides-visitkamchatka.js
 *
 * Импорт аттестованных гидов Камчатки с visitkamchatka.ru/guides/
 * → таблица partners (category='guide', external_source='visitkamchatka')
 * → таблица guide_certifications (аттестация от Министерства туризма)
 *
 * Usage:
 *   node scripts/scrape-guides-visitkamchatka.js           -- полный импорт
 *   node scripts/scrape-guides-visitkamchatka.js --debug   -- дамп структуры, без записи
 *   node scripts/scrape-guides-visitkamchatka.js --dry-run -- парсинг без записи в БД
 */

'use strict';

const { JSDOM } = require('jsdom');
const { Pool }  = require('pg');
const fs        = require('fs');
const path      = require('path');

// ── Env ───────────────────────────────────────────────────────────────────────

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

const GUIDES_URL = 'https://visitkamchatka.ru/guides/';
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Debug ─────────────────────────────────────────────────────────────────────

function debugStructure(html) {
  const dom = new JSDOM(html, { url: GUIDES_URL });
  const doc = dom.window.document;

  console.log('\n=== PAGE TITLE ===');
  console.log(doc.querySelector('title')?.textContent);

  console.log('\n=== H1/H2 ===');
  doc.querySelectorAll('h1,h2,h3').forEach(h => {
    const t = h.textContent.trim().slice(0, 80);
    if (t) console.log(`  <${h.tagName.toLowerCase()}> ${t}`);
  });

  console.log('\n=== LINKS TO /guides/ ===');
  let cnt = 0;
  doc.querySelectorAll('a[href]').forEach(a => {
    if (a.href?.includes('/guides/') && cnt++ < 20)
      console.log(`  ${a.href} → "${a.textContent.trim().slice(0, 60)}"`);
  });

  console.log('\n=== TOP CSS CLASSES ===');
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

  console.log('\n=== RAW HTML (первые 4000 символов) ===');
  console.log(html.slice(0, 4000));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractPhone(text) {
  const m = text.match(/(?:\+7|8)[\s\-]?\(?\d{3}\)?[\s\-]?\d{3}[\s\-]?\d{2}[\s\-]?\d{2}/);
  return m ? m[0].replace(/\s/g, '') : undefined;
}

function extractEmail(text) {
  const m = text.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
  return m ? m[0].toLowerCase() : undefined;
}

function extractCertNumber(text) {
  const m = text.match(/(?:аттест|свидетельство|сертификат|удостоверение|лиценз|рег\.?\s*№)[^\n]{0,60}((?:№\s*)?[\dА-Яа-я][\d\-/А-Яа-я]{3,30})/i);
  return m ? m[1].trim() : undefined;
}

function extractSpecializations(text) {
  const specs = [];
  if (/вулкан/i.test(text))            specs.push('volcano');
  if (/трекинг|поход|пеш/i.test(text)) specs.push('trekking');
  if (/рыбал/i.test(text))             specs.push('fishing');
  if (/вертол/i.test(text))            specs.push('helicopter');
  if (/морск|катер/i.test(text))       specs.push('boat');
  if (/снегоход/i.test(text))          specs.push('snowmobile');
  if (/сплав|рафт/i.test(text))        specs.push('rafting');
  if (/медвед/i.test(text))            specs.push('bears');
  if (/фото/i.test(text))              specs.push('photo');
  if (/орнитол|птиц/i.test(text))      specs.push('birds');
  return specs;
}

function toSlug(name) {
  const MAP = {
    а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'yo',ж:'zh',з:'z',
    и:'i',й:'j',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',
    с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',щ:'shch',
    ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya',
  };
  return 'vk-guide-' + name.toLowerCase()
    .replace(/[а-яё]/g, c => MAP[c] ?? c)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 70);
}

// ── Парсинг листинга и страниц гидов ─────────────────────────────────────────

function extractGuideLinks(html) {
  const dom = new JSDOM(html, { url: GUIDES_URL });
  const doc = dom.window.document;
  const links = new Set();
  doc.querySelectorAll('a[href]').forEach(a => {
    try {
      const href = new URL(a.href, GUIDES_URL);
      if (
        href.hostname === 'visitkamchatka.ru' &&
        href.pathname.startsWith('/guides/') &&
        href.pathname !== '/guides/' &&
        href.pathname.length > '/guides/'.length
      ) {
        links.add(href.href.replace(/#.*$/, '').replace(/\/$/, '') + '/');
      }
    } catch { /* skip */ }
  });
  return [...links];
}

function parseGuideCards(html) {
  const dom = new JSDOM(html, { url: GUIDES_URL });
  const doc = dom.window.document;
  const results = [];

  const cardSelectors = [
    '.guide-item', '.guide-card', '.person-item', '.person-card',
    'article.guide', 'article.person', 'article.item',
    '.b-guide', '.b-person', '.item-guide', '.item-person',
    '[class*="guide-"]', '[class*="person-"]',
    '.catalog-item', '.catalog__item',
  ];

  let cards = [];
  for (const sel of cardSelectors) {
    const found = [...doc.querySelectorAll(sel)];
    if (found.length > 1) {
      cards = found;
      console.log(`  Found ${found.length} guide cards via "${sel}"`);
      break;
    }
  }

  // Fallback: блоки с именем (ФИО паттерн) и ссылкой на /guides/
  if (cards.length === 0) {
    doc.querySelectorAll('div,article,li').forEach(el => {
      const link = el.querySelector('a[href*="/guides/"]');
      const h = el.querySelector('h2,h3,h4,strong,.name,.title');
      if (link && h && h.textContent.trim().length > 3 && el.textContent.length < 5000)
        cards.push(el);
    });
    if (cards.length > 0) console.log(`  Fallback: found ${cards.length} guide blocks`);
  }

  for (const card of cards) {
    const nameEl = card.querySelector('h1,h2,h3,h4,strong,.name,.title,.guide-name');
    const name = nameEl?.textContent?.trim()?.replace(/\s+/g, ' ');
    if (!name || name.length < 3 || name.length > 150) continue;

    const text = card.textContent || '';
    const guidePageLink = card.querySelector('a[href*="/guides/"]')?.href;
    const photo = card.querySelector('img')?.src;

    results.push({
      name,
      slug: toSlug(name),
      phone: extractPhone(text),
      email: extractEmail(text),
      cert_number: extractCertNumber(text),
      specializations: extractSpecializations(text),
      description: text.replace(/\s+/g, ' ').trim().slice(0, 500),
      external_source_url: guidePageLink || GUIDES_URL,
      photo_url: photo || undefined,
    });
  }
  return results;
}

function parseGuidePage(html, url) {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;

  const h1 = doc.querySelector('h1');
  const name = h1?.textContent?.trim()?.replace(/\s+/g, ' ');
  if (!name || name.length < 3) return null;

  const text = doc.body?.textContent?.replace(/\s+/g, ' ') || '';
  const photo = doc.querySelector('img.guide-photo, .guide-img img, .person-photo img, img[src*="guide"], img[src*="person"]')?.src
    || doc.querySelector('.article-image img, .intro img')?.src;

  const firstP = [...doc.querySelectorAll('p')].find(p => p.textContent.trim().length > 60);
  const description = firstP?.textContent?.trim()?.slice(0, 600);

  return {
    name,
    slug: toSlug(name),
    phone: extractPhone(text),
    email: extractEmail(text),
    cert_number: extractCertNumber(text),
    specializations: extractSpecializations(text),
    description,
    external_source_url: url,
    photo_url: photo || undefined,
  };
}

// ── DB upsert ─────────────────────────────────────────────────────────────────

async function upsertGuide(guide) {
  if (!pool) return { status: 'skip', id: null };

  const contactJson = JSON.stringify({
    phone: guide.phone ?? null,
    email: guide.email ?? null,
  });

  const { rows: existing } = await pool.query(
    `SELECT id FROM partners WHERE slug = $1 OR (external_source = 'visitkamchatka' AND company_name = $2 AND category = 'guide') LIMIT 1`,
    [guide.slug, guide.name],
  );

  let id;
  if (existing.length > 0) {
    id = existing[0].id;
    await pool.query(
      `UPDATE partners SET
         company_name        = COALESCE(NULLIF($2,''), company_name),
         contact             = $3::jsonb,
         external_source     = 'visitkamchatka',
         external_source_url = $4,
         description         = COALESCE(NULLIF($5,''), description),
         services            = COALESCE($6, services),
         updated_at          = NOW()
       WHERE id = $1`,
      [
        id, guide.name, contactJson, guide.external_source_url,
        guide.description ?? null,
        guide.specializations?.length ? `{${guide.specializations.join(',')}}` : null,
      ],
    );
    return { status: 'updated', id };
  }

  const { rows } = await pool.query(
    `INSERT INTO partners (
       slug, company_name, name, category, contact,
       external_source, external_source_url,
       description, services,
       is_verified, is_public, commission_current
     ) VALUES ($1,$2,$2,'guide',$3::jsonb,'visitkamchatka',$4,$5,$6,false,false,0)
     ON CONFLICT (slug) DO UPDATE SET
       company_name        = EXCLUDED.company_name,
       contact             = EXCLUDED.contact,
       external_source_url = EXCLUDED.external_source_url,
       description         = COALESCE(EXCLUDED.description, partners.description),
       updated_at          = NOW()
     RETURNING id`,
    [
      guide.slug, guide.name, contactJson, guide.external_source_url,
      guide.description ?? null,
      guide.specializations?.length ? `{${guide.specializations.join(',')}}` : null,
    ],
  );
  id = rows[0]?.id;
  return { status: 'inserted', id };
}

async function upsertCertification(guideId, certNumber) {
  if (!pool || !certNumber) return;
  await pool.query(
    `INSERT INTO guide_certifications (guide_id, name, issuing_authority, certificate_number, is_verified)
     VALUES ($1, 'Аттестат гида Камчатки', 'Министерство туризма Камчатского края', $2, true)
     ON CONFLICT DO NOTHING`,
    [guideId, certNumber],
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n=== Guide Scraper: ${GUIDES_URL} ===`);
  console.log(`Mode: ${DEBUG ? 'DEBUG' : DRY_RUN ? 'DRY-RUN' : 'LIVE'}`);
  if (!BRIGHTDATA_TOKEN) console.warn('  BRIGHTDATA_API_TOKEN not set — using direct fetch');

  console.log('\n[1/3] Fetching guides listing page...');
  const listingHtml = await smartFetch(GUIDES_URL);
  if (!listingHtml) {
    console.error('Failed to fetch listing page');
    process.exit(1);
  }
  console.log(`  Got ${listingHtml.length} bytes`);

  if (DEBUG) {
    debugStructure(listingHtml);
    process.exit(0);
  }

  // Пробуем найти ссылки на индивидуальные страницы гидов
  const guideLinks = extractGuideLinks(listingHtml);
  console.log(`\n[2/3] Found ${guideLinks.length} guide page links`);

  let guides = [];

  if (guideLinks.length > 0) {
    // Скрейпим каждую страницу гида
    for (const url of guideLinks) {
      console.log(`  Fetching: ${url}`);
      const html = await smartFetch(url);
      if (!html) { console.warn(`  Skip (no HTML): ${url}`); continue; }
      const guide = parseGuidePage(html, url);
      if (guide) guides.push(guide);
      await sleep(600 + Math.random() * 400);
    }
  } else {
    // Парсим карточки прямо с листинга
    console.log('  No individual pages found — parsing listing cards');
    guides = parseGuideCards(listingHtml);
  }

  console.log(`\n  Parsed ${guides.length} guides`);

  if (guides.length === 0) {
    console.warn('\n  No guides found. Run with --debug to inspect page structure.');
    process.exit(0);
  }

  if (DRY_RUN) {
    console.log('\n[DRY-RUN] Would insert/update:');
    guides.forEach(g => {
      console.log(`  ${g.name} | ${g.phone ?? '-'} | ${g.email ?? '-'} | cert: ${g.cert_number ?? '-'} | ${g.specializations.join(',') || '-'}`);
    });
    process.exit(0);
  }

  // ── Шаг 3: Сохранение ──
  console.log('\n[3/3] Saving to DB...');
  let inserted = 0, updated = 0, errors = 0;
  for (const guide of guides) {
    try {
      const { status, id } = await upsertGuide(guide);
      if (status === 'inserted') inserted++;
      else if (status === 'updated') updated++;
      if (id && guide.cert_number) await upsertCertification(id, guide.cert_number);
      console.log(`  [${status}] ${guide.name}`);
    } catch (e) {
      errors++;
      console.error(`  [ERROR] ${guide.name}: ${e.message}`);
    }
  }

  console.log(`\n=== Done ===`);
  console.log(`  Inserted: ${inserted}`);
  console.log(`  Updated:  ${updated}`);
  console.log(`  Errors:   ${errors}`);

  if (pool) await pool.end();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
