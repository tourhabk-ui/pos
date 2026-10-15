import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query, transaction } from '@/lib/database';
import { ApiResponse } from '@/types';
import { requireAuth } from '@/lib/auth/middleware';
import { getGearPartnerId } from '@/lib/auth/gear-helpers';
import { calcRentalDays, calcGearPrice } from '@/lib/gear/pricing';
import { publicGearSql } from '@/lib/gear/moderation';
import {
  gearPeakSql, OPEN_GEAR_REQUESTS_SQL,
  GEAR_PENDING_HOLD_HOURS, MAX_OPEN_GEAR_REQUESTS_PER_USER,
} from '@/lib/gear/availability';
import { buildConsentRecord } from '@/lib/legal/pd-consent';
import { getTrustedClientIp } from '@/lib/rate-limit';
import { isRealDate, kamchatkaToday } from '@/lib/seat-requests/core';
import { notifyNewGearRental } from '@/lib/notifications/gear-rental';
import { linkContactQuietly } from '@/lib/crm/contacts';
import { logSwallowedFailure } from '@/lib/observability/swallowed';

export const dynamic = 'force-dynamic';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const CreateGearRentalSchema = z.object({
  gearId: z.string().uuid('Некорректный ID снаряжения'),
  customer: z.object({
    name: z.string().min(1, 'Имя обязательно').max(255),
    email: z.string().email('Некорректный email'),
    phone: z.string().min(5, 'Номер телефона обязателен').max(50),
  }),
  rental: z.object({
    startDate: z.string().regex(ISO_DATE, 'Дата начала — в формате ГГГГ-ММ-ДД'),
    endDate: z.string().regex(ISO_DATE, 'Дата окончания — в формате ГГГГ-ММ-ДД'),
    quantity: z.number().int().positive('Количество должно быть целым числом больше 0').max(50),
    insurance: z.boolean().optional(),
  }),
  comments: z.string().max(2000).optional(),
  // Имя, телефон и почта уходят прокату — согласие обязано назвать его
  // (вариант 'gear' в lib/legal/pd-consent). Без галочки заявки нет.
  pd_consent: z.literal(true, { message: 'Нужно согласие на обработку персональных данных и их передачу прокату' }),
});

const fail = (status: number, error: string) =>
  NextResponse.json({ success: false, error } as ApiResponse<null>, { status });

type RentalOutcome =
  | { code: 'too_many_open' }
  | { code: 'conflict'; free: number }
  | { code: 'created'; rentalId: string };

/**
 * POST /api/gear/rentals — заявка на аренду снаряжения. ПОД ВХОДОМ.
 *
 * Дверь (аудит 15.10, находка A13, вариант «а» по карт-бланшу владельца).
 * Прежняя шапка называла роут публичным «как лиды», но Edge пускает к
 * /api/gear анонима только с GET (реестр публичных API — зона §7, не
 * трогается): гость получал голый 401, вошедший проходил, и его имя,
 * телефон и почта уходили прокату без согласия, называющего получателя.
 * Теперь честно: заявку отправляет вошедший (requireAuth здесь, а не только
 * на Edge — по нему заявка знает человека), форма показывает гостю ссылку на
 * вход, как форма брони жилья, а согласие — вариант «прокату снаряжения».
 *
 * Цена — ТОЛЬКО сервером, единым модулем lib/gear/pricing (им же считает
 * форма, поэтому показанное и записанное совпадают). Страховка — из
 * insurance_cost_per_day позиции; нет тарифа — заявка со страховкой
 * отклоняется честной ошибкой, а не молчаливым нулём.
 *
 * Доступность — по ДАТАМ, одной формулой lib/gear/availability: пик
 * одновременно занятых единиц в окне плюс запрошенное не больше стока.
 * Единицу держат подтверждённая, выданная и просроченная аренда, а заявка —
 * только GEAR_PENDING_HOLD_HOURS часов; открытых заявок у человека — не
 * больше MAX_OPEN_GEAR_REQUESTS_PER_USER. Счёт и вставка идут в ОДНОЙ
 * транзакции под advisory-блокировками человека и позиции: раньше пик и
 * INSERT шли отдельными запросами, и две заявки на последнюю единицу
 * проходили обе.
 */
export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;
  const userId = auth.userId;

  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return fail(400, 'Неверный формат запроса');
    }
    const parsed = CreateGearRentalSchema.safeParse(body);
    if (!parsed.success) {
      return fail(400, parsed.error.issues[0]?.message || 'Некорректные данные');
    }

    const { gearId, customer, rental, comments } = parsed.data;

    if (!isRealDate(rental.startDate) || !isRealDate(rental.endDate)) {
      return fail(400, 'Такой даты нет в календаре');
    }
    // «Сегодня» — по Камчатке: сервер живёт в UTC, и с полуночи до полудня
    // по местному времени его «сегодня» — вчерашний день туриста.
    if (rental.startDate < kamchatkaToday()) {
      return fail(400, 'Дата начала уже прошла — выберите сегодняшнюю или более позднюю');
    }

    const rentalDays = calcRentalDays(rental.startDate, rental.endDate);
    if (rentalDays === null) {
      return fail(400, 'Дата окончания должна быть позже даты начала');
    }
    if (rentalDays > 365) {
      return fail(400, 'Максимальный срок аренды — год. Свяжитесь с прокатом напрямую.');
    }

    // Позиция — тем же шлюзом витрины, что каталог: неодобренную или снятую
    // партнёром не арендуют (иначе отказ триггера модерации 1030 становился
    // немым 500, Д2-3).
    const gearResult = await query<{
      name: string;
      quantity: number;
      price_per_day: string;
      price_per_week: string | null;
      price_per_month: string | null;
      insurance_cost_per_day: string | null;
      partner_id: string | null;
    }>(`
      SELECT gi.name, gi.quantity, gi.price_per_day, gi.price_per_week, gi.price_per_month,
             gi.insurance_cost_per_day, gi.partner_id
      FROM gear_items gi
      WHERE gi.id = $1 AND ${publicGearSql('gi')}
    `, [gearId]);

    if (gearResult.rows.length === 0) {
      return fail(404, 'Снаряжение не найдено');
    }
    const gear = gearResult.rows[0];

    const pricePerDay = Number(gear.price_per_day);
    if (!Number.isFinite(pricePerDay) || pricePerDay < 0) {
      return fail(500, 'Ошибка конфигурации цен снаряжения');
    }

    const price = calcGearPrice({
      days: rentalDays,
      quantity: rental.quantity,
      pricePerDay,
      pricePerWeek: gear.price_per_week != null ? Number(gear.price_per_week) : null,
      pricePerMonth: gear.price_per_month != null ? Number(gear.price_per_month) : null,
      insurancePerDay: gear.insurance_cost_per_day != null ? Number(gear.insurance_cost_per_day) : null,
      insurance: rental.insurance,
    });

    if (price.insuranceUnavailable) {
      return fail(400, 'Для этой позиции страховка недоступна — уберите галку страховки');
    }

    const consent = buildConsentRecord(true, getTrustedClientIp(request.headers), 'gear-page', 'gear');

    const outcome: RentalOutcome = await transaction(async (client) => {
      // Порядок ключей один: сначала человек, потом позиция. Подтверждение
      // заявки (PATCH) берёт только ключ позиции — цикла ожиданий нет.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1::text))`, [`gear-user:${userId}`]);
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1::text))`, [gearId]);

      const openResult = await client.query<{ open_requests: number }>(OPEN_GEAR_REQUESTS_SQL, [userId]);
      if (Number(openResult.rows[0]?.open_requests ?? 0) >= MAX_OPEN_GEAR_REQUESTS_PER_USER) {
        return { code: 'too_many_open' };
      }

      const peakResult = await client.query<{ peak_rented: string }>(
        gearPeakSql({ gear: '$1', start: '$2::date', endExclusive: '$3::date' }),
        [gearId, rental.startDate, rental.endDate]
      );
      const peakRented = parseInt(peakResult.rows[0]?.peak_rented ?? '0', 10);
      if (peakRented + rental.quantity > gear.quantity) {
        return { code: 'conflict', free: Math.max(0, gear.quantity - peakRented) };
      }

      const inserted = await client.query<{ id: string }>(`
        INSERT INTO gear_rentals (
          id, gear_id, user_id, customer_name, customer_email, customer_phone,
          start_date, end_date, quantity, days_count, insurance,
          base_price, insurance_cost, total_price, comments, status, created_at,
          pd_consent_at, pd_consent_ip, pd_consent_source, pd_consent_version
        ) VALUES (
          gen_random_uuid(),
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'pending', NOW(),
          $15, $16, $17, $18
        ) RETURNING id
      `, [
        gearId,
        userId,
        customer.name,
        customer.email,
        customer.phone,
        rental.startDate,
        rental.endDate,
        rental.quantity,
        rentalDays,
        Boolean(rental.insurance) && price.insuranceCost > 0,
        price.basePrice,
        price.insuranceCost,
        price.totalPrice,
        comments || null,
        consent?.at ?? null,
        consent?.ip ?? null,
        consent?.source ?? null,
        consent?.version ?? null,
      ]);
      return { code: 'created', rentalId: inserted.rows[0].id };
    });

    if (outcome.code === 'too_many_open') {
      return fail(
        429,
        `У вас уже ${MAX_OPEN_GEAR_REQUESTS_PER_USER} заявки на прокат ждут ответа. Новую можно отправить, `
        + `когда прокат ответит на одну из них, — или через ${GEAR_PENDING_HOLD_HOURS} часов, `
        + 'когда заявка без ответа перестанет держать снаряжение.'
      );
    }

    if (outcome.code === 'conflict') {
      return fail(
        409,
        outcome.free > 0
          ? `На выбранные даты свободно только ${outcome.free} шт.`
          : 'На выбранные даты снаряжение уже занято'
      );
    }

    const rentalId = outcome.rentalId;

    // Клиент проката в CRM (#2325); молча для заказа, отказ пишет сам хук.
    await linkContactQuietly('gear_rental', rentalId);

    // Админ узнаёт о заявке всегда, прокат — когда позиция за ним записана.
    // Сбой уведомления заявку не отменяет, но называется в логе (§4.0).
    let partnerChat: { telegram_chat_id: string | null; max_chat_id: string | null } | null = null;
    if (gear.partner_id) {
      partnerChat = await query<{ telegram_chat_id: string | null; max_chat_id: string | null }>(
        `SELECT telegram_chat_id, max_chat_id::text AS max_chat_id FROM partners WHERE id = $1`,
        [gear.partner_id]
      )
        .then((r) => r.rows[0] ?? null)
        .catch((err: unknown) => {
          logSwallowedFailure('gear-rentals', 'чтение адреса проката для уведомления', err);
          return null;
        });
    }
    notifyNewGearRental({
      rentalId,
      gearName: gear.name,
      quantity: rental.quantity,
      startDate: rental.startDate,
      endDate: rental.endDate,
      totalPrice: price.totalPrice,
      customerName: customer.name,
      customerPhone: customer.phone,
      partnerChatId: partnerChat?.telegram_chat_id ?? null,
      partnerMaxChatId: partnerChat?.max_chat_id ?? null,
    }).catch((err: unknown) => logSwallowedFailure('gear-rentals', 'уведомление о заявке', err));

    return NextResponse.json({
      success: true,
      data: {
        rentalId,
        totalPrice: price.totalPrice,
        message: 'Заявка на аренду создана успешно',
      }
    } as ApiResponse<{ rentalId: string; totalPrice: number; message: string }>);

  } catch (error) {
    logSwallowedFailure('gear-rentals', 'создание заявки на аренду', error);
    return fail(500, 'Ошибка создания заявки на аренду');
  }
}

/**
 * GET /api/gear/rentals - Получение списка заявок на аренду (для администратора)
 */
export async function GET(request: NextRequest) {
  try {
    const userOrResponse = await requireAuth(request);
    if (userOrResponse instanceof NextResponse) {
      return userOrResponse;
    }

    const userId = userOrResponse.userId;
    if (!userId) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' } as ApiResponse<null>,
        { status: 401 }
      );
    }

    const isAdmin = userOrResponse.role === 'admin';
    const partnerId = isAdmin ? null : await getGearPartnerId(userId);
    if (!isAdmin && !partnerId) {
      return NextResponse.json(
        { success: false, error: 'Профиль партнёра не найден' } as ApiResponse<null>,
        { status: 404 }
      );
    }

    const { searchParams } = new URL(request.url);
    const status = searchParams.get('status');
    const parsedLimit = Number.parseInt(searchParams.get('limit') || '50', 10);
    const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), 100) : 50;
    const allowedStatuses = new Set(['pending', 'confirmed', 'active', 'completed', 'cancelled', 'overdue']);

    if (status && !allowedStatuses.has(status)) {
      return NextResponse.json(
        { success: false, error: 'Некорректный статус' } as ApiResponse<null>,
        { status: 400 }
      );
    }

    let queryText = `
      SELECT
        gr.id,
        gr.gear_id,
        gr.customer_name,
        gr.customer_email,
        gr.customer_phone,
        gr.start_date,
        gr.end_date,
        gr.quantity,
        gr.days_count,
        gr.insurance,
        gr.base_price,
        gr.insurance_cost,
        gr.total_price,
        gr.comments,
        gr.status,
        gr.created_at,
        g.name as gear_name,
        g.category as gear_category
      FROM gear_rentals gr
      JOIN gear_items g ON gr.gear_id = g.id
    `;

    const params: (string | number)[] = [];
    const whereConditions: string[] = [];

    // Бизнес-правило: партнёр видит только свои заявки, admin — все.
    if (!isAdmin && partnerId) {
      whereConditions.push(`g.partner_id = $${params.length + 1}`);
      params.push(partnerId);
    }

    // Фильтр по статусу
    if (status) {
      whereConditions.push(`gr.status = $${params.length + 1}`);
      params.push(status);
    }

    if (whereConditions.length > 0) {
      queryText += ` WHERE ${whereConditions.join(' AND ')}`;
    }

    queryText += ` ORDER BY gr.created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await query(queryText, params);

    return NextResponse.json({
      success: true,
      data: {
        rentals: result.rows,
        count: result.rows.length
      }
    } as ApiResponse<unknown>);

  } catch (error) {
    logSwallowedFailure('gear-rentals', 'список заявок на аренду', error);
    return NextResponse.json(
      { success: false, error: 'Ошибка получения заявок на аренду' } as ApiResponse<null>,
      { status: 500 }
    );
  }
}
