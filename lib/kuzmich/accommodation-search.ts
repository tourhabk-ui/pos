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
import { recordAgentStaySearch } from '@/lib/stay/demand-record';
import { containsPattern } from '@/lib/db/like';

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
  /** Верхняя цена за сутки (1205, «Кутха»: 28 000 с раскладушками); null — одна цена или не названа. */
  price_per_night_to: string | null;
  /** Короткое описание объекта — что это и на сколько человек; null — не записано. */
  short_description: string | null;
  rating: string | null;
  external_booking_url: string | null;
  /** Есть ли у объекта телефон для связи. Сам номер сюда НЕ выбирается (pd-guard). */
  has_contact_phone: boolean;
  /** Своих номеров у объекта нет — на карточке форма заявки хозяину (1206). */
  no_rooms: boolean;
}

const appBase = getPublicBaseUrl;

export async function searchAccommodationsForKuzmich(args: AccommodationSearchArgs): Promise<string> {
  // Витрина — только одобренные администратором (миграция 1027).
  const conds: string[] = [publicAccommodationSql('')];
  const params: unknown[] = [];

  if (args.zone) { params.push(containsPattern(args.zone)); conds.push(`location_zone ILIKE $${params.length}`); }
  if (args.type) { params.push(containsPattern(args.type)); conds.push(`type ILIKE $${params.length}`); }
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
      `SELECT id, name, type, address, location_zone, price_per_night_from, price_per_night_to,
              short_description, rating, external_booking_url,
              (contact_phone IS NOT NULL) AS has_contact_phone,
              NOT EXISTS (
                SELECT 1 FROM accommodation_rooms r WHERE r.accommodation_id = accommodations.id AND r.is_active = true
              ) AS no_rooms
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
    // Спрос был, ответа не было: исход 'failed', а не 'empty' (lib/stay/demand).
    await recordAgentStaySearch('failed');
    return `Не смог посмотреть витрину жилья — база не ответила. Это отказ проверки, а не «жилья нет». Попробуйте позже или откройте ${base}/accommodations.`;
  }

  // Счётчик спроса на жильё (29.09): каждый поиск агента — сигнал, пустой
  // тем более. Пустой ответ на спрос и есть довод «подключать поставщика».
  await recordAgentStaySearch(rows.length > 0 ? 'found' : 'empty');

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
    // Объект с бронью на своём сайте (миграция 1109): цены и наличие там —
    // так и говорим, а не «цена по запросу», которая звала бы писать нам.
    // Верхняя цена — когда объект назвал две (10.10, «Кутха»: 24 000 на 8 мест,
    // 28 000 с раскладушками); иначе агент называл бы туристу только нижнюю.
    const from = a.price_per_night_from ? Math.round(Number(a.price_per_night_from)) : null;
    const to = a.price_per_night_to ? Math.round(Number(a.price_per_night_to)) : null;
    const price = from
      ? (to && to > from ? `от ${from} до ${to} руб/ночь` : `от ${from} руб/ночь`)
      : a.external_booking_url ? 'цены и свободные даты — на сайте объекта'
      : a.has_contact_phone ? 'цены и свободные даты — у владельца по телефону'
      : 'цена по запросу';
    const where = [a.location_zone, a.address].filter(Boolean).join(', ');
    // Номер модели не отдаётся: она зарубежная, а номер — контакт человека.
    // Телефон есть на карточке по ссылке выше, туда и отправляем.
    // Объект без своих номеров и сайта брони (1206): на карточке форма заявки
    // хозяину — даты, гости, телефон. Агент зовёт туда, а не только «звоните».
    const book = a.external_booking_url ? ` Бронь на сайте объекта: ${a.external_booking_url}`
      : a.has_contact_phone && a.no_rooms
        ? ' Заявку владельцу можно оставить формой на карточке по ссылке выше (даты, число гостей, телефон) или, у внешнего агента, инструментом create_stay_request с согласия человека; там же телефон владельца. Даты и цену подтверждает владелец, бронь и оплата напрямую с объектом.'
      : a.has_contact_phone ? ' Телефон владельца — на карточке по ссылке выше; бронь и оплата напрямую с объектом.'
      : '';
    const about = a.short_description?.trim() ? ` ${a.short_description.trim()}.` : '';
    return `${a.name}${a.type ? ` [${a.type}]` : ''} — ${price}${where ? `. ${where}` : ''}.${about} ${base}/accommodations/${a.id}.${book}`;
  }).join('\n\n');
}
