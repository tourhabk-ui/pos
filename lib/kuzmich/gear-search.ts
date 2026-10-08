/**
 * lib/kuzmich/gear-search.ts
 *
 * Инструмент Кузьмича search_gear — поиск проката снаряжения. Вынесен в модуль
 * (как accommodation-search / guardian-context): executeTool подгружает лениво,
 * юнит-тест зовёт напрямую. Прямой параметризованный SELECT из gear_items,
 * только is_active. Публичной страницы товара нет — ссылка на витрину /gear.
 */

import { pool } from '@/lib/db-pool';
import { publicGearSql } from '@/lib/gear/moderation';
import { containsPattern } from '@/lib/db/like';
import { getPublicBaseUrl } from '@/lib/config';

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

const appBase = getPublicBaseUrl;

/**
 * Пустая витрина — факт, а не сбой поиска (решение владельца 08.10, #2239).
 * Партнёров-прокатов на платформе пока нет, и «по заданным условиям не
 * найдено» читалось агентом как «поищи иначе». Честный ответ — витрина пуста,
 * а список вещей в дорогу даёт маршрут; адреса прокатов, которых нет в базе,
 * не сочиняются.
 */
export const EMPTY_SHELF =
  'Витрина проката снаряжения на платформе пока пуста — ни один прокат не подключён. Это факт витрины, не сбой поиска. '
  + 'Что взять с собой на конкретный маршрут, говорит его карточка (снаряжение маршрута). '
  + 'Адресов прокатов в базе нет — не называй их по памяти; можно предложить оставить заявку через create_lead.';

/** Сколько позиций на витрине вообще; null — не смогли прочитать (§4.0). */
async function publicGearCount(): Promise<number | null> {
  try {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM gear_items WHERE ${publicGearSql('')}`,
    );
    return rows[0]?.n ?? 0;
  } catch (err) {
    const e = err as { code?: string; message?: string };
    console.error('[gear-search] витрина не посчитана', { sqlstate: e?.code, message: e?.message });
    return null;
  }
}

export async function searchGearForKuzmich(args: GearSearchArgs): Promise<string> {
  // Шлюз витрины — тот же, что у каталога /gear: позиция на проверке или
  // отклонённая (moderation_status) в ответ Кузьмича и публичного MCP не
  // попадает. До 29.09 здесь стояло одно is_active, и непроверенная позиция
  // уходила внешнему агенту наравне с одобренной (проверка MCP).
  const conds: string[] = [publicGearSql('')];
  const params: unknown[] = [];

  // containsPattern, а не `%${...}%`: оба аргумента приходят из переписки с
  // Кузьмичом, и `%` в них расширял шаблон до «совпадает со всем» — поиск
  // отвечал бы чем попало, выглядя при этом исправным.
  if (args.query) {
    params.push(containsPattern(args.query));
    const p = `$${params.length}`;
    conds.push(`(name ILIKE ${p} OR brand ILIKE ${p} OR category ILIKE ${p})`);
  }
  if (args.category) { params.push(containsPattern(args.category)); conds.push(`category ILIKE $${params.length}`); }
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

  if (rows.length === 0) {
    const filtered = params.length > 0;
    const shelf = filtered ? await publicGearCount() : 0;
    if (shelf === 0) return EMPTY_SHELF;
    if (shelf === null) {
      return 'Снаряжение по заданным условиям не найдено. Есть ли на витрине проката что-то другое, проверить не удалось — не утверждай, что проката нет.';
    }
    return `Снаряжение по заданным условиям не найдено. На витрине проката всего позиций: ${shelf} — можно поискать без фильтра или по другому слову.`;
  }

  const base = appBase();
  return rows.map(g => {
    const price = g.price_per_day
      ? `от ${Math.round(Number(g.price_per_day))} руб/сутки`
      : 'цена по запросу';
    const meta = [g.brand, g.category].filter(Boolean).join(', ');
    return `${g.name}${meta ? ` (${meta})` : ''} — ${price}. ${base}/gear`;
  }).join('\n\n');
}
