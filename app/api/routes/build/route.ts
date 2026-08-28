/**
 * POST /api/routes/build — построение пути Origin → Destination (владелец
 * 28.08, PR 5A/5B-1). Единственная дверь наружу: браузер сюда шлёт
 * координаты, а провайдера — если/когда он появится — зовёт СЕРВЕР.
 * Ключи, лимиты, ошибки провайдера наружу не выходят (решение владельца:
 * «разрешить через серверный адаптер, не вызывать провайдера напрямую из
 * браузера»).
 *
 * Отвечает RouteBuildResult (lib/on-route/route-build.ts) — тем же типом,
 * что уже понимает экран (PR 5A). Режимы: foot — не построен (5B-2,
 * нужна сеть троп, здесь её нет — честный unsupported, а не тихая линия
 * напрямую); car — зовёт CarRouteProvider (lib/on-route/route-provider.ts).
 * Сегодня единственная реализация провайдера — notWiredCarRouteProvider:
 * источник маршрутизации владелец сознательно не выбрал (28.08), и это
 * честно доходит до пользователя как «недоступно», а не выдумывается.
 *
 * Публичный: строить путь может кто угодно, планирующий поездку — как и
 * поиск маршрутов (/api/routes/search). Rate-limit — не от злоупотребления
 * деньгами (провайдер ещё не подключён и денег не стоит), а чтобы этот
 * эндпоинт с самого начала жил по тем же правилам, что будет обязан
 * соблюдать после подключения платного источника.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';
import { notWiredCarRouteProvider } from '@/lib/on-route/route-provider';
import type { RouteBuildResult } from '@/lib/on-route/route-build';
import {
  KRAI_LAT_MIN, KRAI_LAT_MAX, KRAI_LNG_MIN, KRAI_LNG_MAX,
} from '@/app/api/cron/place-coords/route';

export const dynamic = 'force-dynamic';

const limiter = createRateLimiter({ windowMs: 60_000, max: 20 });

const OriginSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('current'), lat: z.number(), lon: z.number(), accuracyM: z.number().optional() }),
  z.object({ kind: z.literal('coordinate'), lat: z.number(), lon: z.number(), title: z.string().optional() }),
  z.object({ kind: z.literal('place'), id: z.string(), title: z.string(), lat: z.number(), lon: z.number() }),
]);

const DestinationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('place'), id: z.string(), title: z.string(), lat: z.number(), lon: z.number() }),
  z.object({ kind: z.literal('coordinate'), lat: z.number(), lon: z.number(), title: z.string().optional() }),
]);

const BodySchema = z.object({
  origin: OriginSchema,
  destination: DestinationSchema,
  mode: z.enum(['foot', 'car']),
});

/** Грубый конверт края — фильтр от нулей и перепутанных координат, не проверка правды (§4.1 CLAUDE.md). */
function inKrai(lat: number, lng: number): boolean {
  return lat >= KRAI_LAT_MIN && lat <= KRAI_LAT_MAX && lng >= KRAI_LNG_MIN && lng <= KRAI_LNG_MAX;
}

function unsupported(reason: string): NextResponse {
  const result: RouteBuildResult = { status: 'unsupported', reason };
  return NextResponse.json({ success: true, result });
}

export async function POST(request: NextRequest) {
  if (!limiter.check(getClientIp(request.headers))) {
    return NextResponse.json({ success: false, error: 'Слишком много запросов — подождите минуту' }, { status: 429 });
  }

  let body: z.infer<typeof BodySchema>;
  try {
    const raw = await request.json();
    body = BodySchema.parse(raw);
  } catch {
    return NextResponse.json({ success: false, error: 'Некорректные origin/destination/mode' }, { status: 400 });
  }

  const { origin, destination, mode } = body;
  if (!inKrai(origin.lat, origin.lon) || !inKrai(destination.lat, destination.lon)) {
    return unsupported('Точка вне Камчатского края — маршрутизация здесь не предлагается.');
  }

  if (mode === 'foot') {
    return unsupported('Пеший путь по бездорожью платформа не строит — только по известной сети троп (следующий шаг, PR 5B-2).');
  }

  // mode === 'car'
  const providerResult = await notWiredCarRouteProvider.route({
    originLat: origin.lat, originLon: origin.lon,
    destLat: destination.lat, destLon: destination.lon,
  });

  const result: RouteBuildResult =
    providerResult.status === 'not_wired'
      ? { status: 'unsupported', reason: providerResult.message }
      : { status: 'failed', retryable: providerResult.retryable, message: providerResult.message };

  return NextResponse.json({ success: true, result });
}
