/**
 * lib/services/operator-tour-scraper.ts
 *
 * Скрейпинг туров с сайтов операторов через AI-извлечение.
 * Вызывается из POST /api/admin/import/operators { action: "scrape_tours_per_operator" }
 *
 * Три слоя:
 *   1. СБОР   — Bright Data (mcp_unlocker) → прямой fallback
 *   2. AI     — callAIFast + Zod → структура (не regex: вёрстка у всех разная)
 *   3. ХРАНЕНИЕ — PostgreSQL → operator_tours + tour_availability
 */

import { pool } from '@/lib/db-pool';
import { fetchViaBrightData } from '@/lib/scraping/brightdata';
import { extractToursFromPage, type ScrapedTour } from '@/lib/operators/structurer';

const HDRS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
};

async function smartFetch(url: string): Promise<string | null> {
  const bd = await fetchViaBrightData(url, { country: 'ru', timeoutMs: 30_000 });
  if (bd) return bd;
  try {
    const res = await fetch(url, { headers: HDRS, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    return res.text();
  } catch {
    return null;
  }
}

function findTourPageLinks(html: string, website: string): string[] {
  const links = new Set<string>();
  let base: URL;
  try { base = new URL(website); } catch { return []; }

  const linkRe = /href="([^"]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    try {
      const u = new URL(m[1], website);
      if (u.hostname !== base.hostname) continue;
      if (/тур|tour|excur|экскурс|маршрут|route|program|прогр|поход|вулкан|рыбалк|сплав|морск/i.test(u.pathname + u.href)) {
        links.add(u.href.replace(/#.*$/, ''));
      }
    } catch { /* skip */ }
  }
  return [...links].slice(0, 10);
}

async function saveTour(tour: ScrapedTour, operatorId: string): Promise<'inserted' | 'updated'> {
  const { rows } = await pool.query<{ id: number }>(
    `SELECT id FROM operator_tours WHERE operator_id = $1 AND title = $2 LIMIT 1`,
    [operatorId, tour.title],
  );

  if (rows.length > 0) {
    await pool.query(
      `UPDATE operator_tours SET
         price_unit     = $2,
         price_note     = COALESCE($3, price_note),
         includes       = COALESCE($4, includes),
         source_url     = $5,
         parsed_at      = NOW(),
         is_stale       = FALSE,
         base_price     = COALESCE($6, base_price),
         activity_type  = $7,
         description    = COALESCE($8, description),
         duration_hours = COALESCE($9, duration_hours),
         group_size_max = COALESCE($10, group_size_max)
       WHERE id = $1`,
      [rows[0].id, tour.price_unit, tour.price_note, tour.includes, tour.source_url,
       tour.price_from, tour.category, tour.description, tour.duration_hours, tour.group_size_max],
    );
    return 'updated';
  }

  const { rows: inserted } = await pool.query<{ id: number }>(
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

  return 'inserted';
}

export interface ScrapeToursResult {
  operators_processed: number;
  tours_found: number;
  tours_saved: number;
  errors: number;
  log: string[];
}

export async function scrapeOperatorTours(options?: {
  categories?: string[];
  operatorSlug?: string;
  dryRun?: boolean;
  maxOperators?: number;
}): Promise<ScrapeToursResult> {
  const result: ScrapeToursResult = {
    operators_processed: 0,
    tours_found: 0,
    tours_saved: 0,
    errors: 0,
    log: [],
  };

  const { categories, operatorSlug, dryRun = false, maxOperators = 20 } = options ?? {};

  let qText = `SELECT id, slug, company_name AS name, website FROM partners WHERE website IS NOT NULL AND website != ''`;
  const qParams: string[] = [];
  if (operatorSlug) {
    qText += ` AND slug = $1`;
    qParams.push(operatorSlug);
  }
  qText += ` ORDER BY company_name`;

  const { rows: operators } = await pool.query<{ id: string; slug: string; name: string; website: string }>(
    qText, qParams,
  );

  const ops = operators.slice(0, maxOperators);
  result.log.push(`Операторов для обработки: ${ops.length}`);

  for (const op of ops) {
    result.operators_processed++;
    result.log.push(`[${op.name}] ${op.website}`);

    const mainHtml = await smartFetch(op.website);
    if (!mainHtml) {
      result.log.push(`  → не удалось получить страницу`);
      result.errors++;
      continue;
    }

    let allTours = await extractToursFromPage(mainHtml, op.website);
    result.log.push(`  Главная: ${allTours.length} туров`);

    if (allTours.length < 3) {
      const tourPages = findTourPageLinks(mainHtml, op.website);
      result.log.push(`  Подстраниц: ${tourPages.length}`);
      for (const pageUrl of tourPages.slice(0, 5)) {
        const pageHtml = await smartFetch(pageUrl);
        if (!pageHtml) continue;
        const pageTours = await extractToursFromPage(pageHtml, pageUrl);
        result.log.push(`    ${pageUrl} → ${pageTours.length} туров`);
        allTours = [...allTours, ...pageTours];
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    const toProcess = categories?.length
      ? allTours.filter(t => categories.includes(t.category))
      : allTours;

    result.log.push(`  После фильтра: ${toProcess.length} туров`);
    result.tours_found += toProcess.length;

    if (dryRun) {
      for (const t of toProcess) {
        const price = t.price_from ? `${t.price_from}₽ ${t.price_unit}` : 'цена не указана';
        result.log.push(`  [dry] ${t.category} · ${t.title} · ${price}`);
      }
      continue;
    }

    for (const tour of toProcess) {
      try {
        const status = await saveTour(tour, op.id);
        result.log.push(`  [${status}] ${tour.title}`);
        result.tours_saved++;
      } catch (e) {
        result.log.push(`  [ошибка] ${tour.title}: ${(e as Error).message}`);
        result.errors++;
      }
    }

    await new Promise(r => setTimeout(r, 2000));
  }

  return result;
}
