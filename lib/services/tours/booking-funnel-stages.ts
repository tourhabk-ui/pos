/**
 * lib/services/booking-funnel-stages.ts
 *
 * Диагностика простоя воронки броней (issue #273). Health-метрика
 * 'Алерт о простое воронки' показывает лишь факт нуля броней, но не ГДЕ
 * теряются брони. Этот срез разбивает operator_bookings по стадиям
 * (booking_status) за окно дней и добавляет предложение (сколько туров
 * опубликовано, у скольких операторов), чтобы отличить 'нет спроса' от
 * 'нет предложения'.
 *
 * ВАЖНО: колонка стадии — `booking_status` (не устаревшая `status`),
 * таблица — `operator_bookings` (см. CLAUDE.md §4). Связь с оператором —
 * через operator_tour_id -> operator_tours.operator_id (прямого operator_id
 * в operator_bookings нет).
 */

import { pool } from '@/lib/db-pool';

export interface BookingFunnelStages {
  /** Окно анализа в днях. */
  days: number;
  /** Счётчики броней по стадии: ключ = значение booking_status. */
  byStatus: Record<string, number>;
  /** Всего броней за окно (сумма byStatus). */
  totalBookings: number;
  /** Опубликованных туров сейчас (is_published AND is_active). */
  publishedTours: number;
  /** Операторов с хотя бы одним опубликованным туром сейчас. */
  operatorsWithPublishedTours: number;
  /** Туров, получивших хотя бы одну бронь за окно. */
  toursWithBookings: number;
  /** Операторов, получивших хотя бы одну бронь за окно. */
  operatorsWithBookings: number;
}

interface StatusRow {
  booking_status: string;
  cnt: number;
}

interface SupplyRow {
  published_tours: number;
  operators_with_published_tours: number;
}

interface DemandRow {
  tours_with_bookings: number;
  operators_with_bookings: number;
}

/**
 * Срез стадий воронки броней за последние `days` дней.
 *
 * @param days Ширина окна в днях (> 0). Значения <= 0 приводятся к 1.
 */
export async function getBookingFunnelStages(days: number): Promise<BookingFunnelStages> {
  const windowDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : 1;

  // Стадии броней за окно — группировка строго по booking_status.
  const statusPromise = pool.query<StatusRow>(
    `SELECT booking_status, COUNT(*)::int AS cnt
       FROM operator_bookings
      WHERE created_at > NOW() - make_interval(days => $1)
      GROUP BY booking_status`,
    [windowDays],
  );

  // Предложение: сколько туров опубликовано и у скольких операторов.
  const supplyPromise = pool.query<SupplyRow>(
    `SELECT COUNT(*)::int AS published_tours,
            COUNT(DISTINCT operator_id)::int AS operators_with_published_tours
       FROM operator_tours
      WHERE is_published = TRUE AND is_active = TRUE`,
  );

  // Спрос: сколько туров и операторов получили хотя бы одну бронь за окно.
  const demandPromise = pool.query<DemandRow>(
    `SELECT COUNT(DISTINCT ob.operator_tour_id)::int AS tours_with_bookings,
            COUNT(DISTINCT ot.operator_id)::int AS operators_with_bookings
       FROM operator_bookings ob
       JOIN operator_tours ot ON ot.id = ob.operator_tour_id
      WHERE ob.created_at > NOW() - make_interval(days => $1)`,
    [windowDays],
  );

  const [statusRes, supplyRes, demandRes] = await Promise.all([
    statusPromise,
    supplyPromise,
    demandPromise,
  ]);

  const byStatus: Record<string, number> = {};
  let totalBookings = 0;
  for (const row of statusRes.rows) {
    byStatus[row.booking_status] = row.cnt;
    totalBookings += row.cnt;
  }

  const supply = supplyRes.rows[0];
  const demand = demandRes.rows[0];

  return {
    days: windowDays,
    byStatus,
    totalBookings,
    publishedTours: supply?.published_tours ?? 0,
    operatorsWithPublishedTours: supply?.operators_with_published_tours ?? 0,
    toursWithBookings: demand?.tours_with_bookings ?? 0,
    operatorsWithBookings: demand?.operators_with_bookings ?? 0,
  };
}
