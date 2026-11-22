/**
 * POST /api/planner/itinerary — «Подробная программа» по кнопке (фича 7,
 * слово владельца 23.11: план показывать сразу, программу — по кнопке).
 *
 * Один вызов модели на нажатие (дневной стоп бюджета — в callAIWithModelDirect).
 * Только после входа, лимит 5 в минуту. На вход — только поля, из которых
 * собирается текст: заголовки, зоны, оператор, цена, прогноз, предупреждения;
 * длины ограничены. Ни БД, ни занятости здесь нет.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { plannerSession } from '@/lib/planner/require-session';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';
import { scrubItineraryInput } from '@/lib/planner/itinerary-input';
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
    type: z.string().max(20),
    title: z.string().max(200),
    zone: ZONE,
    realTour: z.object({ operatorName: z.string().max(120), priceUnit: z.string().max(40).optional() }).optional(),
    realPrice: z.number().min(0).max(10_000_000).optional(),
    priceMissing: z.string().max(200).optional(),
    weatherForecast: z.object({ description: z.string().max(60), tempMin: z.number(), tempMax: z.number() }).optional(),
  })).min(1).max(40),
  warnings: z.array(z.object({
    type: z.string().max(30),
    severity: z.enum(['critical', 'important', 'info']),
    message: z.string().max(600),
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
  const { days, warnings } = scrubItineraryInput(parsed.data.days, parsed.data.warnings);
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
