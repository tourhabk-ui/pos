/**
 * POST /api/preparation/share — создать брифинг похода по ссылке.
 *
 * План подготовки живёт локально на устройстве (anonymous-first). Здесь он
 * впервые получает серверное хранение — ровно в тот момент, когда в нём
 * появляется смысл: планом делятся с контактом вне маршрута.
 *
 * Отдаём ссылку, а не отправляем сообщение: контактных данных получателя мы
 * не собираем (см. миграцию 870). Координат в снимке нет — брифинг про план
 * и время возврата, не про положение.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { pool } from '@/lib/db-pool';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';
import { briefingExpiry } from '@/lib/preparation/briefing';

export const dynamic = 'force-dynamic';

// Ссылка создаётся человеком руками — десяти в час хватает с запасом,
// а массовую генерацию токенов анонимом это останавливает.
const limiter = createRateLimiter({ windowMs: 3_600_000, max: 10 });

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const BodySchema = z.object({
  routeId: z.string().uuid(),
  routeVersion: z.number().int().min(1).max(100_000).optional(),
  departureAt: z.string().regex(ISO_DATE).nullable().optional(),
  returnBy: z.string().datetime().nullable().optional(),
  answers: z.object({
    duration: z.enum(['under_4h', 'day', 'overnight', 'multi_day']).optional(),
    party: z.enum(['solo', 'group', 'guided']).optional(),
    experience: z.enum(['first_time', 'some', 'confident']).optional(),
    ownership: z.enum(['own_all', 'partial_rent', 'need_advice']).optional(),
  }).default({}),
  // Снимок собирается на клиенте (состояние пакета известно только ему) и
  // здесь проверяется по форме: лишние поля отсекаются, координаты не
  // предусмотрены схемой вовсе — их нельзя передать даже намеренно.
  snapshot: z.object({
    routeTitle: z.string().min(1).max(200),
    routeVersion: z.number().int().min(1),
    routeGrade: z.string().max(40),
    waypointsCount: z.number().int().min(0).max(10_000),
    departureAt: z.string().nullable(),
    returnBy: z.string().nullable(),
    duration: z.string().nullable(),
    party: z.string().nullable(),
    packReadiness: z.enum(['ready', 'partial', 'not_ready', 'unknown']),
    preparedDomains: z.number().int().min(0).max(50),
    totalDomains: z.number().int().min(0).max(50),
    openActions: z.array(z.string().max(200)).max(20),
    takenAt: z.string(),
  }).strict(),
});

export async function POST(request: NextRequest) {
  if (!limiter.check(getClientIp(request.headers))) {
    return NextResponse.json(
      { success: false, error: 'Слишком много ссылок — попробуйте через час' },
      { status: 429 },
    );
  }

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ success: false, error: 'Неверный JSON' }, { status: 400 });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Неверные данные' },
      { status: 400 },
    );
  }

  const { routeId, departureAt, returnBy, answers, snapshot } = parsed.data;

  try {
    // id из клиента — в пространстве VIEW (COALESCE(ark_id, id)), а FK плана
    // смотрит на kamchatka_routes.id. Резолвим по обоим, иначе маршрут с
    // заполненным ark_id не сохранится (тот же разрыв, что чинил этап 1).
    const routeRes = await pool.query<{ id: string; route_version: number }>(
      `SELECT id, COALESCE(route_version, 1) AS route_version
         FROM kamchatka_routes
        WHERE (id = $1 OR ark_id = $1) AND is_visible = TRUE
        LIMIT 1`,
      [routeId],
    );
    const route = routeRes.rows[0];
    if (!route) {
      return NextResponse.json({ success: false, error: 'Маршрут не найден' }, { status: 404 });
    }

    const planRes = await pool.query<{ id: string }>(
      `INSERT INTO trip_preparation_plans
         (route_id, route_version, departure_at, duration_type, party_size, experience, ownership)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        route.id,
        route.route_version,
        departureAt ?? null,
        answers.duration ?? null,
        answers.party ?? null,
        answers.experience ?? null,
        answers.ownership ?? null,
      ],
    );
    const planId = planRes.rows[0].id;

    const expiresAt = briefingExpiry(returnBy ?? null);

    const shareRes = await pool.query<{ token: string; expires_at: string }>(
      `INSERT INTO trip_preparation_shares (plan_id, snapshot, scope, expires_at)
       VALUES ($1, $2::jsonb, 'briefing', $3)
       RETURNING token, expires_at`,
      [planId, JSON.stringify(snapshot), expiresAt.toISOString()],
    );

    await pool.query(
      `INSERT INTO trip_preparation_events (plan_id, event_type, actor, metadata)
       VALUES ($1, 'briefing_shared', 'user', $2::jsonb)`,
      [planId, JSON.stringify({ scope: 'briefing' })],
    ).catch(() => { /* журнал не критичен для выдачи ссылки */ });

    return NextResponse.json({
      success: true,
      data: {
        token: shareRes.rows[0].token,
        expiresAt: shareRes.rows[0].expires_at,
        path: `/briefing/${shareRes.rows[0].token}`,
      },
    });
  } catch {
    return NextResponse.json({ success: false, error: 'Не удалось создать ссылку' }, { status: 500 });
  }
}
