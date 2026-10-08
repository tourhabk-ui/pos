/**
 * Прогресс по маршруту: какую точку человек уже прошёл — и чтобы это переживало
 * закрытие экрана (скрин владельца 09.10, «На маршруте»: «повторное открытие
 * не сохраняет точку, а ставит её в рандомном месте»).
 *
 * До этого индекс текущей точки жил ТОЛЬКО в памяти экрана: `useState(0)`, а
 * после первого фикса он «прилипал» к ближайшей точке маршрута (правило 17.08,
 * см. field-entry-from-user: для того, кто стоит на тропе, это верно). Для
 * того, кто уже шёл, — нет: закрыл приложение на третьей точке из пяти, открыл
 * заново, стоя ближе к первой, — и цель прибора перескочила назад или на
 * точку, до которой ещё идти полдня. С точки зрения человека — «рандом»:
 * путь пройден, а прибор этого не помнит. След («хлебные крошки») при этом
 * сохранялся — не хватало только номера точки.
 *
 * Три исхода, не два (§4.0): сохранённого прогресса нет, он есть и годен,
 * он есть, но верить ему нельзя. Последнее называется причиной, а не
 * превращается в «нет»: устарел (старше суток — это уже другой поход),
 * маршрут стал другим (число точек не то), запись побита.
 *
 * Хранилище — localStorage: экран работает без сети (CLAUDE.md, offline-first),
 * источник истины здесь телефон, а не сервер.
 */

/** Старше этого прогресс — вчерашний поход: заново, по положению. */
export const WP_PROGRESS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface WpProgress {
  /** Индекс текущей точки (куда идём). */
  idx: number;
  /** Сколько точек было в маршруте, когда записали: другое число — другой маршрут. */
  n: number;
  /** Когда записано, мс. */
  at: number;
}

export type WpProgressRead =
  | { ok: true; idx: number }
  | { ok: false; reason: 'none' | 'stale' | 'route_changed' | 'broken' };

export function wpProgressKey(routeId: string): string {
  return `trail_wp_progress_v1_${routeId}`;
}

/** Годен ли сохранённый прогресс для маршрута из `n` точек в момент `now`. */
export function readWpProgress(
  storage: StorageLike,
  routeId: string,
  n: number,
  now: number,
): WpProgressRead {
  let raw: string | null;
  try { raw = storage.getItem(wpProgressKey(routeId)); } catch { return { ok: false, reason: 'broken' }; }
  if (raw === null) return { ok: false, reason: 'none' };

  let rec: unknown;
  try { rec = JSON.parse(raw); } catch { return { ok: false, reason: 'broken' }; }
  const r = rec as Partial<WpProgress> | null;
  if (
    !r || typeof r !== 'object'
    || !Number.isInteger(r.idx) || !Number.isInteger(r.n) || !Number.isFinite(r.at)
  ) return { ok: false, reason: 'broken' };

  const idx = r.idx as number;
  if (r.n !== n) return { ok: false, reason: 'route_changed' };
  if (idx < 0 || idx >= n) return { ok: false, reason: 'broken' };
  const age = now - (r.at as number);
  // Запись «из будущего» (часы переведены) — верить нельзя так же, как старой.
  if (age < 0 || age > WP_PROGRESS_MAX_AGE_MS) return { ok: false, reason: 'stale' };
  return { ok: true, idx };
}

/** Записать прогресс. Отказ хранилища (квота, приватный режим) — не повод ломать экран. */
export function writeWpProgress(
  storage: StorageLike,
  routeId: string,
  idx: number,
  n: number,
  now: number,
): void {
  if (!Number.isInteger(idx) || idx < 0 || idx >= n) return;
  const rec: WpProgress = { idx, n, at: now };
  try { storage.setItem(wpProgressKey(routeId), JSON.stringify(rec)); } catch { /* квота */ }
}

/** Стереть: человек начинает маршрут заново. */
export function clearWpProgress(storage: StorageLike, routeId: string): void {
  try { storage.removeItem(wpProgressKey(routeId)); } catch { /* приватный режим */ }
}
