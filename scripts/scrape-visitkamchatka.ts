#!/usr/bin/env npx tsx
/**
 * scripts/scrape-visitkamchatka.ts
 *
 * Парсит маршруты с visitkamchatka.ru через Bright Data Web Unlocker.
 * Извлекает: название, описание, дистанцию, длительность, сложность, сезон,
 *            снаряжение, опасности, МЧС-телефон, зону, PDF-ссылку.
 *
 * Запуск:
 *   npx tsx scripts/scrape-visitkamchatka.ts              -- парсим, пишем в БД
 *   npx tsx scripts/scrape-visitkamchatka.ts --dry-run    -- только парсинг, без БД
 *   npx tsx scripts/scrape-visitkamchatka.ts --stats      -- статистика БД
 *   npx tsx scripts/scrape-visitkamchatka.ts --limit=10   -- только N маршрутов
 */

import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';

// ── Env ───────────────────────────────────────────────────────────────────────

function loadEnv() {
  for (const f of ['.env.local', '.env']) {
    const p = path.resolve(process.cwd(), f);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
    break;
  }
}
loadEnv();

const BD_TOKEN    = process.env.BRIGHTDATA_API_TOKEN ?? '';
const DB_URL      = process.env.DATABASE_URL ?? '';
const DRY_RUN     = process.argv.includes('--dry-run');
const STATS_ONLY  = process.argv.includes('--stats');
const LIMIT_ARG   = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] ?? '999', 10);

if (!BD_TOKEN) { console.error('BRIGHTDATA_API_TOKEN not set'); process.exit(1); }
if (!DB_URL)   { console.error('DATABASE_URL not set'); process.exit(1); }

// ── Types ─────────────────────────────────────────────────────────────────────

interface ParsedRoute {
  title: string;
  pdfUrl: string | null;
  htmlSlug: string | null;
  description: string | null;
  zone: string | null;
  distanceKm: number | null;
  durationHours: number | null;
  difficulty: string | null;
  season: string | null;
  activityType: string;
  equipment: string[];
  hazards: string[];
  mchsPhone: string | null;
  mchsRequired: boolean;
  sourceUrl: string;
}

// ── Bright Data ────────────────────────────────────────────────────────────────

async function fetchPage(url: string): Promise<string | null> {
  try {
    const res = await fetch('https://api.brightdata.com/request', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${BD_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ zone: 'unlocker', url, format: 'raw' }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      console.warn(`  [BD] ${res.status} for ${url}`);
      return null;
    }
    return await res.text();
  } catch (e) {
    console.warn(`  [BD] fetch error: ${e}`);
    return null;
  }
}

// ── Парсинг страницы-списка (/route-passports/) ────────────────────────────────

interface RawListing {
  title: string;
  pdfUrl: string;
  slug: string | null;
}

const HTML_SLUGS: Record<string, string> = {
  'bukhta-pionerskaya': 'Бухта Пионерская',
  'dachnye-istochniki': 'Дачные источники',
  'ganalskie-vostryaki': 'Ганальские Востряки',
  'golubye-ozera': 'Голубые озера',
  'gornyy-massiv-vachkazhets': 'Горный массив Вачкажец',
  'kamchatskiy-kamen': 'Камчатский камень',
  'mayak-petropavlovskiy-mys-vertikalnyy': 'Маяк Петропавловский',
  'mys-mayachnyy': 'Мыс Маячный',
  'vodopad-babiy-kamen': 'Бабий камень',
  'vodopad-snezhnyy-bars-na-ruche-spokoynyy': 'Водопад Снежный Барс',
};

function parseListingHtml(html: string): RawListing[] {
  const results: RawListing[] = [];
  // PDF ссылки вида /upload/iblock/.../filename.pdf
  const linkRe = /href="(\/(?:upload|iblock)[^"]+\.pdf)"[^>]*>([^<]{5,80})</gi;
  let m;
  const seen = new Set<string>();

  while ((m = linkRe.exec(html)) !== null) {
    const pdfPath = m[1];
    const rawTitle = m[2].trim().replace(/\s+/g, ' ');
    if (!rawTitle || seen.has(pdfPath)) continue;
    seen.add(pdfPath);

    // Ищем HTML-slug по похожести названия
    const slug = Object.entries(HTML_SLUGS).find(([, t]) =>
      rawTitle.toLowerCase().includes(t.toLowerCase().slice(0, 8))
    )?.[0] ?? null;

    results.push({
      title: rawTitle,
      pdfUrl: `https://visitkamchatka.ru${pdfPath}`,
      slug,
    });
  }

  // Также ищем прямые ссылки на HTML маршруты
  const routeLinkRe = /href="(\/routes\/([a-z0-9-]+)\/)"/gi;
  while ((m = routeLinkRe.exec(html)) !== null) {
    const htmlSlug = m[2];
    if (!Object.keys(HTML_SLUGS).includes(htmlSlug)) continue;
    // Добавим если не уже добавлен через PDF
    const exists = results.find(r => r.slug === htmlSlug);
    if (!exists) {
      results.push({
        title: HTML_SLUGS[htmlSlug],
        pdfUrl: null,
        slug: htmlSlug,
      });
    }
  }

  return results;
}

// ── Парсинг HTML-страницы маршрута ────────────────────────────────────────────

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractText(html: string, re: RegExp): string | null {
  const m = html.match(re);
  return m ? stripTags(m[1]).slice(0, 500) : null;
}

function parseNumber(s: string | null): number | null {
  if (!s) return null;
  const m = s.match(/[\d.,]+/);
  return m ? parseFloat(m[0].replace(',', '.')) : null;
}

function detectDifficulty(text: string): string | null {
  const t = text.toLowerCase();
  if (/сложн|трудн|expert|advanced/.test(t)) return 'hard';
  if (/средн|умеренн|moderate/.test(t)) return 'medium';
  if (/лёгк|легк|начинающ|easy|beginner/.test(t)) return 'easy';
  return null;
}

function detectSeason(text: string): string | null {
  const t = text.toLowerCase();
  if (/круглогодич|all.?year|зимн.+летн|летн.+зимн/.test(t)) return 'all';
  if (/зим/.test(t) && /лет/.test(t)) return 'all';
  if (/зим/.test(t)) return 'winter';
  if (/лет|июн|июл|авг|сент/.test(t)) return 'summer';
  return null;
}

function detectActivity(title: string, desc: string): string {
  const t = (title + ' ' + desc).toLowerCase();
  if (/вертолет/.test(t)) return 'helicopter';
  if (/снегоход/.test(t)) return 'snowmobile';
  if (/рыбалк|лосос|salmon/.test(t)) return 'fishing';
  if (/медвед/.test(t)) return 'bears';
  if (/гейзер/.test(t)) return 'geysers';
  if (/вулкан|восхожден/.test(t)) return 'volcano';
  if (/термал|источник/.test(t)) return 'hot_spring';
  if (/море|морск|яхт/.test(t)) return 'sea';
  if (/сплав|рафт|каяк/.test(t)) return 'rafting';
  if (/снегоход/.test(t)) return 'snowmobile';
  return 'trekking';
}

function detectZone(text: string): string | null {
  const zones: [RegExp, string][] = [
    [/налычев/i, 'Налычево'],
    [/авачинск/i, 'Авача'],
    [/мутновск/i, 'Мутновский'],
    [/вилючинск/i, 'Вилючинский'],
    [/корякск/i, 'Корякский'],
    [/ключевск/i, 'Ключевской'],
    [/курильск/i, 'Курильское озеро'],
    [/долина гейзер/i, 'Долина гейзеров'],
    [/халактырск/i, 'Халактырский пляж'],
    [/петропавловск/i, 'Петропавловск-Камчатский'],
  ];
  for (const [re, zone] of zones) {
    if (re.test(text)) return zone;
  }
  return null;
}

function extractEquipment(text: string): string[] {
  const eq: string[] = [];
  if (/треккинг.*ботинк|ботинк.*треккинг|горные ботинк/i.test(text)) eq.push('треккинговые ботинки');
  if (/палк[иа]/i.test(text)) eq.push('треккинговые палки');
  if (/аптечк/i.test(text)) eq.push('аптечка');
  if (/антизверь|от медвед|медвежь.*спрей/i.test(text)) eq.push('средство от медведей');
  if (/дождев|непромокаем/i.test(text)) eq.push('дождевик');
  if (/термос|горелк|газ/i.test(text)) eq.push('горелка и термос');
  if (/навигатор|gps/i.test(text)) eq.push('GPS-навигатор');
  if (/каск[аи]/i.test(text)) eq.push('каска');
  if (/кошки|ледоруб/i.test(text)) eq.push('кошки/ледоруб');
  if (/спасательн.*жилет/i.test(text)) eq.push('спасательный жилет');
  return eq;
}

function extractHazards(text: string): string[] {
  const h: string[] = [];
  if (/камнепад/i.test(text)) h.push('камнепад');
  if (/лавин/i.test(text)) h.push('лавины');
  if (/медвед/i.test(text)) h.push('дикие животные');
  if (/термал|кипяток|горяч.*вод|900.*°/i.test(text)) h.push('термальные источники');
  if (/вулканическ.*газ|серн.*газ|серовод/i.test(text)) h.push('вулканические газы');
  if (/переправ|брод|брод/i.test(text)) h.push('переправы через реки');
  if (/туман|низк.*облачн/i.test(text)) h.push('туман');
  if (/высотн|горн.*болезн/i.test(text)) h.push('горная болезнь');
  return h;
}

function extractMchsPhone(text: string): string | null {
  const m = text.match(/\+?7\s*[\(\-]?41\d{2}[\)\-\s]?\d{2}[\-\s]?\d{2}[\-\s]?\d{2}/);
  return m ? m[0].replace(/\s/g, '') : null;
}

function parseRouteHtml(html: string, title: string, sourceUrl: string): Partial<ParsedRoute> {
  // Описание: первые крупные текстовые блоки
  const mainTextRe = /<(?:p|div)[^>]*class="[^"]*(?:text|desc|content|article)[^"]*"[^>]*>([\s\S]{100,}?)<\/(?:p|div)>/i;
  const descRaw = extractText(html, mainTextRe) ?? stripTags(html).slice(0, 800);
  const description = descRaw.length > 50 ? descRaw : null;

  const fullText = stripTags(html);

  // Дистанция
  const distRe = /(\d+[.,]?\d*)\s*км/i;
  const distM  = fullText.match(distRe);
  const distanceKm = distM ? parseFloat(distM[1].replace(',', '.')) : null;

  // Длительность в часах
  const durDayM   = fullText.match(/(\d+)\s*(?:дн|день|дней|суток)/i);
  const durHourM  = fullText.match(/(\d+)\s*ч(?:ас|асов)?/i);
  let durationHours: number | null = null;
  if (durDayM)  durationHours = parseInt(durDayM[1]) * 8;
  else if (durHourM) durationHours = parseInt(durHourM[1]);

  const difficulty  = detectDifficulty(fullText);
  const season      = detectSeason(fullText);
  const activityType = detectActivity(title, fullText);
  const zone        = detectZone(title + ' ' + fullText);
  const equipment   = extractEquipment(fullText);
  const hazards     = extractHazards(fullText);
  const mchsPhone   = extractMchsPhone(fullText);
  const mchsRequired = /мчс|регистр|спасател|обязател/i.test(fullText);

  return {
    description,
    zone,
    distanceKm,
    durationHours,
    difficulty,
    season,
    activityType,
    equipment,
    hazards,
    mchsPhone,
    mchsRequired,
    sourceUrl,
  };
}

// ── Database ──────────────────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: DB_URL,
  ssl: DB_URL.includes('sslmode=no-verify') ? { rejectUnauthorized: false } : undefined,
  max: 3,
});

async function showStats() {
  const res = await pool.query(`
    SELECT
      COUNT(*)                                             AS total,
      COUNT(description)                                   AS with_desc,
      COUNT(distance_km)                                   AS with_dist,
      COUNT(duration_hours)                                AS with_dur,
      COUNT(difficulty)                                    AS with_diff,
      COUNT(season)                                        AS with_season,
      COUNT(NULLIF(array_length(equipment, 1), 0))         AS with_equip,
      COUNT(NULLIF(array_length(hazards,   1), 0))         AS with_hazards,
      COUNT(geometry)                                      AS with_geometry,
      COUNT(mchs_phone)                                    AS with_mchs_phone
    FROM kamchatka_routes
  `);
  const r = res.rows[0];
  console.log('\n  kamchatka_routes stats:');
  console.log(`  total:        ${r.total}`);
  console.log(`  description:  ${r.with_desc} / ${r.total}`);
  console.log(`  distance_km:  ${r.with_dist} / ${r.total}`);
  console.log(`  duration:     ${r.with_dur} / ${r.total}`);
  console.log(`  difficulty:   ${r.with_diff} / ${r.total}`);
  console.log(`  season:       ${r.with_season} / ${r.total}`);
  console.log(`  equipment:    ${r.with_equip} / ${r.total}`);
  console.log(`  hazards:      ${r.with_hazards} / ${r.total}`);
  console.log(`  geometry:     ${r.with_geometry} / ${r.total}`);
  console.log(`  mchs_phone:   ${r.with_mchs_phone} / ${r.total}`);
}

async function upsertRoute(r: ParsedRoute): Promise<'inserted' | 'updated' | 'skip'> {
  // Ищем по title (ILIKE)
  const existing = await pool.query(
    `SELECT id, description, distance_km FROM kamchatka_routes WHERE title ILIKE $1 LIMIT 1`,
    [r.title]
  );

  if (existing.rows.length === 0) {
    // Вставляем новый маршрут
    await pool.query(
      `INSERT INTO kamchatka_routes
         (title, description, zone, distance_km, duration_hours, difficulty,
          season, activity_type, equipment, hazards, mchs_phone,
          mchs_registration_required, source_url, source_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'visitkamchatka.ru')
       ON CONFLICT DO NOTHING`,
      [
        r.title, r.description, r.zone, r.distanceKm, r.durationHours,
        r.difficulty, r.season, r.activityType,
        r.equipment.length ? r.equipment : null,
        r.hazards.length   ? r.hazards   : null,
        r.mchsPhone, r.mchsRequired, r.sourceUrl,
      ]
    );
    return 'inserted';
  }

  const row = existing.rows[0];
  // Обновляем только пустые поля
  await pool.query(
    `UPDATE kamchatka_routes SET
       description  = COALESCE(NULLIF(description, ''),  $2),
       zone         = COALESCE(zone,          $3),
       distance_km  = COALESCE(distance_km,   $4),
       duration_hours = COALESCE(duration_hours, $5),
       difficulty   = COALESCE(difficulty,    $6),
       season       = COALESCE(season,        $7),
       activity_type = COALESCE(activity_type, $8),
       equipment    = CASE WHEN equipment IS NULL OR array_length(equipment,1) = 0 THEN $9 ELSE equipment END,
       hazards      = CASE WHEN hazards   IS NULL OR array_length(hazards,  1) = 0 THEN $10 ELSE hazards END,
       mchs_phone   = COALESCE(mchs_phone,  $11),
       mchs_registration_required = COALESCE(mchs_registration_required, $12),
       source_url   = COALESCE(NULLIF(source_url, ''), $13),
       updated_at   = NOW()
     WHERE id = $1`,
    [
      row.id, r.description, r.zone, r.distanceKm, r.durationHours,
      r.difficulty, r.season, r.activityType,
      r.equipment.length ? r.equipment : null,
      r.hazards.length   ? r.hazards   : null,
      r.mchsPhone, r.mchsRequired, r.sourceUrl,
    ]
  );
  return 'updated';
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (STATS_ONLY) {
    await showStats();
    await pool.end();
    return;
  }

  console.log(`\nvisit kamchatka scraper | dry=${DRY_RUN} | limit=${LIMIT_ARG}\n`);

  // ── Шаг 1: получаем список маршрутов с /route-passports/
  console.log('Fetching route list from /route-passports/ ...');
  const listHtml = await fetchPage('https://visitkamchatka.ru/route-passports/');
  if (!listHtml) { console.error('Failed to fetch route list'); process.exit(1); }

  let listing = parseListingHtml(listHtml);
  console.log(`  Found ${listing.length} routes in listing`);

  // Добавляем HTML маршруты которых нет в листинге
  for (const [slug, title] of Object.entries(HTML_SLUGS)) {
    if (!listing.find(r => r.slug === slug)) {
      listing.push({ title, pdfUrl: null, slug });
    }
  }

  listing = listing.slice(0, LIMIT_ARG);
  console.log(`  Processing ${listing.length} routes\n`);

  let inserted = 0, updated = 0, errors = 0;

  for (let i = 0; i < listing.length; i++) {
    const item = listing[i];
    const prefix = `[${String(i + 1).padStart(3, ' ')}/${listing.length}]`;

    // ── Шаг 2: скрапим HTML-страницу маршрута (если slug есть)
    let htmlData: Partial<ParsedRoute> = {};
    const htmlUrl = item.slug ? `https://visitkamchatka.ru/routes/${item.slug}/` : null;

    if (htmlUrl) {
      process.stdout.write(`${prefix} ${item.title} ... `);
      const html = await fetchPage(htmlUrl);
      if (html) {
        htmlData = parseRouteHtml(html, item.title, htmlUrl);
        process.stdout.write(`ok\n`);
      } else {
        process.stdout.write(`fetch failed\n`);
      }
    } else {
      console.log(`${prefix} ${item.title} (PDF only)`);
    }

    const route: ParsedRoute = {
      title:        item.title,
      pdfUrl:       item.pdfUrl,
      htmlSlug:     item.slug,
      description:  htmlData.description ?? null,
      zone:         htmlData.zone ?? detectZone(item.title),
      distanceKm:   htmlData.distanceKm ?? null,
      durationHours: htmlData.durationHours ?? null,
      difficulty:   htmlData.difficulty ?? detectDifficulty(item.title),
      season:       htmlData.season ?? detectSeason(item.title),
      activityType: htmlData.activityType ?? detectActivity(item.title, ''),
      equipment:    htmlData.equipment ?? [],
      hazards:      htmlData.hazards ?? [],
      mchsPhone:    htmlData.mchsPhone ?? null,
      mchsRequired: htmlData.mchsRequired ?? false,
      sourceUrl:    htmlUrl ?? item.pdfUrl ?? 'https://visitkamchatka.ru/route-passports/',
    };

    if (!DRY_RUN) {
      try {
        const status = await upsertRoute(route);
        if (status === 'inserted') inserted++;
        else if (status === 'updated') updated++;
        if (!item.slug) console.log(`  -> ${status} (pdf-only, fields from title)`);
      } catch (e) {
        console.error(`  ERROR: ${e}`);
        errors++;
      }
    } else {
      console.log(`  [dry] ${route.title} | zone=${route.zone} | dist=${route.distanceKm} | dur=${route.durationHours}h | diff=${route.difficulty} | season=${route.season}`);
    }

    // Пауза чтобы не перегружать Bright Data
    if (i < listing.length - 1) await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\nDone. inserted=${inserted} updated=${updated} errors=${errors}`);

  if (!DRY_RUN) {
    console.log('\nFinal stats:');
    await showStats();
  }

  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
