/**
 * Туры для посадочных страниц (lib/seo/query-landings) — из базы на запросе.
 *
 * Витрина — тот же предикат, что каталог, /zh и sitemap (publicTourSql).
 * Порядок — то же единственное правило, что у /zh: компания, затем тур
 * (orderZhTours), без поднятий (CLAUDE.md §0). Ближайшая открытая дата —
 * то же условие, что has_availability каталога (hasAvailabilitySql), только
 * MIN(date). Отказ базы — null и SQLSTATE в лог: страница говорит
 * «не загрузилось», а не показывает пустой список (§4.0).
 */
import { pool } from '@/lib/db-pool';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { occupiedOnDaySql } from '@/lib/bookings/occupancy';
import { logText } from '@/lib/log/log-text';
import { orderZhTours, withZhTitles, type ZhTourRow } from '@/lib/zh/entry';
import type { LandingTopic } from '@/lib/seo/query-landings';

export interface LandingTourRow extends ZhTourRow {
  season_start: string | null;
  season_end: string | null;
  /** Ближайшая дата со свободными местами, 'YYYY-MM-DD'; нет — null (по запросу). */
  next_open_date: string | null;
  activity_type?: string | null;
  location_name?: string | null;
}

const BEAR_TYPES = new Set(['bears', 'bear_watching']);
// Существительное «медведь» во всех падежах, словом целиком: «Медвежья чаша»
// (маар у озера Толмачёва) — прилагательное, медвежий тур оно не делает.
const BEAR_WORD = /(^|[^а-яё])медвед(ь|я|ю|ем|е|и|ей|ям|ями|ях)(?![а-яё])/i;
// Курильское озеро — место наблюдения медведей; тур туда (ID67, вертолёт) — медвежий.
const BEAR_PLACE = /(^|[^а-яё])курильск(ое|ого|ому|им|ом)\s+озер/i;
// «вулкан» как существительное; «вулканический песок» (ID53) — не вулканический тур.
const VOLCANO_WORD = /(^|[^а-яё])вулкан(а|у|ом|е|ы|ов|ам|ами|ах)?(?![а-яё])/i;
// Главная цель — именованный вулкан (ID61 Горелый, ID62 Авачинский перевал).
const VOLCANO_NAME = /(^|[^а-яё])(авачинск|корякск|горел|мутновск|толбачик|ключевск|ксудач|вилючинск|карымск|шивелуч|безымянн)[а-яё]*/i;

export interface TopicInput { activity_type: string | null; title: string; location_name: string | null }

/**
 * Попадает ли тур в тему. Сначала тип активности; запасной путь — слово целиком
 * в названии и месте назначения (не в описании: там «видели медведя» и
 * «вулканический песок» встречаются у чего угодно).
 */
export function matchesTopicText(text: string, topic: Exclude<LandingTopic, 'all'>): boolean {
  return topic === 'bears' ? BEAR_WORD.test(text) || BEAR_PLACE.test(text) : VOLCANO_WORD.test(text) || VOLCANO_NAME.test(text);
}

export function matchesTopic(t: TopicInput, topic: LandingTopic): boolean {
  const text = `${t.title} ${t.location_name ?? ''}`;
  switch (topic) {
    case 'all': return true;
    case 'bears': return BEAR_TYPES.has(t.activity_type ?? '') || matchesTopicText(text, 'bears');
    case 'volcano': return t.activity_type === 'volcano' || matchesTopicText(text, 'volcano');
    default: throw new Error(`matchesTopic: неизвестная тема ${String(topic)}`);
  }
}

export function landingToursSql(): string {
  return `SELECT ot.id::text AS id, ot.slug, ot.title, ot.base_price::text AS base_price, ot.price_unit,
              ot.duration_hours::text AS duration_hours,
              ot.season_start::text AS season_start, ot.activity_type, ot.location_name, ot.season_end::text AS season_end,
              p.name AS operator_name, p.slug AS operator_slug, p.is_public AS operator_public,
              (SELECT MIN(ta.date)::text FROM tour_availability ta
                WHERE ta.operator_tour_id = ot.id
                  AND ta.date >= CURRENT_DATE
                  AND ta.deleted_at IS NULL
                  AND ta.is_cancelled = false
                  AND ta.available_slots > (${occupiedOnDaySql({ booking: 'ob2', day: 'ta.date', tourId: 'ot.id' })})
              ) AS next_open_date
         FROM operator_tours ot
         JOIN partners p ON ot.operator_id = p.id
        WHERE ${publicTourSql('ot')}`;
}

export async function loadLandingTours(topic: LandingTopic, withZh: boolean): Promise<LandingTourRow[] | null> {
  try {
    const { rows } = await pool.query<LandingTourRow>(landingToursSql());
    const picked = rows.filter((r) => matchesTopic({ activity_type: r.activity_type ?? null, title: r.title, location_name: r.location_name ?? null }, topic));
    return orderZhTours(withZh ? await withZhTitles(picked) : picked);
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    console.error('[query-landing] туры не прочитаны:', topic, typeof code === 'string' ? `SQLSTATE=${logText(code, 10)}` : '', logText(err instanceof Error ? err.message : err, 200));
    return null;
  }
}
