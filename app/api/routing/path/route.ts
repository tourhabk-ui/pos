/**
 * GET /api/routing/path
 *
 * Свой роутер (Этап 2): путь по дорожному графу Камчатки от точки А
 * к точке Б. Используется планированием маршрута — сегмент «от меня
 * до старта тропы», и (с 28.08) тем же ядром пользуется
 * `roadGraphCarProvider` — CarRouteProvider для произвольного
 * Origin → Destination в режиме 'car'.
 *
 * ?from_lat&from_lng&to_lat&to_lng&mode=car|foot
 *
 * Ответ 200 всегда (полевой UI не должен падать):
 *   ok:true  → { distance_m, duration_s, geometry: [[lat,lng],...],
 *               start_snap_m, end_snap_m, mode }
 *   ok:false → { reason, message, graph: {...} }
 *
 * snap-дистанции — честность: от точки пользователя до ближайшей дороги
 * может быть далеко, UI обязан это показать, а не рисовать враньё.
 *
 * ── Почему у отказа есть код И числа ───────────────────────────────────────
 *
 * Роутер отвечал одним `no_path` на все случаи разом. Полевая проба 11.08:
 * четыре километра по Петропавловску, на машине — `no_path`. Дороги там,
 * разумеется, есть; ответ был про наш граф, а звучал как утверждение о
 * местности. Это тот же дефект, что «0 вместо неизвестно»: отсутствие
 * результата принимает форму результата, и по нему начинают делать выводы.
 *
 * Теперь отказ говорит, какое именно из трёх разных утверждений верно —
 * дорог тут нет в графе вовсе, до дороги слишком далеко, граф рассыпан,
 * или дорога есть, но не для этого способа передвижения, — и прикладывает
 * размеры, которыми это проверяется без доступа к БД.
 *
 * Сама логика решений (bbox → узлы → привязка → A* → честная причина
 * отказа) вынесена в lib/routing/road-graph-route.ts (28.08) — этот файл
 * теперь только парсит запрос и мапит результат в JSON-контракт ниже,
 * который НЕ изменился при переносе.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { roadGraphRoute } from '@/lib/routing/road-graph-route';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

// Камчатский край (с запасом): не считаем маршруты в Магадан
const QuerySchema = z.object({
  from_lat: z.coerce.number().min(50).max(63),
  from_lng: z.coerce.number().min(154).max(168),
  to_lat: z.coerce.number().min(50).max(63),
  to_lng: z.coerce.number().min(154).max(168),
  mode: z.enum(['car', 'foot']).default('car'),
});

export async function GET(req: NextRequest): Promise<NextResponse> {
  const parsed = QuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: parsed.error.issues[0]?.message ?? 'Ошибка параметров' },
      { status: 400 },
    );
  }
  const q = parsed.data;

  try {
    const result = await roadGraphRoute(q.from_lat, q.from_lng, q.to_lat, q.to_lng, q.mode);
    if (!result.ok) {
      return NextResponse.json({
        ok: false,
        reason: result.reason,
        mode: q.mode,
        graph: result.graph,
        ...(result.start ? { start_snap_m: result.start.snapM } : {}),
        ...(result.goal ? { end_snap_m: result.goal.snapM } : {}),
        message: result.message,
      });
    }

    return NextResponse.json({
      ok: true,
      mode: result.mode,
      distance_m: result.distanceM,
      duration_s: result.durationS,
      geometry: result.geometry,
      start_snap_m: result.start.snapM,
      end_snap_m: result.goal.snapM,
    });
  } catch (e) {
    // Ошибка БД/перегруз подграфа → честный ok:false, не 500 в полевом UI
    return NextResponse.json({
      ok: false,
      reason: 'error',
      error: e instanceof Error ? e.message : 'internal',
    });
  }
}
