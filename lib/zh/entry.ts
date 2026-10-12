/**
 * Данные и форматы для китайского входа /zh (app/zh/page.tsx).
 *
 * Вынесено из страницы: Next разрешает page.tsx экспортировать только свои
 * поля (default, metadata, dynamic…), а функции формата нужны сторожу.
 * Витрина — тот же предикат и та же связка с партнёром, что у каталога и
 * sitemap; отказ базы — null и SQLSTATE в лог, страница называет его вслух
 * (§4.0), а не показывает пустой список.
 */

import { pool } from '@/lib/db-pool';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { logText } from '@/lib/log/log-text';

export interface ZhTourRow {
  id: string;
  slug: string | null;
  title: string;
  base_price: string | null;
  price_unit: string | null;
  duration_hours: string | null;
}

/** Единицы цены — те же три, что считает lib/tours/booking-total. */
export const PRICE_UNIT_ZH: Record<string, string> = {
  per_person: '每人',
  per_tour: '每团',
  per_day_per_person: '每人每天',
};

export const ZH_TOURS_LIMIT = 40;

export async function loadZhTours(): Promise<ZhTourRow[] | null> {
  try {
    const { rows } = await pool.query<ZhTourRow>(
      `SELECT ot.id::text AS id, ot.slug, ot.title, ot.base_price::text AS base_price, ot.price_unit,
              ot.duration_hours::text AS duration_hours
         FROM operator_tours ot
         JOIN partners p ON ot.operator_id = p.id
        WHERE ${publicTourSql('ot')}
        ORDER BY ot.updated_at DESC
        LIMIT ${ZH_TOURS_LIMIT}`,
    );
    return rows;
  } catch (err) {
    const code = (err as { code?: unknown })?.code;
    console.error('[zh] каталог не прочитан:', typeof code === 'string' ? `SQLSTATE=${logText(code, 10)}` : '', logText(err instanceof Error ? err.message : err, 200));
    return null;
  }
}

/** «105,000 卢布 每人»; нет цены или ноль — null, а не «0 卢布». */
export function priceZh(t: Pick<ZhTourRow, 'base_price' | 'price_unit'>): string | null {
  const n = Number(t.base_price);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `${n.toLocaleString('zh-CN')} 卢布 ${PRICE_UNIT_ZH[t.price_unit ?? ''] ?? PRICE_UNIT_ZH.per_person}`;
}

/** Часы до суток — часами, дальше — днями; нет длительности — null. */
export function durationZh(t: Pick<ZhTourRow, 'duration_hours'>): string | null {
  const h = Number(t.duration_hours);
  if (!Number.isFinite(h) || h <= 0) return null;
  return h >= 24 ? `约 ${Math.round(h / 24)} 天` : `约 ${Math.round(h)} 小时`;
}
