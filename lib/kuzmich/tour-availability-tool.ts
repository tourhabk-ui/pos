/**
 * get_tour_availability — свободные даты и места конкретного тура.
 *
 * Один мозг — два протокола: инструмент живёт в реестре Кузьмича и через него
 * же отдаётся публичному MCP (Эволюция 3.0, п.4 — MCP-бронирование, владелец
 * 08.08: «делай»). Занятость — ТОЛЬКО из fetchAvailabilityForTour (движок
 * планера, реальные брони) — тот же расчёт, что у гейта брони и share-API
 * плана. Свой SQL по tour_availability здесь запрещён: разойдётся с гейтом,
 * и агент пообещает места, по которым бронь отклонят.
 */

import { pool } from '@/lib/db-pool';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { createPlannerCache, fetchAvailabilityForTour } from '@/lib/planner';
import { priceFromUnit } from '@/lib/tours/price-label';
import { containsPattern } from '@/lib/db/like';
import { kamchatkaToday } from '@/lib/seat-requests/core';

export interface ResolvedTour {
  id: number;
  title: string;
  base_price: number | null;
  /** За что назначена цена; null — не записано. */
  price_unit: string | null;
}

/**
 * Тур по названию/ключевому слову или числовому ID — тот же паттерн, что у
 * get_tour_details. Только тур на витрине (publicTourSql): черновик
 * оператора (is_published = false) через MCP не находился бы ни картой, ни
 * заявкой на бронь — до 29.09 резолвер смотрел лишь is_active и deleted_at.
 * null — такого тура нет; отказ базы — исключение (с
 * логом): до 29.09 он тоже был null, и внешний агент получал ложный факт
 * «тур не найден среди активных» на месте «не смог проверить» (§4.0).
 */
export async function resolveTourByQuery(query: string): Promise<ResolvedTour | null> {
  const q = query.trim();
  if (!q) return null;
  try {
    if (/^\d+$/.test(q)) {
      const { rows } = await pool.query<ResolvedTour>(
        `SELECT id, title, base_price, price_unit FROM operator_tours
          WHERE id = $1 AND ${publicTourSql('')}`,
        [Number(q)],
      );
      if (rows[0]) return rows[0];
    }
    const { rows } = await pool.query<ResolvedTour>(
      `SELECT id, title, base_price, price_unit FROM operator_tours
        WHERE ${publicTourSql('')}
          AND (title ILIKE $1 OR short_description ILIKE $1 OR activity_type ILIKE $1 OR location_name ILIKE $1)
        ORDER BY (CASE WHEN title ILIKE $1 THEN 0 ELSE 1 END), base_price ASC NULLS LAST
        LIMIT 1`,
      [containsPattern(q)],
    );
    return rows[0] ?? null;
  } catch (err) {
    const e = err as { code?: string; message?: string };
    console.error('[tour-availability] тур не прочитан', { sqlstate: e?.code, message: e?.message });
    throw err;
  }
}

function shortDate(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${d}.${m}`;
}

export async function getTourAvailabilityForKuzmich(args: { tour?: string; date_from?: string; days?: string }): Promise<string> {
  const tourQuery = (args.tour ?? '').trim();
  if (!tourQuery) return 'Укажи тур: название, ключевое слово или ID.';

  const tour = await resolveTourByQuery(tourQuery);
  if (!tour) {
    return `Тур по запросу "${tourQuery}" не найден среди активных. Не выдумывай даты — предложи выбрать тур через get_tours.`;
  }

  // «Сегодня» — по Камчатке: даты туров местные. По UTC с 12:00 до 24:00
  // сегодняшнее число на Камчатке уже следующее, и инструмент предлагал
  // вчерашний день как свободный (проба MCP 29.09, 22:05 UTC — «29.09
  // свободно 12» при 30.09 на Камчатке).
  const today = kamchatkaToday();
  const pastFrom = /^\d{4}-\d{2}-\d{2}$/.test(args.date_from ?? '') && (args.date_from as string) < today;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(args.date_from ?? '') && (args.date_from as string) >= today
    ? (args.date_from as string)
    : today;
  const daysRaw = Number(args.days);
  const days = Number.isFinite(daysRaw) ? Math.min(Math.max(Math.trunc(daysRaw), 1), 31) : 14;
  // Поправки запроса называются, а не делаются молча: агент должен знать,
  // что смотрели не то окно, которое он просил.
  const notes = [
    pastFrom ? `Дата ${args.date_from} уже прошла — показываю с сегодняшнего дня по Камчатке.` : '',
    Number.isFinite(daysRaw) && Math.trunc(daysRaw) > 31 ? 'Окно больше 31 дня не смотрю — показываю 31.' : '',
  ].filter(Boolean);
  const to = new Date(Date.parse(from) + (days - 1) * 86400000).toISOString().slice(0, 10);

  try {
    const slots = await fetchAvailabilityForTour(String(tour.id), from, to, createPlannerCache());
    if (slots.length === 0) {
      return `Тур "${tour.title}" (ID${tour.id}): свободных мест с ${shortDate(from)} по ${shortDate(to)} нет. ` +
        'Это реальная занятость из броней — не обещай места на эти даты. Можно проверить другое окно (date_from/days) или другой тур.';
    }
    const SHOWN = 12;
    const lines = slots.slice(0, SHOWN).map((s) => {
      // Единица — из тура, а не «р/чел»: у многодневок цена за группу, и
      // агент, прочитавший «140 000 р/чел», называл цену с человека (29.09).
      // Цена на дату может быть переопределена, но единица у неё та же.
      const price = priceFromUnit(s.priceOverride ?? tour.base_price, tour.price_unit);
      return `- ${shortDate(s.date)} (${s.date}): свободно ${s.remaining}${price ? `, ${price}` : ''}`;
    });
    const more = slots.length > SHOWN
      ? [`…и ещё ${slots.length - SHOWN} дат с местами до ${shortDate(to)} — чтобы увидеть их, сдвиньте date_from.`]
      : [];
    return [
      ...notes,
      `Тур "${tour.title}" (ID${tour.id}) — свободные даты (реальная занятость из броней):`,
      ...lines,
      ...more,
      `Бронь на странице: /catalog/tours/${tour.id}?date=<дата>. Данные на ${shortDate(today)} (по Камчатке).`,
    ].join('\n');
  } catch (err) {
    const e = err as { code?: string; message?: string };
    console.error('[tour-availability] занятость не прочитана', { tourId: tour.id, sqlstate: e?.code, message: e?.message });
    return 'Занятость временно недоступна — не называй даты по памяти, предложи страницу тура.';
  }
}
