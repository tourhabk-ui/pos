#!/usr/bin/env node
/**
 * scripts/scrape-visitkamchatka-photos.js
 *
 * Скрапит фотографии с visitkamchatka.ru для мест у которых есть source_url
 * но нет фото в БД. Качает бинарники и сохраняет в ai_route_images.
 *
 * Источник: visitkamchatka.ru — официальный туристический портал Камчатки.
 *
 * Usage:
 *   node scripts/scrape-visitkamchatka-photos.js              -- всё
 *   node scripts/scrape-visitkamchatka-photos.js --dry-run    -- без записи в БД
 *   node scripts/scrape-visitkamchatka-photos.js --limit=20   -- первые N мест
 *   node scripts/scrape-visitkamchatka-photos.js --stats      -- только статистика
 */

'use strict';

const { JSDOM } = require('jsdom');
const { Pool }  = require('pg');
const fs        = require('fs');
const path      = require('path');

const origErr = console.error;
console.error = (...a) => {
  if (typeof a[0] === 'string' && a[0].includes('Could not parse CSS')) return;
  origErr(...a);
};

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

const DATABASE_URL = process.env.DATABASE_URL;
const DRY_RUN    = process.argv.includes('--dry-run');
const STATS_ONLY = process.argv.includes('--stats');
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '9999', 10);

if (!DATABASE_URL) { console.error('DATABASE_URL не задан'); process.exit(1); }

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('sslmode=no-verify') ? { rejectUnauthorized: false } : undefined,
  max: 3,
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchHtml(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ru-RU,ru;q=0.9',
      },
    });
    clearTimeout(timer);
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return { html: await res.text() };
  } catch (e) {
    clearTimeout(timer);
    return { error: String(e.message || e) };
  }
}

async function fetchImage(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0',
        'Referer': 'https://www.visitkamchatka.ru/',
      },
    });
    clearTimeout(timer);
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const contentType = res.headers.get('content-type') || 'image/jpeg';
    const mime = contentType.split(';')[0].trim();
    if (!mime.startsWith('image/')) return { error: `Не картинка: ${mime}` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 5000) return { error: `Слишком маленький файл: ${buf.length} байт` };
    return { buf, mime };
  } catch (e) {
    clearTimeout(timer);
    return { error: String(e.message || e) };
  }
}

function extractPhotoUrls(html, sourceUrl) {
  let doc;
  try { doc = new JSDOM(html).window.document; } catch { return []; }

  const base = new URL(sourceUrl).origin;
  const candidates = [];

  // og:image — самый надёжный
  const og = doc.querySelector('meta[property="og:image"]');
  if (og?.content) candidates.push(og.content);

  // Галерея / слайдер
  const gallerySelectors = [
    '.gallery img', '.slider img', '.swiper-slide img',
    '.place-photos img', '.route-photos img', '.photos-block img',
    'figure img', '.content-photo img', '.hero-photo img',
    '.main-photo img', '[class*="photo"] img', '[class*="gallery"] img',
    'article img', '.detail-content img', '.place-content img',
  ];
  for (const sel of gallerySelectors) {
    doc.querySelectorAll(sel).forEach(img => {
      const src = img.src || img.dataset?.src || img.getAttribute('data-lazy-src') || '';
      if (src) candidates.push(src);
    });
  }

  // Fallback — все img с «говорящими» путями
  doc.querySelectorAll('img').forEach(img => {
    const src = img.src || img.dataset?.src || '';
    if (src && /upload|photo|image|media|content/i.test(src)) candidates.push(src);
  });

  const seen = new Set();
  const result = [];
  for (const raw of candidates) {
    if (!raw) continue;
    let abs;
    try { abs = new URL(raw, base).href; } catch { continue; }
    if (seen.has(abs)) continue;
    seen.add(abs);
    if (/thumb|icon|avatar|logo|sprite|flag|arrow|btn/i.test(abs)) continue;
    if (!/\.(jpg|jpeg|png|webp)(\?|$)/i.test(abs) && !abs.includes('image')) continue;
    result.push(abs);
  }
  return result;
}

async function printStats() {
  const { rows } = await pool.query(`
    SELECT
      COUNT(*)                                                    AS total_places,
      COUNT(*) FILTER (WHERE source_url LIKE '%visitkamchatka%') AS visitkamchatka,
      COUNT(*) FILTER (WHERE photo_url IS NOT NULL)              AS with_photo_url,
      (SELECT COUNT(*) FROM ai_route_images)                     AS ai_images_total,
      (SELECT COUNT(DISTINCT route_id) FROM ai_route_images)     AS places_with_images
    FROM places
  `);
  const r = rows[0];
  console.log('\n=== СТАТИСТИКА ===');
  console.log(`Мест всего:              ${r.total_places}`);
  console.log(`visitkamchatka.ru:       ${r.visitkamchatka}`);
  console.log(`С photo_url:             ${r.with_photo_url}`);
  console.log(`Записей ai_route_images: ${r.ai_images_total}`);
  console.log(`Мест с фото (ai_table):  ${r.places_with_images}`);
}

async function run() {
  await printStats();
  if (STATS_ONLY) { await pool.end(); return; }

  const { rows: places } = await pool.query(`
    SELECT p.id, p.ark_id, p.name, p.source_url, p.location_type
    FROM places p
    WHERE p.source_url LIKE '%visitkamchatka%'
      AND p.photo_url IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM ai_route_images ai WHERE ai.route_id = p.ark_id
      )
    ORDER BY p.name
    LIMIT $1
  `, [LIMIT]);

  console.log(`\nМест для обработки: ${places.length}\n`);
  if (places.length === 0) {
    console.log('Все места уже имеют фото.');
    await pool.end();
    return;
  }

  let ok = 0, skip = 0, fail = 0;

  for (let i = 0; i < places.length; i++) {
    const p = places[i];
    process.stdout.write(`[${i + 1}/${places.length}] ${p.name} … `);

    const { html, error: htmlErr } = await fetchHtml(p.source_url);
    if (htmlErr) {
      console.log(`ОШИБКА страницы: ${htmlErr}`);
      fail++;
      await sleep(1000);
      continue;
    }

    const photoUrls = extractPhotoUrls(html, p.source_url);
    if (photoUrls.length === 0) {
      console.log('нет фото на странице');
      skip++;
      await sleep(800);
      continue;
    }

    let downloaded = false;
    for (const imgUrl of photoUrls.slice(0, 5)) {
      const { buf, mime, error: imgErr } = await fetchImage(imgUrl);
      if (imgErr) continue;

      if (DRY_RUN) {
        console.log(`[dry] ${imgUrl} (${(buf.length / 1024).toFixed(0)} KB, ${mime})`);
        downloaded = true;
        ok++;
        break;
      }

      try {
        await pool.query(
          `INSERT INTO ai_route_images (route_id, image_data, mime_type)
           VALUES ($1, $2, $3)
           ON CONFLICT (route_id) DO UPDATE SET image_data = EXCLUDED.image_data, mime_type = EXCLUDED.mime_type`,
          [p.ark_id, buf, mime],
        );
        await pool.query(`UPDATE places SET photo_url = $1 WHERE id = $2`, [imgUrl, p.id]);
        console.log(`OK (${(buf.length / 1024).toFixed(0)} KB)`);
        ok++;
        downloaded = true;
        break;
      } catch (dbErr) {
        console.log(`ОШИБКА БД: ${dbErr.message}`);
        fail++;
        downloaded = true;
        break;
      }
    }

    if (!downloaded) {
      console.log(`не удалось скачать (${Math.min(photoUrls.length, 5)} попыток)`);
      skip++;
    }

    await sleep(600 + Math.random() * 400);
  }

  console.log(`\n=== ИТОГ ===`);
  console.log(`Загружено:  ${ok}`);
  console.log(`Пропущено:  ${skip}`);
  console.log(`Ошибок:     ${fail}`);

  if (!DRY_RUN && ok > 0) await printStats();
  await pool.end();
}

run().catch(e => { console.error('Критическая ошибка:', e); process.exit(1); });
