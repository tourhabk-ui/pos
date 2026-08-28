/**
 * POST /api/routes/build — построение пути Origin → Destination (владелец
 * 28.08, PR 5A/5B-1/«свой роутер»). Единственная дверь наружу: браузер сюда
 * шлёт координаты, а провайдера зовёт СЕРВЕР. Ключи, лимиты, ошибки
 * провайдера наружу не выходят (решение владельца: «разрешить через
 * серверный адаптер, не вызывать провайдера напрямую из браузера»).
 *
 * Отвечает RouteBuildResult (lib/on-route/route-build.ts) — тем же типом,
 * что уже понимает экран (PR 5A). Режимы: foot — не построен (5B-2,
 * нужна сеть троп для произвольной точки, здесь этого шага нет — честный
 * unsupported, а не тихая линия напрямую); car — зовёт CarRouteProvider
 * (lib/on-route/route-provider.ts), пропускает ответ через applySnapGuard
 * (ненадёжная привязка к дороге → not_found, не рисованный путь) и
 * нормализует found/not_found/error в RouteBuildResult.
 *
 * Провайдер для car — `roadGraphCarProvider`
 * (lib/on-route/road-graph-car-provider.ts): свой дорожный граф Камчатки
 * (миграция 760, решение владельца 2026-07-20 «без внешних роутинг-API,
 * офлайн-first»), не внешний Yandex/2ГИС и не bake-off — от них решено
 * отказаться 28.08 в пользу уже существующей инфраструктуры. Качество и
 * охват графа — отдельный, не блокирующий эту правку вопрос ДАННЫХ, не
 * архитектуры: там, где дорог в графе нет, провайдер честно отвечает
 * not_found, а не рисует то, чего нет.
 *
 * Публичный: строить путь может кто угодно, планирующий поездку — как и
 * поиск маршрутов (/api/routes/search). Rate-limit — свой роутер не стоит
 * денег за вызов, но эндпоинт живёт по тем же правилам, что и любой другой
 * публичный API платформы.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';
import { applySnapGuard } from '@/lib/on-route/route-provider';
import { roadGraphCarProvider } from '@/lib/on-route/road-graph-car-provider';
import type { RouteBuildResult } from '@/lib/on-route/route-build';
import type { RouteOption } from '@/lib/on-route/destination';
import {
  KRAI_LAT_MIN, KRAI_LAT_MAX, KRAI_LNG_MIN, KRAI_LNG_MAX,
} from '@/app/api/cron/place-coords/route';

export const dynamic = 'force-dynamic';
// Настоящая работа с БД и A* теперь идёт здесь (не мгновенный ответ
// заглушки) — тот же запас, что у /api/routing/path.
export const maxDuration = 30;

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
  const raw = await roadGraphCarProvider.route({
    originLat: origin.lat, originLon: origin.lon,
    destLat: destination.lat, destLon: destination.lon,
  });
  // Единая политика на все будущие адаптеры — см. lib/on-route/route-provider.ts:
  // найденный путь с ненадёжной привязкой к дороге понижается в not_found
  // ЗДЕСЬ, один раз, а не в каждой реализации CarRouteProvider отдельно.
  const providerResult = applySnapGuard(raw);

  let result: RouteBuildResult;
  switch (providerResult.status) {
    case 'not_wired':
      result = { status: 'unsupported', reason: providerResult.message };
      break;
    case 'error':
      result = { status: 'failed', retryable: providerResult.retryable, message: providerResult.message };
      break;
    case 'not_found':
      result = { status: 'not_found', reason: providerResult.reason };
      break;
    case 'found': {
      const option: RouteOption = {
        id: 'calculated-car',
        title: 'Путь на автомобиле',
        distanceKm: providerResult.route.distanceM / 1000,
        // Намеренно null — см. lib/on-route/destination.ts: посчитанный
        // путь не снятый трек, приписывать ему грейд нельзя (§12).
        lineGrade: null,
        difficulty: null,
        elevationGainM: null,
        waypointNames: [],
        calculated: providerResult.route,
      };
      result = { status: 'found', options: [option] };
      break;
    }
  }

  return NextResponse.json({ success: true, result });
}
