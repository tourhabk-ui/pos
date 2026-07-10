/**
 * lib/kuzmich/transfer-search.ts
 *
 * Инструмент Кузьмича search_transfers — поиск трансферов (маршруты «откуда→куда»
 * с ценами). Вынесен в модуль (как accommodation-search / gear-search):
 * executeTool подгружает лениво, юнит-тест зовёт напрямую. Прямой
 * параметризованный SELECT из transfer_routes, только is_active.
 * Доступность на конкретную дату — на витрине /transfers.
 */

import { pool } from '@/lib/db-pool';

export interface TransferSearchArgs {
  from?: string;   // откуда (например: аэропорт, Петропавловск)
  to?: string;     // куда (например: Паратунка, Эссо)
  price_max?: string;
}

interface TransferRouteRow {
  id: string;
  name: string | null;
  from_location: string;
  to_location: string;
  distance_km: string | null;
  duration_minutes: number | null;
  base_price: string | null;
}

function appBase(): string {
  return (process.env.NEXT_PUBLIC_APP_URL?.includes('twc1.net')
    ? (process.env.NEXT_PUBLIC_SITE_URL || 'https://tourhab.ru')
    : process.env.NEXT_PUBLIC_APP_URL) ?? 'https://tourhab.ru';
}

export async function searchTransfersForKuzmich(args: TransferSearchArgs): Promise<string> {
  const conds: string[] = ['is_active = true'];
  const params: unknown[] = [];

  if (args.from) { params.push(`%${args.from}%`); conds.push(`from_location ILIKE $${params.length}`); }
  if (args.to) { params.push(`%${args.to}%`); conds.push(`to_location ILIKE $${params.length}`); }
  const priceMax = Number(args.price_max);
  if (args.price_max && Number.isFinite(priceMax) && priceMax > 0) {
    params.push(priceMax);
    conds.push(`base_price <= $${params.length}`);
  }

  const { rows } = await pool.query<TransferRouteRow>(
    `SELECT id, name, from_location, to_location, distance_km, duration_minutes, base_price
     FROM transfer_routes
     WHERE ${conds.join(' AND ')}
     ORDER BY popular DESC, base_price ASC NULLS LAST
     LIMIT 6`,
    params,
  );

  if (rows.length === 0) return 'Трансферы по заданному направлению не найдены.';

  const base = appBase();
  return rows.map(t => {
    const price = t.base_price ? `от ${Math.round(Number(t.base_price))} руб` : 'цена по запросу';
    const dur = t.duration_minutes ? `, ~${Math.round(t.duration_minutes / 60 * 10) / 10} ч` : '';
    const dist = t.distance_km ? `, ${Math.round(Number(t.distance_km))} км` : '';
    return `${t.from_location} → ${t.to_location} — ${price}${dist}${dur}. Бронирование и даты: ${base}/transfers`;
  }).join('\n\n');
}
