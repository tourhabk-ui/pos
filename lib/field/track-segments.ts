/**
 * lib/field/track-segments.ts
 *
 * Разрез снятого трека там, где прибор молчал.
 *
 * ── Откуда ────────────────────────────────────────────────────────────────
 *
 * «Зеленовские озерки» 31.08: запись рекордера — 166 точек, один
 * <trkseg>, а внутри два провала сигнала на 87 и 273 секунды (телефон в
 * машине). Применение (POST /api/cron/track-import-queue) взяло все точки
 * подряд, и читатель соединил концы провалов прямыми на 1.9 и 6.5 км. На
 * карте вышел зигзаг через Елизово, которого никто не ехал; владелец 02.09:
 * «убери мусор и оставь только нужный трек».
 *
 * ── Что тут делается и чего нет ───────────────────────────────────────────
 *
 * Линия РЕЖЕТСЯ на куски по двум признакам — пауза во времени и скачок в
 * расстоянии. Ничего не сглаживается, не интерполируется и не «сшивается»:
 * там, где прибор молчал, пути нет, и рисовать его прямой значит выдумать
 * (§12: линия называет своё происхождение). Какой кусок оставить, решает
 * человек — функция только называет куски и их размеры. `pickSegment` с
 * правилом 'longest' — подсказка по длине, не вердикт; вызывающий обязан
 * показать все куски и то, что выброшено.
 *
 * Пороги — те же, что у самого рекордера (SEGMENT_GAP_S) и у скачка фикса
 * (MAX_SPEED_MS): свой порог здесь означал бы, что «провал» при записи и
 * «провал» при разборе — разные величины.
 */

import { haversineKm } from '@/lib/field/geo';
import { MAX_SPEED_MS, SEGMENT_GAP_S } from '@/lib/field/track-recorder';

export interface SegmentPoint {
  lat: number;
  lng: number;
  ele?: number | null;
  /** мс эпохи; null — времени нет. */
  t: number | null;
}

export type BreakReason = 'time_gap' | 'distance_jump';

export interface TrackSegment<P extends SegmentPoint = SegmentPoint> {
  /** Порядковый номер куска, с нуля. */
  index: number;
  /** Индексы в ИСХОДНОЙ линии — чтобы разрез можно было проверить глазами. */
  from: number;
  to: number;
  points: P[];
  lengthKm: number;
  /** Секунды между первой и последней точкой; null — времени нет. */
  durationS: number | null;
  /** Почему кусок начался не с начала линии; у первого — null. */
  breakBefore: { reason: BreakReason; gapS: number | null; jumpM: number } | null;
}

export interface SplitOptions {
  /** Пауза дольше этого — граница. */
  gapS?: number;
  /**
   * Скачок дальше этого — граница, даже без времени. Считается от MAX_SPEED_MS
   * за одну паузу gapS: быстрее этого за такое время не проезжают.
   */
  jumpM?: number;
}

export function splitAtGaps<P extends SegmentPoint>(
  points: readonly P[],
  opts: SplitOptions = {},
): TrackSegment<P>[] {
  const gapS = opts.gapS ?? SEGMENT_GAP_S;
  const jumpM = opts.jumpM ?? MAX_SPEED_MS * gapS;
  const out: TrackSegment<P>[] = [];
  if (points.length === 0) return out;

  let cur: P[] = [points[0]!];
  let from = 0;
  let pendingBreak: TrackSegment<P>['breakBefore'] = null;

  const flush = (to: number) => {
    out.push(measure(out.length, from, to, cur, pendingBreak));
  };

  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!;
    const p = points[i]!;
    const stepM = haversineKm(prev.lat, prev.lng, p.lat, p.lng) * 1000;
    const dtS = prev.t !== null && p.t !== null ? (p.t - prev.t) / 1000 : null;
    /**
     * Скачок судится ПО ВРЕМЕНИ, когда время есть: 6.5 км за 273 секунды —
     * это провал; 6.5 км за час — честный перегон. Без времени остаётся
     * только расстояние, и порог тогда грубее.
     */
    const jumped = dtS !== null ? (dtS > gapS || stepM > jumpM) : stepM > jumpM;
    if (jumped) {
      flush(i - 1);
      pendingBreak = {
        reason: dtS !== null && dtS > gapS ? 'time_gap' : 'distance_jump',
        gapS: dtS !== null ? Math.round(dtS) : null,
        jumpM: Math.round(stepM),
      };
      cur = [p];
      from = i;
      continue;
    }
    cur.push(p);
  }
  flush(points.length - 1);
  return out;
}

function measure<P extends SegmentPoint>(
  index: number, from: number, to: number, pts: P[], breakBefore: TrackSegment<P>['breakBefore'],
): TrackSegment<P> {
  let km = 0;
  for (let i = 1; i < pts.length; i++) {
    km += haversineKm(pts[i - 1]!.lat, pts[i - 1]!.lng, pts[i]!.lat, pts[i]!.lng);
  }
  const first = pts[0]!, last = pts[pts.length - 1]!;
  const durationS = first.t !== null && last.t !== null ? Math.round((last.t - first.t) / 1000) : null;
  return { index, from, to, points: pts, lengthKm: Math.round(km * 100) / 100, durationS, breakBefore };
}

export type SegmentChoice = 'all' | 'longest' | number;

/**
 * Какие точки применять. 'all' — линия целиком, как раньше (провалы
 * останутся прямыми — вызывающий обязан это назвать); 'longest' — самый
 * длинный кусок; число — кусок по индексу. Не найден — null.
 */
export function pickSegment<P extends SegmentPoint>(
  segments: TrackSegment<P>[],
  choice: SegmentChoice,
): TrackSegment<P> | null {
  if (segments.length === 0) return null;
  if (choice === 'all') {
    const all = segments.flatMap(s => s.points);
    return measure(-1, segments[0]!.from, segments[segments.length - 1]!.to, all, null);
  }
  if (choice === 'longest') {
    return segments.reduce((best, s) => (s.lengthKm > best.lengthKm ? s : best), segments[0]!);
  }
  return segments.find(s => s.index === choice) ?? null;
}

/** Строка для отчёта: чем кусок отделён от предыдущего. */
export function describeBreak(b: TrackSegment['breakBefore']): string | null {
  if (!b) return null;
  return b.reason === 'time_gap'
    ? `провал сигнала ${b.gapS} с, прыжок ${b.jumpM} м`
    : `прыжок ${b.jumpM} м без времени`;
}
