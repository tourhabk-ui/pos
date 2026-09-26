/**
 * lib/kuzmich/accommodation-search.ts
 *
 * Реализация инструмента Кузьмича search_accommodations. Вынесена в отдельный
 * модуль (как guardian-context / taaft-search) — executeTool подгружает её
 * лениво, а юнит-тест зовёт напрямую. Прямой параметризованный SELECT из
 * accommodations (master витрины жилья), только опубликованные (is_active и одобрены администратором, миграция 1027).
 */

import { pool } from '@/lib/db-pool';
import { publicAccommodationSql } from '@/lib/stay/moderation';
import { getPublicBaseUrl } from '@/lib/config';

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

const appBase = getPublicBaseUrl;

export async function searchAccommodationsForKuzmich(args: AccommodationSearchArgs): Promise<string> {
  // Витрина — только одобренные администратором (миграция 1027).
  const conds: string[] = [publicAccommodationSql('')];
  const params: unknown[] = [];

  if (args.zone) { params.push(`%${args.zone}%`); conds.push(`location_zone ILIKE $${params.length}`); }
  if (args.type) { params.push(`%${args.type}%`); conds.push(`type ILIKE $${params.length}`); }
  const priceMax = Number(args.price_max);
  if (args.price_max && Number.isFinite(priceMax) && priceMax > 0) {
    params.push(priceMax);
    conds.push(`price_per_night_from <= $${params.length}`);
  }

  const base = appBase();
  const filtered = Boolean(args.zone || args.type || (args.price_max && Number.isFinite(priceMax) && priceMax > 0));

  let rows: AccommodationRow[];
  try {
    ({ rows } = await pool.query<AccommodationRow>(
      `SELECT id, name, type, address, location_zone, price_per_night_from, rating
       FROM accommodations
       WHERE ${conds.join(' AND ')}
       ORDER BY rating DESC NULLS LAST
       LIMIT 6`,
      params,
    ));
  } catch (err) {
    // Третий исход (§4.0): отказ запроса — это «не смог посмотреть», а не
    // «жилья нет». Молча вернуть пустоту значило бы выдать поломку за факт
    // о витрине, и турист принял бы решение по несуществующему ответу.
    const code = (err as { code?: string }).code ?? 'нет кода';
    console.error(`[search_accommodations] запрос к accommodations не выполнен, SQLSTATE=${code}`);
    return `Не смог посмотреть витрину жилья — база не ответила. Это отказ проверки, а не «жилья нет». Попробуйте позже или откройте ${base}/accommodations.`;
  }

  if (rows.length === 0) {
    // Разные пустоты — разные ответы.
    //
    // Раньше здесь стояло «Жильё по заданным условиям не найдено» на ЛЮБОЙ
    // ноль, в том числе когда условий не задавали вовсе. Турист читал это
    // как «сузьте запрос» и шёл подбирать фильтры к пустой витрине, а агент
    // — пересказывал ему то же самое. Образец правильного ответа стоял
    // рядом: transfer-search говорит «опубликованных поездок нет — это факт
    // витрины, не сбой» и даёт адрес.
    if (!filtered) {
      return `На витрине жилья пока нет ни одного предложения. Это факт витрины, не сбой. Смотреть, когда появятся: ${base}/accommodations.`;
    }

    let anyActive = false;
    try {
      const probe = await pool.query<{ one: number }>(
        `SELECT 1 AS one FROM accommodations WHERE ${publicAccommodationSql('')} LIMIT 1`,
      );
      anyActive = probe.rows.length > 0;
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'нет кода';
      console.error(`[search_accommodations] проверка непустой витрины не выполнена, SQLSTATE=${code}`);
    }

    const asked = [
      args.zone ? `зона «${args.zone}»` : null,
      args.type ? `тип «${args.type}»` : null,
      args.price_max && Number.isFinite(priceMax) && priceMax > 0 ? `до ${Math.round(priceMax)} руб/ночь` : null,
    ].filter(Boolean).join(', ');

    return anyActive
      ? `По условиям (${asked}) жилья нет, но на витрине есть другие варианты — попробуйте шире: ${base}/accommodations.`
      : `На витрине жилья пока нет ни одного предложения — дело не в условиях (${asked}). Это факт витрины, не сбой. ${base}/accommodations.`;
  }

  return rows.map(a => {
    const price = a.price_per_night_from
      ? `от ${Math.round(Number(a.price_per_night_from))} руб/ночь`
      : 'цена по запросу';
    const where = [a.location_zone, a.address].filter(Boolean).join(', ');
    return `${a.name}${a.type ? ` [${a.type}]` : ''} — ${price}${where ? `. ${where}` : ''}. ${base}/accommodations/${a.id}`;
  }).join('\n\n');
}
