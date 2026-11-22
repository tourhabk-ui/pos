/**
 * POST /api/planner/itinerary — «Подробная программа» по кнопке (фича 7,
 * слово владельца 23.11: план показывать сразу, программу — по кнопке).
 *
 * Один вызов модели на нажатие (дневной стоп бюджета — в callAIWithModelDirect).
 * Только после входа, лимит 5 в минуту. Свободного текста от браузера нет:
 * типы, зоны, id туров, числа. Названия туров и операторов — из БД (только
 * витрина), остальное — фразы из закрытых списков (lib/planner/itinerary-input).
 * Занятости здесь нет.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { plannerSession } from '@/lib/planner/require-session';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';
import { itineraryDays, itineraryWarnings, DAY_TYPES, type PublicTour } from '@/lib/planner/itinerary-input';
import { pool } from '@/lib/db-pool';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { aiItineraryText } from '@/lib/planner/engine';

export const dynamic = 'force-dynamic';

const limiter = createRateLimiter({ windowMs: 60_000, max: 5 });

const ZONE = z.enum(['avachinsky', 'western', 'eastern', 'northern', 'southern']);
const ISO = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Body = z.object({
  profile: z.object({
    adults: z.number().int().min(1).max(30),
    children: z.array(z.number().int().min(0).max(17)).max(10),
    fitnessLevel: z.enum(['beginner', 'moderate', 'active']),
    budgetTier: z.enum(['economy', 'comfort', 'premium']),
    arrivalDate: ISO.optional(),
    departureDate: ISO.optional(),
  }),
  zones: z.array(z.object({ zone: ZONE, score: z.number().min(0).max(100) })).max(5),
  days: z.array(z.object({
    day: z.number().int().min(1).max(60),
    type: z.enum(DAY_TYPES),
    zone: ZONE,
    activityType: z.string().regex(/^[a-z_]{1,30}$/).optional(),
    tourId: z.string().regex(/^[A-Za-z0-9-]{1,64}$/).optional(),
    realPrice: z.number().min(0).max(10_000_000).optional(),
    priceMissing: z.boolean().optional(),
    temp: z.object({ min: z.number().min(-60).max(50), max: z.number().min(-60).max(50) }).optional(),
  }).strict()).min(1).max(40),
  warnings: z.array(z.object({
    type: z.string().max(30),
    severity: z.enum(['critical', 'important', 'info']),
  })).max(30),
});

type Args = Parameters<typeof aiItineraryText>;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await plannerSession(req);
  if (session instanceof NextResponse) return session;
  if (!limiter.check(`${session.userId}:${getClientIp(req.headers)}`)) {
    return NextResponse.json({ success: false, error: 'Слишком часто — подождите минуту.' }, { status: 429 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'План пришёл не целиком — обновите страницу.' }, { status: 400 });
  }
  const { profile, zones } = parsed.data;
  const tourIds = [...new Set(parsed.data.days.map((d) => d.tourId).filter((id): id is string => Boolean(id)))];
  const tours = new Map<string, PublicTour>();
  if (tourIds.length > 0) {
    try {
      const { rows } = await pool.query<{ id: string; title: string; operator_name: string; price_unit: string | null }>(
        `SELECT ot.id::text AS id, ot.title, p.name AS operator_name, ot.price_unit
           FROM operator_tours ot JOIN partners p ON p.id = ot.operator_id
          WHERE ot.id::text = ANY($1::text[]) AND ${publicTourSql('ot')}`,
        [tourIds],
      );
      for (const r of rows) tours.set(r.id, { id: r.id, title: r.title, operatorName: r.operator_name, priceUnit: r.price_unit });
    } catch (err) {
      console.error('[planner/itinerary] туры плана не прочитаны:', err instanceof Error ? err.message : String(err));
      return NextResponse.json({ success: false, error: 'Не смогли прочитать туры плана — программу не писали. Попробуйте ещё раз.' }, { status: 503 });
    }
  }
  const days = itineraryDays(parsed.data.days, tours);
  const warnings = itineraryWarnings(parsed.data.warnings);
  const t0 = performance.now();
  const text = await aiItineraryText(profile as unknown as Args[0], zones as unknown as Args[1], days as unknown as Args[2], warnings as unknown as Args[3]);
  const ms = Math.round(performance.now() - t0);
  console.info(`[planner/itinerary] этапы, мс: ai_itinerary=${ms}`);
  if (!text) {
    return NextResponse.json({ success: false, error: 'Программу написать не получилось — план от этого не меняется. Попробуйте позже.' }, {
      headers: { 'Server-Timing': `ai_itinerary;dur=${ms}` },
    });
  }
  return NextResponse.json({ success: true, text }, { headers: { 'Server-Timing': `ai_itinerary;dur=${ms}` } });
}
