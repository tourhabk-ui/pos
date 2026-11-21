/**
 * Туры блока посадочной (lib/landings/landings) — из базы на запросе.
 * Витрина — тот же предикат, что каталог (publicTourSql), порядок — правило 1в
 * (lib/tours/offer-order). Отказ базы — null и причина в лог: страница
 * говорит «не загрузилось», а не показывает пустой список (§4.0).
 */
import { TOLBACHIK_DIFFICULTY_NOTE } from '@/lib/seo/query-landings';
import { cache } from 'react';
import { pool } from '@/lib/db-pool';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { nearestFreeDateSql } from '@/lib/tours/nearest-free-date';
import { anyDayOpenSql } from '@/lib/tours/schedule-kind';
import { orderOffersBy } from '@/lib/tours/offer-order';
import { logText } from '@/lib/log/log-text';
import { matchesTopic, type LandingTourRow } from '@/lib/seo/query-landings-data';
import type { Landing, LandingTourSpec } from '@/lib/landings/landings';

export interface LandingBlockTour extends LandingTourRow {
  difficulty?: string | null;
}

/** Сколько туров показывает блок. */
export const LANDING_TOURS_MAX = 8;

function monthOf(v: string | null | undefined): number | null {
  const m = v ? /^\d{4}-(\d{2})-\d{2}/.exec(v) : null;
  const n = m ? Number(m[1]) : NaN;
  return n >= 1 && n <= 12 ? n : null;
}

/**
 * Возможен ли выезд тура в месяце `month`: открытая дата в этом месяце или
 * месяц внутри сезона оператора (season_start…season_end, через Новый год —
 * тоже). Сезона и даты нет — не знаем, и тур в месячный блок не идёт.
 */
export function tourRunsInMonth(t: Pick<LandingTourRow, 'season_start' | 'season_end' | 'next_open_date'>, month: number): boolean {
  if (monthOf(t.next_open_date) === month) return true;
  const a = monthOf(t.season_start); const b = monthOf(t.season_end);
  if (a === null || b === null) return false;
  const span = Date.parse(`${t.season_end!.slice(0, 10)}T00:00:00Z`) - Date.parse(`${t.season_start!.slice(0, 10)}T00:00:00Z`);
  if (Number.isFinite(span) && span >= 365 * 86_400_000) return true;
  return a <= b ? month >= a && month <= b : month >= a || month <= b;
}

export function tourMatchesSpec(t: LandingBlockTour, spec: LandingTourSpec): boolean {
  switch (spec.kind) {
    case 'none': return false;
    case 'all': return true;
    case 'month': return tourRunsInMonth(t, spec.month);
    case 'topic': return matchesTopic({ activity_type: t.activity_type ?? null, title: t.title, location_name: t.location_name ?? null }, spec.topic);
    case 'text': return spec.pattern.test(`${t.title} ${t.location_name ?? ''}`);
    case 'easy': {
      const h = Number(t.duration_hours);
      return t.difficulty === 'easy' && Number.isFinite(h) && h > 0 && h <= 24;
    }
  }
}

const SQL = `SELECT ot.id::text AS id, ot.slug, ot.title, ot.base_price::text AS base_price, ot.price_unit,
            ot.duration_hours::text AS duration_hours, ot.difficulty,
            ot.season_start::text AS season_start, ot.season_end::text AS season_end,
            ot.activity_type, ot.location_name,
            p.name AS operator_name, p.slug AS operator_slug, p.is_public AS operator_public,
            ${nearestFreeDateSql('ot')} AS next_open_date, ${anyDayOpenSql('ot')} AS any_day_open
       FROM operator_tours ot
       JOIN partners p ON ot.operator_id = p.id
      WHERE ${publicTourSql('ot')}`;

/**
 * Все опубликованные туры — один запрос на страницу (cache), без кэша между
 * запросами: свободные места и даты меняются, их нельзя показывать вчерашними
 * (Сыщик 21.11). null — база не ответила.
 */
export const loadPublicTours = cache(async (): Promise<LandingBlockTour[] | null> => {
  try {
    const { rows } = await pool.query<LandingBlockTour>(SQL);
    return rows;
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    console.error('[landing] туры не прочитаны:', typeof code === 'string' ? `SQLSTATE=${logText(code, 10)}` : '', logText(err instanceof Error ? err.message : err, 200));
    return null;
  }
});

/** Туры блока; null — база не ответила; [] — подходящих туров нет. Один раз на запрос. */
export const loadLandingTours = cache(async (slug: string, spec: LandingTourSpec): Promise<LandingBlockTour[] | null> => {
  if (spec.kind === 'none') return [];
  try {
    const rows = await loadPublicTours();
    if (rows === null) throw new Error('туры не прочитаны');
    const picked = rows.filter((r) => tourMatchesSpec(r, spec));
    return orderOffersBy(picked, (r) => ({ id: r.id, nearestFreeDate: r.next_open_date ?? null, anyDayOpen: r.any_day_open ?? null })).slice(0, LANDING_TOURS_MAX);
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    console.error('[landing] туры не прочитаны:', slug, typeof code === 'string' ? `SQLSTATE=${logText(code, 10)}` : '', logText(err instanceof Error ? err.message : err, 200));
    return null;
  }
});

export function loadToursFor(l: Landing): Promise<LandingBlockTour[] | null> {
  return loadLandingTours(l.slug, l.tours);
}

/** Подпись блока: что в нём, словами из полей базы. */
export function tourBlockHeading(spec: LandingTourSpec): string {
  switch (spec.kind) {
    case 'month': return `Туры на Ведаре с выездом в ${['январе', 'феврале', 'марте', 'апреле', 'мае', 'июне', 'июле', 'августе', 'сентябре', 'октябре', 'ноябре', 'декабре'][spec.month - 1]}`;
    case 'easy': return 'Лёгкие туры до суток';
    default: return 'Туры на Ведаре';
  }
}

export function tourBlockNote(spec: LandingTourSpec): string {
  // Толбачик: «Лёгкий» и «Сложный» у одного направления — разные программы (Сыщик 21.11).
  if (spec.kind === 'topic' && spec.topic === 'tolbachik') {
    return `${TOLBACHIK_DIFFICULTY_NOTE} Цена и даты — из карточки тура, без добавленного «от»; итог называет оператор.`;
  }
  switch (spec.kind) {
    case 'month': return 'Месяц — по сезону, который указал оператор, или по открытой дате выезда. Цена и даты — из карточки тура, без добавленного «от»; итог называет оператор.';
    case 'easy': return 'Признака «для детей» у туров на Ведаре нет. Здесь туры, которым оператор поставил сложность «лёгкая» и длительность до суток; про возраст спросите оператора в заявке.';
    default: return 'Цена и даты — из карточки тура, без добавленного «от»; итог называет оператор.';
  }
}
