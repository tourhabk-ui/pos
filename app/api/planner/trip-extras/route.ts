/**
 * POST /api/planner/trip-extras — настоящие предложения к плану поездки.
 *
 * Решение владельца 26.09: на шаге «Как хотите ехать» человек отмечает, что
 * ещё нужно (жильё, трансфер, машина), и в результате видит НАСТОЯЩИЕ
 * варианты с платформы, а не оценку:
 *   - жильё — объекты витрины в зоне ночёвки, свободные на ночи плана;
 *   - трансфер — опубликованные поездки перевозчиков на даты поездки с
 *     местами на всю группу;
 *   - машина — честное «пока нет».
 *
 * Отдельным роутом, а не полем /api/planner/recommend: план правится на
 * экране (перестановка, удаление дней), и предложения пересчитываются по
 * ТЕКУЩИМ дням, а не по тем, что вернул движок.
 *
 * Публичный (планер работает без входа) — поэтому лимитер. Персональных
 * данных не принимает и не отдаёт: дни плана, даты, число мест.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';
import { ZONE_IDS, ZONE_NAMES } from '@/lib/planner/constants';
import { lodgingStays, groupSeats, CAR_RENTAL_ANSWER } from '@/lib/planner/trip-extras';
import {
  findLodgingForStay, countUnzonedPublicLodging, findTransfers,
} from '@/lib/planner/trip-extras-data';

export const dynamic = 'force-dynamic';

const extrasLimiter = createRateLimiter({ windowMs: 60_000, max: 20 });

/** Потолок окна трансферов — тот же, что у витрины /api/carrier-trips. */
const MAX_TRANSFER_WINDOW_DAYS = 60;
/** Больше стоянок в одном плане не бывает; потолок держит число запросов. */
const MAX_STAYS = 8;

const DaySchema = z.object({
  day: z.number().int().min(1).max(60),
  type: z.enum(['arrival', 'activity', 'travel', 'rest', 'buffer', 'departure']),
  zone: z.enum(ZONE_IDS),
  lodgingIncluded: z.boolean().nullable().optional(),
});

const TripExtrasSchema = z.object({
  needs: z.object({
    lodging: z.boolean().optional(),
    transfer: z.boolean().optional(),
    car: z.boolean().optional(),
  }),
  arrivalDate: z.string().date().optional(),
  departureDate: z.string().date().optional(),
  adults: z.number().int().min(1).max(20).default(1),
  children: z.array(z.number().int().min(0).max(17)).max(10).default([]),
  days: z.array(DaySchema).max(60).default([]),
});

export async function POST(req: NextRequest) {
  if (!extrasLimiter.check(getClientIp(req.headers))) {
    return NextResponse.json({ success: false, error: 'Слишком много запросов' }, { status: 429 });
  }

  let body: unknown;
  try { body = await req.json(); } catch {
    return NextResponse.json({ success: false, error: 'Некорректный JSON' }, { status: 400 });
  }
  const parsed = TripExtrasSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: 'Некорректные параметры' }, { status: 400 });
  }
  const { needs, arrivalDate, departureDate, adults, children, days } = parsed.data;
  if (arrivalDate && departureDate && departureDate <= arrivalDate) {
    return NextResponse.json(
      { success: false, error: 'Дата отъезда должна быть позже даты прилёта' },
      { status: 400 },
    );
  }
  const hasDates = Boolean(arrivalDate && departureDate);

  const data: Record<string, unknown> = {};

  if (needs.lodging) {
    if (!hasDates || !arrivalDate) {
      data.lodging = { state: 'no_dates' };
    } else {
      const { stays, nightsInTours } = lodgingStays(days, arrivalDate, departureDate);
      const shown = stays.slice(0, MAX_STAYS);
      const [results, unzonedCount] = await Promise.all([
        Promise.all(shown.map((s) => findLodgingForStay(s))),
        countUnzonedPublicLodging(),
      ]);
      data.lodging = {
        state: 'checked',
        stays: shown.map((s, i) => ({ ...s, zoneName: ZONE_NAMES[s.zone], result: results[i] })),
        nightsInTours,
        unzonedCount,
      };
    }
  }

  if (needs.transfer) {
    if (!hasDates || !arrivalDate || !departureDate) {
      data.transfer = { state: 'no_dates' };
    } else {
      const spanDays = Math.round((Date.parse(departureDate) - Date.parse(arrivalDate)) / 86_400_000);
      const window = { from: arrivalDate, to: departureDate, seats: groupSeats(adults, children) };
      if (spanDays > MAX_TRANSFER_WINDOW_DAYS) {
        data.transfer = { state: 'window_too_long', window, maxDays: MAX_TRANSFER_WINDOW_DAYS };
      } else {
        const result = await findTransfers({ fromDate: window.from, toDate: window.to, seats: window.seats });
        data.transfer = { ...result, window };
      }
    }
  }

  if (needs.car) {
    data.car = CAR_RENTAL_ANSWER;
  }

  return NextResponse.json({ success: true, data });
}
