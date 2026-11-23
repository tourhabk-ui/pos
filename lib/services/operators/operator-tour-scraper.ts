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
 *
 * Существующий тур импорт своим запросом не правит (слово владельца 23.11:
 * «Автоматы (кроны описаний и фото, импортёры) пишут в туры только через
 * очередь проверки, своих обходных путей у них нет»). Цена, единица,
 * примечание к цене, описание и длительность уходят дверью правки под
 * именем импорта: у тура на сайте они ждут проверки администратора. Своим
 * запросом пишутся только служебные отметки импорта, которых турист не
 * видит. Новый тур заводится неопубликованным, как и раньше.
 */

import { pool } from '@/lib/db-pool';
import { transaction } from '@/lib/database';
import { proposeTourChange, readTourForAutomaton } from '@/lib/tours/tour-change';
import type { TourPatchInput } from '@/lib/tours/tour-write';
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

/** Чем кончилась запись тура из импорта — словами для журнала прогона. */
export type SavedTour =
  | 'inserted'
  /** Тура на сайте нет: правка записана в строку. */
  | 'updated'
  /** Тур на сайте: правка ждёт проверки администратора. */
  | 'staged'
  /** Содержание владелец уже отправил на проверку: импорт его не перебил. */
  | 'kept_owner'
  /** Содержание то же, что стоит: обновлены только отметки импорта. */
  | 'unchanged';

/**
 * Единица цены импорта → словарь сайта (`lib/tours/booking-total`): «за
 * человека» и «за тур». До 23.11 импорт писал в тур свои слова — `per_group`
 * и `unknown`, — а расчёт брони незнакомое значение читает как «за человека»:
 * цена за группу умножалась бы на число участников. «Не понял» — `null`:
 * единицу и цену импорт тогда не трогает вовсе.
 */
export function sitePriceUnit(unit: ScrapedTour['price_unit']): 'per_person' | 'per_tour' | null {
  if (unit === 'per_person') return 'per_person';
  if (unit === 'per_group') return 'per_tour';
  return null;
}

/**
 * Что импорт предлагает существующему туру. Пустое значение разбора — «на
 * сайте не найдено», а не «очистить»: такое поле не трогается. Цена
 * предлагается только вместе с понятой единицей: число без единицы — не цена.
 * Вид активности существующего тура импорт не переписывает: его выбирает
 * оператор в кабинете.
 */
export function importedContent(tour: ScrapedTour): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  const unit = sitePriceUnit(tour.price_unit);
  if (unit !== null && tour.price_from != null) {
    content.base_price = tour.price_from;
    content.price_unit = unit;
  }
  if (tour.price_note != null) content.price_note = tour.price_note;
  if (tour.description != null) content.description = tour.description;
  if (tour.duration_hours != null) content.duration_hours = tour.duration_hours;
  return content;
}

export async function saveTour(tour: ScrapedTour, operatorId: string): Promise<SavedTour> {
  const { rows } = await pool.query<{ id: number }>(
    `SELECT id FROM operator_tours WHERE operator_id = $1 AND title = $2 AND deleted_at IS NULL LIMIT 1`,
    [operatorId, tour.title],
  );

  if (rows.length > 0) {
    const tourId = String(rows[0].id);
    // Отметки импорта — не содержание: турист их не видит.
    await pool.query(
      `UPDATE operator_tours SET
         includes       = COALESCE($2, includes),
         source_url     = $3,
         parsed_at      = NOW(),
         is_stale       = FALSE,
         group_size_max = COALESCE($4, group_size_max)
       WHERE id = $1`,
      [rows[0].id, tour.includes, tour.source_url, tour.group_size_max],
    );
    // Содержание — дверью правки, под именем импорта.
    const content = importedContent(tour);
    if (Object.keys(content).length === 0) return 'unchanged';
    return transaction(async (client): Promise<SavedTour> => {
      const view = await readTourForAutomaton(client, tourId);
      if (!view) return 'unchanged';
      const change = await proposeTourChange(client, {
        tourId, source: 'operator-site-import', input: content as TourPatchInput, tour: view,
      });
      if (change.outcome === 'pending') return 'staged';
      if (change.outcome === 'written') return 'updated';
      if (change.outcome === 'kept_owner') return 'kept_owner';
      return 'unchanged';
    });
  }

  const { rows: inserted } = await pool.query<{ id: number }>(
    `INSERT INTO operator_tours (
       operator_id, title, activity_type, description, duration_hours,
       base_price, price_unit, group_size_max, price_note, includes,
       source_url, parsed_at, is_stale,
       max_participants, currency
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),FALSE,COALESCE($8,10),'RUB')
     RETURNING id`,
    // Единица — словарём сайта; «не понял» остаётся «unknown», а не «за человека».
    [operatorId, tour.title, tour.category, tour.description, tour.duration_hours,
     tour.price_from, sitePriceUnit(tour.price_unit) ?? 'unknown', tour.group_size_max, tour.price_note, tour.includes,
     tour.source_url],
  );

  const tourId = inserted[0].id;

  let failedDates = 0;
  let lastDateError: string | null = null;

  if (tour.departures?.length) {
    for (const dep of tour.departures) {
      if (!dep.date_from) continue;
      try {
        // operator_tour_id, а НЕ tour_id: колонку tour_id объявляла призрачная
        // копия таблицы в lib/database/schema.sql, которую деплой не применяет.
        // Уникальный ключ у настоящей таблицы тоже по (operator_tour_id, date)
        // — со старым именем ON CONFLICT не находил арбитра и падал вместе со
        // всей вставкой (issue #1331).
        await pool.query(
          // Колонок tour_id и is_available в tour_availability НЕТ: таблицу
          // создаёт миграция 040 (operator_tour_id, booked_slots). Обе
          // выдумки жили здесь, потому что их объявляла призрачная копия
          // таблицы в lib/database/schema.sql, которую деплой не применяет.
          `INSERT INTO tour_availability (operator_tour_id, date, available_slots, booked_slots)
           VALUES ($1, $2::date, COALESCE($3, 10), 0)
           ON CONFLICT (operator_tour_id, date) DO UPDATE SET
             available_slots = COALESCE(EXCLUDED.available_slots, tour_availability.available_slots),
             is_cancelled    = FALSE`,
          [tourId, dep.date_from, dep.seats_left],
        );
      } catch (err) {
        // Не «skip bad dates»: пустой catch и держал эту вставку мёртвой.
        // Каждый заезд падал на «column does not exist», а наружу это
        // выглядело как «оператор не публикует дат». Дата бывает и правда
        // кривой — но тогда это видно в логе, а не выдаётся за отсутствие
        // заездов (§4.0). Пишем и построчный SQLSTATE, и итог по прогону:
        // первый говорит ЧТО упало, второй — сколько именно потеряно.
        const code = (err as { code?: string } | null)?.code ?? 'unknown';
        console.error(
          `[scraper] заезд не записан: тур ${tourId}, дата ${dep.date_from}, SQLSTATE ${code}`,
        );
        failedDates++;
        if (lastDateError === null) {
          lastDateError = err instanceof Error ? err.message : String(err);
        }
      }
    }
  }

  // Даты, не легшие в базу, — это отсутствующие даты у живого тура: человек
  // увидит «мест нет» там, где они есть. Отказ называется вслух.
  if (failedDates > 0) {
    console.error(
      `[operator-tour-scraper] даты не записаны: ${failedDates} из ${tour.departures?.length ?? 0}` +
      (lastDateError !== null ? ` · ${lastDateError}` : ''),
    );
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
