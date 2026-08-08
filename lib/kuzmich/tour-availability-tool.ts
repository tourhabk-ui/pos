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
import { createPlannerCache, fetchAvailabilityForTour } from '@/lib/planner';

export interface ResolvedTour {
  id: number;
  title: string;
  base_price: number | null;
}

/** Тур по названию/ключевому слову или числовому ID — тот же паттерн, что у get_tour_details. */
export async function resolveTourByQuery(query: string): Promise<ResolvedTour | null> {
  const q = query.trim();
  if (!q) return null;
  try {
    if (/^\d+$/.test(q)) {
      const { rows } = await pool.query<ResolvedTour>(
        `SELECT id, title, base_price FROM operator_tours
          WHERE id = $1 AND is_active = true AND deleted_at IS NULL`,
        [Number(q)],
      );
      if (rows[0]) return rows[0];
    }
    const { rows } = await pool.query<ResolvedTour>(
      `SELECT id, title, base_price FROM operator_tours
        WHERE is_active = true AND deleted_at IS NULL
          AND (title ILIKE $1 OR short_description ILIKE $1 OR activity_type ILIKE $1 OR location_name ILIKE $1)
        ORDER BY (CASE WHEN title ILIKE $1 THEN 0 ELSE 1 END), base_price ASC NULLS LAST
        LIMIT 1`,
      [`%${q}%`],
    );
    return rows[0] ?? null;
  } catch {
    return null;
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

  const today = new Date().toISOString().slice(0, 10);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(args.date_from ?? '') && (args.date_from as string) >= today
    ? (args.date_from as string)
    : today;
  const daysRaw = Number(args.days);
  const days = Number.isFinite(daysRaw) ? Math.min(Math.max(Math.trunc(daysRaw), 1), 31) : 14;
  const to = new Date(Date.parse(from) + (days - 1) * 86400000).toISOString().slice(0, 10);

  try {
    const slots = await fetchAvailabilityForTour(String(tour.id), from, to, createPlannerCache());
    if (slots.length === 0) {
      return `Тур "${tour.title}" (ID${tour.id}): свободных мест с ${shortDate(from)} по ${shortDate(to)} нет. ` +
        'Это реальная занятость из броней — не обещай места на эти даты. Можно проверить другое окно (date_from/days) или другой тур.';
    }
    const lines = slots.slice(0, 12).map((s) => {
      const price = s.priceOverride ?? tour.base_price;
      return `- ${shortDate(s.date)} (${s.date}): свободно ${s.remaining}${price != null ? `, от ${Number(price).toLocaleString('ru-RU')} р/чел` : ''}`;
    });
    return [
      `Тур "${tour.title}" (ID${tour.id}) — свободные даты (реальная занятость из броней):`,
      ...lines,
      `Бронь на странице: /catalog/tours/${tour.id}?date=<дата>. Данные на ${shortDate(today)}.`,
    ].join('\n');
  } catch {
    return 'Занятость временно недоступна — не называй даты по памяти, предложи страницу тура.';
  }
}
