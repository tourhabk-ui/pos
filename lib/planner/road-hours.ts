/**
 * lib/planner/road-hours.ts — оценка дороги между двумя точками для планера.
 *
 * Поверх своего дорожного графа (lib/routing/road-graph-route, тот же, что у
 * /api/routing/path). Часы — оценка некалиброванной модели скоростей, и
 * строки плана так и говорят (lib/planner/road-reach).
 *
 * Память на процесс — по паре точек: дорожный граф — статичные данные
 * (миграция 760), а не наличие мест; кэшировать здесь можно.
 * Отказ графа — `unread` («не знаем»), а не «дороги нет».
 */
import { roadGraphRoute } from '@/lib/routing/road-graph-route';
import type { RoadEstimate } from '@/lib/planner/road-reach';

const MEMO_MAX = 500;
const TIMEOUT_MS = 8_000;
const memo = new Map<string, Promise<RoadEstimate>>();

const key = (a: [number, number], b: [number, number]) =>
  `${a[0].toFixed(3)},${a[1].toFixed(3)}>${b[0].toFixed(3)},${b[1].toFixed(3)}`;

async function compute(a: [number, number], b: [number, number]): Promise<RoadEstimate> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Отказ графа после таймаута не должен стать необработанным отказом
    // (Bugbot #3713): ошибка ловится на самом обещании и становится «не знаем».
    const route = roadGraphRoute(a[0], a[1], b[0], b[1], 'car').catch((err: unknown) => {
      console.error('[planner/road-hours] дорожный граф не ответил:', err instanceof Error ? err.message : String(err));
      return null;
    });
    const r = await Promise.race([
      route,
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), TIMEOUT_MS); }),
    ]);
    if (r === null) return { kind: 'unread' };
    if (r.ok) return { kind: 'road', km: r.distanceM / 1000, hours: r.durationS / 3600 };
    // Пустой граф — данных нет, это «не знаем», а не «дороги нет».
    return r.reason === 'empty_graph' ? { kind: 'unread' } : { kind: 'no_road' };
  } catch (err) {
    console.error('[planner/road-hours] дорожный граф не ответил:', err instanceof Error ? err.message : String(err));
    return { kind: 'unread' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Дорога от `a` до `b` ([lat, lng]). */
export function roadEstimate(a: [number, number], b: [number, number]): Promise<RoadEstimate> {
  const k = key(a, b);
  const hit = memo.get(k);
  if (hit) return hit;
  const p = compute(a, b).then((e) => {
    // «Не знаем» не запоминается: следующий план спросит граф снова.
    if (e.kind === 'unread') memo.delete(k);
    return e;
  });
  if (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value as string);
  memo.set(k, p);
  return p;
}
