/**
 * lib/stay/stay-request-service.ts — запись и доставка заявки хозяину жилья
 * (1206). Один путь на обе двери: форма на карточке объекта
 * (`POST /api/accommodations/[id]/request`) и инструмент MCP
 * `create_stay_request` (решение владельца 10.10: «да делай»).
 *
 * Двери отличаются только тем, как получено согласие: на форме гость ставит
 * галочку сам, в MCP ассистент спрашивает человека и передаёт `consent: true`.
 * Всё остальное — какие объекты принимают заявку, что пишется в базу, кому и
 * каким текстом уходит, три исхода доставки — здесь, одно. Две копии этого
 * разошлись бы на первом же правиле (тот же урок, что с карточкой тура, §11).
 *
 * Тексты и чистые правила — `lib/stay/stay-request.ts`.
 * Сторожа: tests/unit/stay-request.test.ts, tests/unit/mcp-stay-request.test.ts.
 */

import { pool } from '@/lib/db-pool';
import { sendPdAlert } from '@/lib/notifications/pd-alert';
import { getPublicBaseUrl } from '@/lib/config';
import { publicAccommodationSql } from '@/lib/stay/moderation';
import { containsPattern } from '@/lib/db/like';
import type { PdConsentRecord } from '@/lib/legal/pd-consent';
import {
  MAX_REQUEST_NIGHTS,
  nightsBetween,
  stayRequestTexts,
  type StayRequestDelivery,
} from '@/lib/stay/stay-request';

/**
 * Объект «через владельца»: опубликован, есть телефон, нет своего сайта брони
 * и нет номеров. У объекта с номерами своя бронь (/book), у объекта с сайтом —
 * сайт; второй путь противоречил бы им.
 */
export function stayRequestEligibleSql(a: string): string {
  return `${publicAccommodationSql(a)}
          AND ${a}.contact_phone IS NOT NULL
          AND ${a}.external_booking_url IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM accommodation_rooms r WHERE r.accommodation_id = ${a}.id AND r.is_active = true
          )`;
}

/** Проверка дат заявки: ночи по порядку, не больше потолка, заезд не в прошлом (по Камчатке). */
export function checkStayDates(
  checkIn: string,
  checkOut: string,
  today: string,
): { ok: true; nights: number } | { ok: false; field: 'check_in' | 'check_out'; error: string } {
  const nights = nightsBetween(checkIn, checkOut);
  if (nights === null) return { ok: false, field: 'check_out', error: 'Дата выезда должна быть позже даты заезда' };
  if (nights > MAX_REQUEST_NIGHTS) return { ok: false, field: 'check_out', error: `Не больше ${MAX_REQUEST_NIGHTS} ночей одной заявкой` };
  if (checkIn < today) return { ok: false, field: 'check_in', error: 'Дата заезда уже прошла' };
  return { ok: true, nights };
}

export interface StayRequestInput {
  accommodationId: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  guests: number;
  guestName: string;
  guestPhone: string;
  comment: string | null;
  consent: PdConsentRecord;
  /** Чьей дверью пришла заявка — только в лог. */
  door: 'form' | 'mcp';
}

export type StayRequestResult =
  | { ok: true; delivered: StayRequestDelivery; accommodationName: string }
  /** Объект заявку через форму не принимает (снят, с номерами, с сайтом брони). */
  | { ok: false; reason: 'not_accepting' }
  /** Не записалась: база не ответила. Причина — в логе с SQLSTATE. */
  | { ok: false; reason: 'save_failed' };

export async function submitStayRequest(i: StayRequestInput): Promise<StayRequestResult> {
  type ObjRow = {
    name: string; price_from: string | null; price_to: string | null;
    max_chat_id: string | null; telegram_chat_id: string | null;
  };
  let obj: ObjRow | undefined;
  let requestId: string;
  try {
    ({ rows: [obj] } = await pool.query<ObjRow>(
      `SELECT a.name,
              a.price_per_night_from AS price_from,
              a.price_per_night_to   AS price_to,
              p.max_chat_id::text      AS max_chat_id,
              p.telegram_chat_id::text AS telegram_chat_id
         FROM accommodations a
         LEFT JOIN partners p ON p.id = a.partner_id
        WHERE a.id = $1
          AND ${stayRequestEligibleSql('a')}`,
      [i.accommodationId],
    ));
    if (!obj) return { ok: false, reason: 'not_accepting' };

    // Согласие пишется в той же вставке, что заявка (NOT NULL в 1206).
    const ins = await pool.query<{ id: string }>(
      `INSERT INTO stay_requests
         (accommodation_id, check_in_date, check_out_date, guests, guest_name, guest_phone, comment,
          pd_consent_at, pd_consent_ip, pd_consent_source, pd_consent_version)
       VALUES ($1, $2::date, $3::date, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        i.accommodationId, i.checkIn, i.checkOut, i.guests, i.guestName, i.guestPhone, i.comment,
        i.consent.at, i.consent.ip, i.consent.source, i.consent.version,
      ],
    );
    requestId = ins.rows[0].id;
  } catch (err) {
    const e = err as { message?: string; code?: string };
    console.error(`[stay-request:${i.door}] заявка не записана:`, e?.message ?? 'неизвестная ошибка', `SQLSTATE=${e?.code ?? 'нет'}`);
    return { ok: false, reason: 'save_failed' };
  }

  const { text, stub } = stayRequestTexts({
    accommodationName: obj.name,
    checkIn: i.checkIn,
    checkOut: i.checkOut,
    nights: i.nights,
    guests: i.guests,
    guestName: i.guestName,
    guestPhone: i.guestPhone,
    comment: i.comment,
    priceFrom: obj.price_from != null ? Number(obj.price_from) : null,
    priceTo: obj.price_to != null ? Number(obj.price_to) : null,
  });
  const buttons = [{ text: 'Карточка объекта', url: `${getPublicBaseUrl()}/accommodations/${i.accommodationId}` }];

  // Хозяину — только если у него есть адрес: без него strict-режим всё равно
  // ответил бы «не смог», а звать отправку заведомо впустую незачем.
  let ownerDelivered = false;
  if (obj.max_chat_id || obj.telegram_chat_id) {
    const r = await sendPdAlert({ text, stub, buttons, to: { maxChatId: obj.max_chat_id, telegramChatId: obj.telegram_chat_id } });
    ownerDelivered = r.delivered;
    if (!r.delivered) console.error(`[stay-request:${i.door}] ${requestId}: хозяину не доставлено (${r.channel}) — ${r.reason}`);
  } else {
    console.error(`[stay-request:${i.door}] ${requestId}: у хозяина нет подключённого MAX — заявка только оператору платформы`);
  }
  // Оператору платформы — всегда: он видит каждую заявку и подхватывает ту,
  // что хозяину не дошла.
  const adminRes = await sendPdAlert({ text, stub, buttons });
  if (!adminRes.delivered) console.error(`[stay-request:${i.door}] ${requestId}: оператору не доставлено (${adminRes.channel}) — ${adminRes.reason}`);

  const delivered: StayRequestDelivery = ownerDelivered ? 'owner' : adminRes.delivered ? 'platform' : 'none';
  return { ok: true, delivered, accommodationName: obj.name };
}

/**
 * Какой объект имел в виду агент: UUID с карточки или часть названия.
 * Ищется по всей опубликованной витрине, а не только среди принимающих
 * заявку: «такого нет» и «у этого объекта заявка идёт другим путём» — разные
 * ответы, и второй называет путь (сайт брони, номера на карточке).
 */
export type StayResolution =
  | { kind: 'found'; id: string; name: string }
  | { kind: 'other_path'; id: string; name: string; path: 'site' | 'rooms' | 'no_phone' }
  | { kind: 'ambiguous'; names: string[] }
  | { kind: 'not_found' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Бросает при отказе базы: «не смог посмотреть» — не «не найдено» (§4.0). */
export async function resolveStayForRequest(query: string): Promise<StayResolution> {
  const q = query.trim();
  const byId = UUID.test(q);
  const { rows } = await pool.query<{
    id: string; name: string; has_site: boolean; has_rooms: boolean; has_phone: boolean;
  }>(
    `SELECT a.id, a.name,
            (a.external_booking_url IS NOT NULL) AS has_site,
            EXISTS (
              SELECT 1 FROM accommodation_rooms r WHERE r.accommodation_id = a.id AND r.is_active = true
            ) AS has_rooms,
            (a.contact_phone IS NOT NULL) AS has_phone
       FROM accommodations a
      WHERE ${publicAccommodationSql('a')}
        AND ${byId ? 'a.id = $1::uuid' : 'a.name ILIKE $1'}
      ORDER BY (LOWER(a.name) = LOWER($2)) DESC, a.name
      LIMIT 4`,
    [byId ? q : containsPattern(q), q],
  );
  if (rows.length === 0) return { kind: 'not_found' };
  // Точное совпадение имени снимает неоднозначность: «Кутха» не должна
  // спотыкаться о «Кутха-2», если такая появится.
  const exact = rows.filter((r) => r.name.trim().toLowerCase() === q.toLowerCase());
  const picked = rows.length === 1 ? rows[0] : exact.length === 1 ? exact[0] : null;
  if (!picked) return { kind: 'ambiguous', names: rows.map((r) => r.name) };
  if (picked.has_site) return { kind: 'other_path', id: picked.id, name: picked.name, path: 'site' };
  if (picked.has_rooms) return { kind: 'other_path', id: picked.id, name: picked.name, path: 'rooms' };
  if (!picked.has_phone) return { kind: 'other_path', id: picked.id, name: picked.name, path: 'no_phone' };
  return { kind: 'found', id: picked.id, name: picked.name };
}
