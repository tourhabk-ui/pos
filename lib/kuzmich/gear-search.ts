/**
 * lib/kuzmich/gear-search.ts
 *
 * Инструмент Кузьмича search_gear — поиск проката снаряжения. Вынесен в модуль
 * (как accommodation-search / guardian-context): executeTool подгружает лениво,
 * юнит-тест зовёт напрямую. Прямой параметризованный SELECT из gear_items,
 * только is_active. Публичной страницы товара нет — ссылка на витрину /gear.
 */

import { pool } from '@/lib/db-pool';

export interface GearSearchArgs {
  query?: string;      // название/бренд/категория
  category?: string;
  price_max?: string;  // максимум за сутки, руб
}

interface GearRow {
  id: string;
  name: string;
  category: string | null;
  brand: string | null;
  price_per_day: string | null;
  rating: string | null;
}

function appBase(): string {
  return (process.env.NEXT_PUBLIC_APP_URL?.includes('twc1.net')
    ? (process.env.NEXT_PUBLIC_SITE_URL || 'https://vedarai.ru')
    : process.env.NEXT_PUBLIC_APP_URL) ?? 'https://vedarai.ru';
}

export async function searchGearForKuzmich(args: GearSearchArgs): Promise<string> {
  const conds: string[] = ['is_active = true'];
  const params: unknown[] = [];

  if (args.query) {
    params.push(`%${args.query}%`);
    const p = `$${params.length}`;
    conds.push(`(name ILIKE ${p} OR brand ILIKE ${p} OR category ILIKE ${p})`);
  }
  if (args.category) { params.push(`%${args.category}%`); conds.push(`category ILIKE $${params.length}`); }
  const priceMax = Number(args.price_max);
  if (args.price_max && Number.isFinite(priceMax) && priceMax > 0) {
    params.push(priceMax);
    conds.push(`price_per_day <= $${params.length}`);
  }

  const { rows } = await pool.query<GearRow>(
    `SELECT id, name, category, brand, price_per_day, rating
     FROM gear_items
     WHERE ${conds.join(' AND ')}
     ORDER BY rating DESC NULLS LAST, rental_count DESC NULLS LAST
     LIMIT 6`,
    params,
  );

  if (rows.length === 0) return 'Снаряжение по заданным условиям не найдено.';

  const base = appBase();
  return rows.map(g => {
    const price = g.price_per_day
      ? `от ${Math.round(Number(g.price_per_day))} руб/сутки`
      : 'цена по запросу';
    const meta = [g.brand, g.category].filter(Boolean).join(', ');
    return `${g.name}${meta ? ` (${meta})` : ''} — ${price}. ${base}/gear`;
  }).join('\n\n');
}
