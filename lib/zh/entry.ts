/**
 * Данные и форматы для китайского входа /zh (app/zh/page.tsx).
 *
 * Вынесено из страницы: Next разрешает page.tsx экспортировать только свои
 * поля (default, metadata, dynamic…), а функции формата нужны сторожу.
 * Витрина — тот же предикат и та же связка с партнёром, что у каталога и
 * sitemap; отказ базы — null и SQLSTATE в лог, страница называет его вслух
 * (§4.0), а не показывает пустой список.
 *
 * Аудит 15.10 (CN-quick), §0: /zh — общая витрина, и порядок у неё один для
 * всех и назван на странице (ZH_TOURS_ORDER_NOTE): по названию компании, внутри
 * — по названию тура. Прежний ORDER BY updated_at DESC тайно поднимал того,
 * кто чаще правит тур. Среза больше нет: заголовок «当前团队游（N）» писал число
 * показанных как общее, и с 41-го тура молча соврал бы.
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
  /** Вывеска оператора (partners.name) — ключ порядка, показывается рядом с туром. */
  operator_name: string;
  operator_slug: string | null;
  operator_public: boolean | null;
}

/** Единицы цены — те же три, что считает lib/tours/booking-total. */
export const PRICE_UNIT_ZH: Record<string, string> = {
  per_person: '每人',
  per_tour: '每团',
  per_day_per_person: '每人每天',
};

const RU = new Intl.Collator('ru', { sensitivity: 'base', numeric: true });

/**
 * Единственное правило порядка /zh: название компании, затем название тура,
 * затем id — чтобы равные имена не прыгали между запросами. Ни дата правки,
 * ни цена, ни закрепление в порядок не входят. Новый массив, вход не меняется.
 */
export function orderZhTours<T extends Pick<ZhTourRow, 'id' | 'title' | 'operator_name'>>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) =>
    RU.compare(a.operator_name.trim(), b.operator_name.trim())
    || RU.compare(a.title.trim(), b.title.trim())
    || RU.compare(a.id, b.id));
}

export async function loadZhTours(): Promise<ZhTourRow[] | null> {
  try {
    const { rows } = await pool.query<ZhTourRow>(
      `SELECT ot.id::text AS id, ot.slug, ot.title, ot.base_price::text AS base_price, ot.price_unit,
              ot.duration_hours::text AS duration_hours,
              p.name AS operator_name, p.slug AS operator_slug, p.is_public AS operator_public
         FROM operator_tours ot
         JOIN partners p ON ot.operator_id = p.id
        WHERE ${publicTourSql('ot')}`,
    );
    return orderZhTours(rows);
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
