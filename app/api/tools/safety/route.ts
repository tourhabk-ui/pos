/**
 * POST /api/tools/safety
 *
 * «Анализатор безопасности» (/tools/safety): оценка места или маршрута на
 * сегодня. Своих правил и модели здесь НЕТ (слово владельца 14.11): ответ
 * собран из того же, из чего собраны карточка места и карточка маршрута.
 *
 * ── Что было до 14.11 ───────────────────────────────────────
 *
 * Инструмент считал своё число риска 1–5 и просил быструю модель написать
 * три текста: оценку, до пяти «конкретных рекомендаций» и совет на случай ЧС.
 * Фактов модель получала несколько строк, а её слова не сверял никто — та же
 * форма, из-за которой 23.10 ужесточали Editor: просить деталь, не дав
 * источника, значит заказывать выдумку (§4.0). Рядом стояли ещё три
 * расхождения с карточками:
 *
 *   - у маршрута была своя оценка, не та, что на карточке («Идти / Осторожно /
 *     Не сегодня»): закрытия парка и маршрута инструмент не читал, а места
 *     «рядом» (§4.1) складывал в опасности маршрута как точки пути;
 *   - кнопка GPS брала ближайшее место по градусам, без предела расстояния и
 *     без отбора видимых: за сто километров от любого места человек получал
 *     оценку чужого места, и расстояние ему не называлось;
 *   - две оценки одного дня об одном месте — число здесь и цвет на карточке.
 *
 * ── Что теперь ──────────────────────────────────────────────
 *
 *   место    → данные карточки места (lib/places/place-detail): обстановка дня
 *              по `placeDayStatus`, профиль безопасности, код вулкана;
 *   маршрут  → оценка дня карточки маршрута (lib/routes/route-today: правила
 *              go-verdict, сигналы collect-signals) и опасности самого маршрута;
 *   GPS      → ближайшее живое место по настоящему расстоянию; дальше
 *              NEAREST_PLACE_MAX_KM оценка не показывается — называется место
 *              и расстояние («не знаем, что там, где вы стоите»).
 *
 * Экран рисует ответ теми же компонентами, что карточки
 * (components/tools/SafetyToolResult).
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { query } from '@/lib/database';
import { createRateLimiter, getClientIp } from '@/lib/rate-limit';
import { loadPlaceDetail } from '@/lib/places/place-detail';
import { NEAREST_PLACE_SQL, NEAREST_PLACE_MAX_KM } from '@/lib/places/nearby';
import { ROUTE_ROW_BY_ANY_ID_SQL } from '@/lib/routes/collect-signals';
import { routeToday } from '@/lib/routes/route-today';
import { VERDICT_LABELS } from '@/lib/routes/go-verdict';
import { insideKrai } from '@/lib/geo/krai-envelope';

export const dynamic = 'force-dynamic';

const BodySchema = z.union([
  z.object({ placeId: z.string().min(10).max(80) }),
  z.object({ routeId: z.string().uuid() }),
  z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }),
]);

// Роут открыт анониму и читает карточку места целиком (десяток запросов):
// потолок — от обхода ботом, человеку десяти оценок в минуту хватает.
const limiter = createRateLimiter({ windowMs: 60_000, max: 10 });

function logFail(what: string, err: unknown): void {
  const code = (err as { code?: unknown })?.code;
  console.error(
    `[tools/safety] ${what}:`,
    typeof code === 'string' ? `SQLSTATE=${code.slice(0, 10)}` : 'SQLSTATE=нет',
    err instanceof Error ? err.message.slice(0, 160) : 'ошибка без текста',
  );
}

const fail = (error: string, status: number) => NextResponse.json({ success: false, error }, { status });
const ok = (data: Record<string, unknown>) => NextResponse.json({ success: true, data });

/** Данные карточки места — только то, что рисует экран инструмента. */
async function placeAnswer(id: string, distanceKm: number | null): Promise<NextResponse> {
  const loaded = await loadPlaceDetail(id, { countView: false });
  const d = loaded.body.data;
  if (loaded.status !== 200 || !d) {
    // Три исхода загрузчика доезжают как есть: «не найдено» — не «сбой».
    return fail(loaded.body.error ?? 'Место не прочиталось', loaded.status === 200 ? 500 : loaded.status);
  }
  return ok({
    kind: 'place',
    distanceKm,
    place: {
      id: d.id,
      name: d.name,
      locationType: d.locationType ?? null,
      safety: d.safety,
      realtime: d.realtime ?? null,
      volcanoStatus: d.volcanoStatus ?? null,
      eco: d.eco ?? null,
    },
  });
}

async function gpsAnswer(lat: number, lng: number): Promise<NextResponse> {
  // Конверт края — один на платформу (lib/geo/krai-envelope). Прежняя своя
  // рамка этого роута (широта до 58°, долгота до 165°) оставляла снаружи север
  // края и Командоры.
  if (insideKrai(lat, lng) !== true) {
    return ok({ kind: 'outside' });
  }
  let rows: Array<Record<string, unknown>>;
  try {
    rows = (await query(NEAREST_PLACE_SQL, [lat, lng])).rows as Array<Record<string, unknown>>;
  } catch (err) {
    logFail('ближайшее место не прочиталось', err);
    return fail('Ближайшее место не прочиталось — попробуйте ещё раз', 500);
  }
  const nearest = rows[0];
  if (!nearest) return ok({ kind: 'none' });

  const km = Number(nearest.km);
  if (!Number.isFinite(km)) {
    logFail('расстояние до ближайшего места не число', new Error(String(nearest.km)));
    return fail('Ближайшее место не прочиталось — попробуйте ещё раз', 500);
  }
  if (km > NEAREST_PLACE_MAX_KM) {
    return ok({
      kind: 'far',
      nearest: {
        id: String(nearest.id),
        slug: (nearest.slug as string | null) ?? null,
        name: String(nearest.name),
        locationType: (nearest.location_type as string | null) ?? null,
        distanceKm: Math.round(km),
      },
    });
  }
  // До километра — «рядом», без ложной точности; дальше — целые километры.
  return placeAnswer(String(nearest.id), km < 1 ? 0 : Math.round(km));
}

async function routeAnswer(routeId: string): Promise<NextResponse> {
  let route: Record<string, unknown> | undefined;
  let rowId: string | undefined;
  try {
    // У маршрута два id (lib/routes/collect-signals): поиск отдаёт id карточки —
    // COALESCE(ark_id, id), а строка, её путевые точки и закрытия живут на
    // kamchatka_routes.id. Правило «какая строка» — общее с карточкой.
    rowId = (await query(ROUTE_ROW_BY_ANY_ID_SQL, [routeId])).rows[0]?.id as string | undefined;
    if (!rowId) return fail('Маршрут не найден', 404);

    // Видимость — как у карточки: её представление берёт строки без
    // merged_into_id и показывает только is_visible. mchs_phone не читается
    // намеренно: региональный номер — только из lib/safety/emergency-numbers.
    route = (await query(
      `SELECT COALESCE(ark_id, id)::text AS card_id, title, hazards, mchs_registration_required
         FROM kamchatka_routes
        WHERE id = $1::uuid AND merged_into_id IS NULL AND is_visible = TRUE
        LIMIT 1`,
      [rowId],
    )).rows[0] as Record<string, unknown> | undefined;
  } catch (err) {
    logFail('маршрут не прочитался', err);
    return fail('Маршрут не прочитался — попробуйте ещё раз', 500);
  }
  if (!route) return fail('Маршрут не найден', 404);

  // Оценка — та же, что на карточке маршрута и в ответе Кузьмича. Сбой сбора
  // сигналов route-today превращает в «Осторожно — данных мало», а не в «Идти».
  const today = await routeToday(rowId);

  return ok({
    kind: 'route',
    route: {
      cardId: String(route.card_id),
      title: String(route.title),
      hazards: Array.isArray(route.hazards) ? (route.hazards as unknown[]).filter((h): h is string => typeof h === 'string') : [],
      registrationRequired: route.mchs_registration_required === true,
    },
    verdict: { ...today.verdict, label: VERDICT_LABELS[today.verdict.status] },
    signals: today.signals,
  });
}

export async function POST(request: NextRequest) {
  if (!limiter.check(getClientIp(request.headers))) {
    return fail('Слишком много запросов — подождите минуту', 429);
  }

  let body: unknown;
  try { body = await request.json(); } catch {
    return fail('Неверный JSON', 400);
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return fail('Нужно место (placeId), маршрут (routeId) или координаты lat и lng', 400);
  }
  const data = parsed.data;

  if ('routeId' in data) return routeAnswer(data.routeId);
  if ('placeId' in data) return placeAnswer(data.placeId, null);
  return gpsAnswer(data.lat, data.lng);
}
