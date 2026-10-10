/**
 * POST /api/accommodations/[id]/request — заявка хозяину жилья без своей
 * брони (миграция 1206, решение владельца 10.10).
 *
 * AUTH: публичный by design — гость без аккаунта, как в запросе мест тура
 * (/api/seat-requests). Защита: rate-limit, Zod, обязательное согласие на ПД
 * (текст варианта «владельцу жилья», lib/legal/pd-consent), ПД гостя уходят
 * только в MAX. Принимается только объектом «через владельца»: опубликован,
 * есть телефон, нет своего сайта брони и нет номеров — у объекта с номерами
 * своя бронь (/book), и второй путь противоречил бы ей.
 *
 * Согласие пишется в той же вставке, что заявка (stay_requests, NOT NULL).
 * Ответ называет, кому заявка дошла: хозяину, оператору платформы или никому
 * (lib/stay/stay-request — три исхода).
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { createRateLimiter, getTrustedClientIp } from '@/lib/rate-limit';
import { buildConsentRecord } from '@/lib/legal/pd-consent';
import { sendPdAlert } from '@/lib/notifications/pd-alert';
import { getPublicBaseUrl } from '@/lib/config';
import { publicAccommodationSql } from '@/lib/stay/moderation';
import { kamchatkaToday } from '@/lib/seat-requests/core';
import {
  MAX_REQUEST_NIGHTS,
  nightsBetween,
  stayRequestTexts,
  type StayRequestDelivery,
} from '@/lib/stay/stay-request';

export const dynamic = 'force-dynamic';

const limiter = createRateLimiter({ windowMs: 60_000, max: 5 });

const IdSchema = z.string().uuid();
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const Schema = z.object({
  check_in:   z.string().regex(DATE, 'Укажите дату заезда'),
  check_out:  z.string().regex(DATE, 'Укажите дату выезда'),
  guests:     z.coerce.number().int().min(1, 'Минимум 1 гость').max(50, 'Не больше 50 гостей'),
  name:       z.string().trim().min(2, 'Имя: минимум 2 символа').max(120),
  phone:      z.string().trim().min(10, 'Телефон слишком короткий').max(20, 'Телефон слишком длинный')
                .regex(/^[+\d\s()-]+$/, 'Телефон: только цифры, пробелы, скобки и дефис'),
  comment:    z.string().trim().max(1000, 'Комментарий: не больше 1000 символов').optional(),
  pd_consent: z.literal(true, { message: 'Нужно согласие на обработку персональных данных' }),
});

function fail(error: string, status: number, field?: string) {
  return NextResponse.json({ success: false, error, ...(field ? { field } : {}) }, { status });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ip = getTrustedClientIp(req.headers);
  if (!limiter.check(ip)) return fail('Слишком много запросов. Попробуйте через минуту.', 429);

  const idParsed = IdSchema.safeParse((await params).id);
  if (!idParsed.success) return fail('Объект не найден', 404);

  let body: unknown;
  try { body = await req.json(); } catch { return fail('Неверный формат запроса', 400); }
  const parsed = Schema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return fail(first?.message ?? 'Неверные данные формы', 400, first?.path?.[0]?.toString());
  }
  const d = parsed.data;

  const nights = nightsBetween(d.check_in, d.check_out);
  if (nights === null) return fail('Дата выезда должна быть позже даты заезда', 400, 'check_out');
  if (nights > MAX_REQUEST_NIGHTS) return fail(`Не больше ${MAX_REQUEST_NIGHTS} ночей одной заявкой`, 400, 'check_out');
  if (d.check_in < kamchatkaToday()) return fail('Дата заезда уже прошла', 400, 'check_in');

  const consent = buildConsentRecord(true, ip, 'stay-request', 'stay');
  if (!consent) return fail('Нужно согласие на обработку персональных данных', 400, 'pd_consent');

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
          AND ${publicAccommodationSql('a')}
          AND a.contact_phone IS NOT NULL
          AND a.external_booking_url IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM accommodation_rooms r WHERE r.accommodation_id = a.id AND r.is_active = true
          )`,
      [idParsed.data],
    ));
    if (!obj) return fail('У этого объекта заявка через форму не принимается', 404);

    const ins = await pool.query<{ id: string }>(
      `INSERT INTO stay_requests
         (accommodation_id, check_in_date, check_out_date, guests, guest_name, guest_phone, comment,
          pd_consent_at, pd_consent_ip, pd_consent_source, pd_consent_version)
       VALUES ($1, $2::date, $3::date, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        idParsed.data, d.check_in, d.check_out, d.guests, d.name, d.phone, d.comment || null,
        consent.at, consent.ip, consent.source, consent.version,
      ],
    );
    requestId = ins.rows[0].id;
  } catch (err) {
    const e = err as { message?: string; code?: string };
    console.error('[stay-request] заявка не записана:', e?.message ?? 'неизвестная ошибка', `SQLSTATE=${e?.code ?? 'нет'}`);
    return fail('Не удалось принять заявку. Позвоните владельцу по телефону на карточке.', 503);
  }

  const { text, stub } = stayRequestTexts({
    accommodationName: obj.name,
    checkIn: d.check_in,
    checkOut: d.check_out,
    nights,
    guests: d.guests,
    guestName: d.name,
    guestPhone: d.phone,
    comment: d.comment || null,
    priceFrom: obj.price_from != null ? Number(obj.price_from) : null,
    priceTo: obj.price_to != null ? Number(obj.price_to) : null,
  });
  const buttons = [{ text: 'Карточка объекта', url: `${getPublicBaseUrl()}/accommodations/${idParsed.data}` }];

  // Хозяину — только если у него есть адрес: без него strict-режим всё равно
  // ответил бы «не смог», а звать отправку заведомо впустую незачем.
  let ownerDelivered = false;
  if (obj.max_chat_id || obj.telegram_chat_id) {
    const r = await sendPdAlert({ text, stub, buttons, to: { maxChatId: obj.max_chat_id, telegramChatId: obj.telegram_chat_id } });
    ownerDelivered = r.delivered;
    if (!r.delivered) console.error(`[stay-request] ${requestId}: хозяину не доставлено (${r.channel}) — ${r.reason}`);
  } else {
    console.error(`[stay-request] ${requestId}: у хозяина нет подключённого MAX — заявка только оператору платформы`);
  }
  // Оператору платформы — всегда: он видит каждую заявку и подхватывает ту,
  // что хозяину не дошла.
  const adminRes = await sendPdAlert({ text, stub, buttons });
  if (!adminRes.delivered) console.error(`[stay-request] ${requestId}: оператору не доставлено (${adminRes.channel}) — ${adminRes.reason}`);

  const delivered: StayRequestDelivery = ownerDelivered ? 'owner' : adminRes.delivered ? 'platform' : 'none';
  if (delivered === 'none') {
    return NextResponse.json({
      success: false,
      error: 'Заявка записана, но передать её сейчас не удалось. Позвоните владельцу по телефону на карточке.',
      data: { delivered },
    }, { status: 502 });
  }
  return NextResponse.json({ success: true, data: { delivered } });
}
