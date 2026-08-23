/**
 * POST /api/cron/payment-test-setup — обвязка для проверки оплаты и комиссии.
 *
 * Решение владельца 23.08.2026: завести служебного партнёра и тестовый тур,
 * оплатить рублём и убедиться, что комиссия начисляется. Проверять надо не
 * догадкой, а деньгами: подделать оплату нельзя — приёмник Точки не верит
 * телу запроса, а спрашивает банк и сверяет сумму с `final_price`.
 *
 * ПОЧЕМУ ТУР НЕВИДИМЫЙ, А БРОНЬ ЗАВОДИТСЯ ОТСЮДА. Витрина и карточка тура
 * требуют `is_active = TRUE`. Сделать тур видимым значило бы вывесить в живой
 * каталог тур за рубль, который может купить настоящий турист. Между тем QR
 * СБП (`POST /api/payments/tochka/qr`) не требует активного тура — ему нужна
 * бронь в статусе `new` или `pending_payment`. Значит весь денежный путь —
 * QR, оплата, подтверждение банком, вебхук, `paid_at`, начисление — проходит
 * целиком, а витрина не трогается вовсе. Не пройден только фронтовый бланк
 * брони; он к оплате и комиссии отношения не имеет.
 *
 * ПЕРСОНАЛЬНЫХ ДАННЫХ НЕТ ПО ПОСТРОЕНИЮ. `tourist_email`, `tourist_phone` и
 * `tourist_name` в `operator_bookings` необязательны, и здесь не
 * заполняются: служебной брони не нужен турист.
 *
 * УБОРКА — МЯГКАЯ (решение владельца). `teardown` проставляет `deleted_at`
 * туру и броне: они исчезают из витрины и кабинета, но строка комиссии
 * продолжает ссылаться на НАСТОЯЩУЮ бронь, а не в пустоту. Строка комиссии и
 * есть доказательство, ради которого всё затевалось, — стирать её опору
 * значит стирать доказательство.
 *
 * Служебный партнёр после уборки остаётся: у него есть строка тура (пусть и
 * помеченная удалённой), поэтому уборка бесхозных его не тронет. Он невидим
 * (`is_public = false`) и служит якорем проверки.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getCronSecret } from '@/lib/auth/cron';
import { timingSafeCompare } from '@/lib/security/timing-safe';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

/** Опознавательные имена. По ним же роут находит своё при повторном вызове. */
const PARTNER_NAME = 'Служебный — проверка оплаты';
const TOUR_TITLE = 'Служебная проверка оплаты — не покупать';
/** Ставка задаётся явно, чтобы в сухой проверке было видно договорную, а не запасную. */
const COMMISSION_PERCENT = 10;
/** Рубль: меньше нельзя, больше незачем. */
const PRICE_RUB = 1;

export async function POST(request: NextRequest) {
  const secret = getCronSecret(request);
  if (!timingSafeCompare(secret, process.env.CRON_SECRET ?? '')) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let action = 'setup';
  let confirm = false;
  try {
    const body = (await request.json()) as { action?: unknown; confirm?: unknown };
    if (body?.action === 'teardown') action = 'teardown';
    confirm = body?.confirm === true;
  } catch {
    // Тела нет — сухой прогон установки. Это не ошибка.
  }

  if (!confirm) {
    return NextResponse.json({
      ok: true,
      dry_run: true,
      action,
      would: action === 'setup'
        ? `создать партнёра «${PARTNER_NAME}» (ставка ${COMMISSION_PERCENT}%), невидимый тур «${TOUR_TITLE}» за ${PRICE_RUB} ₽ и бронь в статусе pending_payment`
        : 'проставить deleted_at служебным туру и броне; строка комиссии и партнёр остаются',
      hint: 'повторить с телом {"confirm":true}',
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (action === 'teardown') {
      const { rows } = await client.query<{ tours: number; bookings: number }>(
        `WITH t AS (
           UPDATE operator_tours SET deleted_at = NOW(), is_active = false
            WHERE title = $1 AND deleted_at IS NULL
            RETURNING id),
         b AS (
           UPDATE operator_bookings SET deleted_at = NOW()
            WHERE operator_tour_id IN (SELECT id FROM operator_tours WHERE title = $1)
              AND deleted_at IS NULL
            RETURNING id)
         SELECT (SELECT COUNT(*)::int FROM t) AS tours, (SELECT COUNT(*)::int FROM b) AS bookings`,
        [TOUR_TITLE],
      );
      await client.query('COMMIT');
      return NextResponse.json({
        ok: true,
        action: 'teardown',
        tours_hidden: rows[0]?.tours ?? 0,
        bookings_hidden: rows[0]?.bookings ?? 0,
        note: 'мягкое удаление: строка комиссии по-прежнему ссылается на настоящую бронь',
      });
    }

    // ── Партнёр ───────────────────────────────────────────────────────────
    const { rows: partnerRows } = await client.query<{ id: string }>(
      // Типы параметров заданы ЯВНО, а не оставлены выводу. Первый прогон
      // упал на 42P08 «inconsistent types deduced for parameter $1»: один и
      // тот же параметр попадает в `name` и в `company_name`, а объявлены они
      // разными типами, и Postgres не смог свести их к одному. Приведение
      // снимает вопрос вместо того, чтобы полагаться на догадку планировщика.
      `INSERT INTO partners (name, company_name, category, commission_current, is_public, is_verified, external_source)
       SELECT $1::text, $1::text, 'operator', $2::numeric, false, false, 'service-payment-test'
        WHERE NOT EXISTS (SELECT 1 FROM partners WHERE name = $1::text)
       RETURNING id::text`,
      [PARTNER_NAME, COMMISSION_PERCENT],
    );
    const partnerId = partnerRows[0]?.id
      ?? (await client.query<{ id: string }>(`SELECT id::text FROM partners WHERE name = $1 LIMIT 1`, [PARTNER_NAME])).rows[0]?.id;
    if (!partnerId) throw new Error('партнёр не создан и не найден');

    // ── Тур: невидимый по построению ──────────────────────────────────────
    const { rows: tourRows } = await client.query<{ id: string }>(
      // `created_via` у operator_tours НЕТ: колонка не объявлена ни одной
      // миграцией. Она есть у operator_bookings (040), и по соседству легко
      // принять одну за другую — так и вышло: я списал её с
      // lib/agents/agencies/operator-agency.ts, а тот файл стоит в списке
      // известных фантомов, то есть его вставка тура на проде упала бы на
      // 42703. Опознаётся служебный тур по title, и этого достаточно.
      `INSERT INTO operator_tours (operator_id, title, base_price, is_active, is_published)
       SELECT $1::uuid, $2::text, $3::numeric, false, false
        WHERE NOT EXISTS (SELECT 1 FROM operator_tours WHERE title = $2::text AND deleted_at IS NULL)
       RETURNING id::text`,
      [partnerId, TOUR_TITLE, PRICE_RUB],
    );
    const tourId = tourRows[0]?.id
      ?? (await client.query<{ id: string }>(
        `SELECT id::text FROM operator_tours WHERE title = $1 AND deleted_at IS NULL LIMIT 1`, [TOUR_TITLE],
      )).rows[0]?.id;
    if (!tourId) throw new Error('тур не создан и не найден');

    // ── Бронь: без туриста, персональных данных нет ───────────────────────
    const { rows: bookingRows } = await client.query<{ id: string }>(
      `INSERT INTO operator_bookings
         (operator_tour_id, booking_date, participants, base_total_price, final_price, booking_status, payment_status, created_via)
       SELECT $1::bigint, CURRENT_DATE, 1, $2::numeric, $2::numeric, 'pending_payment', 'pending', 'service-payment-test'
        WHERE NOT EXISTS (
              SELECT 1 FROM operator_bookings
               WHERE operator_tour_id = $1::bigint AND deleted_at IS NULL AND paid_at IS NULL)
       RETURNING id::text`,
      [tourId, PRICE_RUB],
    );
    const bookingId = bookingRows[0]?.id
      ?? (await client.query<{ id: string }>(
        `SELECT id::text FROM operator_bookings
          WHERE operator_tour_id = $1::bigint AND deleted_at IS NULL AND paid_at IS NULL
          ORDER BY created_at DESC LIMIT 1`, [tourId],
      )).rows[0]?.id;
    if (!bookingId) throw new Error('бронь не создана и не найдена');

    await client.query('COMMIT');

    return NextResponse.json({
      ok: true,
      action: 'setup',
      partner_id: partnerId,
      partner_name: PARTNER_NAME,
      commission_percent: COMMISSION_PERCENT,
      tour_id: tourId,
      tour_title: TOUR_TITLE,
      tour_visible: false,
      booking_id: Number(bookingId),
      price_rub: PRICE_RUB,
      next: [
        `QR: POST /api/payments/tochka/qr с телом {"bookingId": ${bookingId}}`,
        'оплатить по QR с телефона',
        `проверить: GET /api/cron/commission-dry-run?booking=${bookingId} и строку в operator_commissions`,
        'убрать: POST сюда же с телом {"action":"teardown","confirm":true}',
      ],
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // Третий исход: не смог подготовить — это не «всё готово».
    const e = err as { code?: string; constraint?: string; message?: string };
    console.error(
      '[payment-test-setup] обвязка не создана:',
      `sqlstate=${e?.code ?? 'нет'}`,
      e?.constraint ? `(${e.constraint})` : '',
      e?.message ?? String(err),
    );
    return NextResponse.json(
      { ok: false, reason: e?.message ?? 'база не ответила', sqlstate: e?.code ?? null },
      { status: 500 },
    );
  } finally {
    client.release();
  }
}
