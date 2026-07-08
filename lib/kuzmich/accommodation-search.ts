/**
 * lib/kuzmich/accommodation-search.ts
 *
 * Реализация инструмента Кузьмича search_accommodations. Вынесена в отдельный
 * модуль (как guardian-context / taaft-search) — executeTool подгружает её
 * лениво, а юнит-тест зовёт напрямую. Прямой параметризованный SELECT из
 * accommodations (master витрины жилья), только is_active.
 */

import { pool } from '@/lib/db-pool';

export interface AccommodationSearchArgs {
  zone?: string;
  type?: string;
  price_max?: string;
}

interface AccommodationRow {
  id: string;
  name: string;
  type: string | null;
  address: string | null;
  location_zone: string | null;
  price_per_night_from: string | null;
  rating: string | null;
}

function appBase(): string {
  return (process.env.NEXT_PUBLIC_APP_URL?.includes('twc1.net')
    ? (process.env.NEXT_PUBLIC_SITE_URL || 'https://tourhab.ru')
    : process.env.NEXT_PUBLIC_APP_URL) ?? 'https://tourhab.ru';
}

export async function searchAccommodationsForKuzmich(args: AccommodationSearchArgs): Promise<string> {
  const conds: string[] = ['is_active = true'];
  const params: unknown[] = [];

  if (args.zone) { params.push(`%${args.zone}%`); conds.push(`location_zone ILIKE $${params.length}`); }
  if (args.type) { params.push(`%${args.type}%`); conds.push(`type ILIKE $${params.length}`); }
  const priceMax = Number(args.price_max);
  if (args.price_max && Number.isFinite(priceMax) && priceMax > 0) {
    params.push(priceMax);
    conds.push(`price_per_night_from <= $${params.length}`);
  }

  const { rows } = await pool.query<AccommodationRow>(
    `SELECT id, name, type, address, location_zone, price_per_night_from, rating
     FROM accommodations
     WHERE ${conds.join(' AND ')}
     ORDER BY rating DESC NULLS LAST
     LIMIT 6`,
    params,
  );

  if (rows.length === 0) return 'Жильё по заданным условиям не найдено.';

  const base = appBase();
  return rows.map(a => {
    const price = a.price_per_night_from
      ? `от ${Math.round(Number(a.price_per_night_from))} руб/ночь`
      : 'цена по запросу';
    const where = [a.location_zone, a.address].filter(Boolean).join(', ');
    return `${a.name}${a.type ? ` [${a.type}]` : ''} — ${price}${where ? `. ${where}` : ''}. ${base}/accommodations/${a.id}`;
  }).join('\n\n');
}
