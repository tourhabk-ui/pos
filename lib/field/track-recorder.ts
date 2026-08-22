/**
 * Съём трека телефоном — правила приёма точек.
 *
 * Вопрос владельца 21.08: «а как нам снять трек». Это обратная сторона
 * полевой формы: форма говорит, что запись врёт, трек говорит, как на
 * самом деле. Всё остальное у платформы — чужой импорт, которому по §12
 * не положено обещать ведение.
 *
 * ── Почему не «просто писать всё, что даёт GPS» ────────────────────────────
 *
 * Приёмник врёт особым образом: он всегда выдаёт координату, даже когда
 * не знает её. Стоящий человек «проходит» за час полкилометра дрожи; под
 * скалой точка прыгает на сотни метров. Записать это как путь — значит
 * обещать ведение по линии, которой нет, то есть ровно то, против чего
 * писался §12.
 *
 * Поэтому у каждой засечки три исхода, а не два:
 *   принята   — точность в пределах, шаг осмысленный
 *   отброшена — названа причина, и она СЧИТАЕТСЯ
 *   не знаю   — точности нет вовсе: приёмник не сказал, насколько уверен
 *
 * Отброшенные считаются нарочно. Трек, где принята пятая часть засечек, —
 * это не «трек покороче», это отказ съёмки, и он обязан краснеть (§4.0).
 */

/** Хуже этой точности точка в путь не идёт: полсотни метров вбок — другой берег. */
export const ACCEPT_ACCURACY_M = 25;
/** Ближе этого к предыдущей — дрожь стоящего, а не шаг. */
export const MIN_STEP_M = 4;
/** Быстрее этого между точками — прыжок приёмника, а не движение (144 км/ч). */
export const MAX_SPEED_MS = 40;
/** Ниже этой доли принятых съёмка признаётся негодной. */
export const MIN_ACCEPTED_SHARE = 0.5;

export interface RawFix {
  lat: number;
  lng: number;
  /** Метры; null — приёмник не сказал. Это «не знаю», не «хорошо». */
  accuracy: number | null;
  /** Метры над эллипсоидом; null — нет. Именно она делает трек уликой (§12). */
  altitude: number | null;
  /** Миллисекунды эпохи. */
  t: number;
}

export type DropReason = 'accuracy' | 'jitter' | 'jump' | 'unknown_accuracy' | 'bad_number';

export interface TrackPoint {
  lat: number; lng: number; altitude: number | null; t: number; accuracy: number;
}

export interface RecorderState {
  points: TrackPoint[];
  dropped: Record<DropReason, number>;
  /** Длина принятого пути, метры. */
  lengthM: number;
}

export function emptyRecorder(): RecorderState {
  return {
    points: [],
    dropped: { accuracy: 0, jitter: 0, jump: 0, unknown_accuracy: 0, bad_number: 0 },
    lengthM: 0,
  };
}

const R_M = 6371000;

export function metersBetween(
  aLat: number, aLng: number, bLat: number, bLng: number,
): number {
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const la1 = (aLat * Math.PI) / 180;
  const la2 = (bLat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface AcceptResult {
  state: RecorderState;
  accepted: boolean;
  reason: DropReason | null;
}

/**
 * Принять или отклонить очередную засечку. Чистая функция: состояние
 * возвращается новым, поэтому съём можно проиграть по записи и проверить.
 */
export function acceptFix(state: RecorderState, fix: RawFix): AcceptResult {
  const drop = (reason: DropReason): AcceptResult => ({
    state: { ...state, dropped: { ...state.dropped, [reason]: state.dropped[reason] + 1 } },
    accepted: false,
    reason,
  });

  if (!Number.isFinite(fix.lat) || !Number.isFinite(fix.lng) ||
      Math.abs(fix.lat) > 90 || Math.abs(fix.lng) > 180) {
    return drop('bad_number');
  }
  // Приёмник не сказал, насколько уверен. Считать это хорошей точностью
  // значило бы заполнить «не знаю» удобным ответом — тем самым, против
  // чего §4.0.
  if (fix.accuracy === null || !Number.isFinite(fix.accuracy)) return drop('unknown_accuracy');
  if (fix.accuracy > ACCEPT_ACCURACY_M) return drop('accuracy');

  const prev = state.points[state.points.length - 1];
  if (prev) {
    const d = metersBetween(prev.lat, prev.lng, fix.lat, fix.lng);
    if (d < MIN_STEP_M) return drop('jitter');
    const dt = (fix.t - prev.t) / 1000;
    if (dt > 0 && d / dt > MAX_SPEED_MS) return drop('jump');
    return {
      state: {
        points: [...state.points, {
          lat: fix.lat, lng: fix.lng, altitude: fix.altitude, t: fix.t, accuracy: fix.accuracy,
        }],
        dropped: state.dropped,
        lengthM: state.lengthM + d,
      },
      accepted: true,
      reason: null,
    };
  }

  return {
    state: {
      points: [{
        lat: fix.lat, lng: fix.lng, altitude: fix.altitude, t: fix.t, accuracy: fix.accuracy,
      }],
      dropped: state.dropped,
      lengthM: 0,
    },
    accepted: true,
    reason: null,
  };
}

export type TrackQuality = 'usable' | 'poor' | 'unknown';

export interface TrackSummary {
  quality: TrackQuality;
  points: number;
  droppedTotal: number;
  acceptedShare: number | null;
  lengthKm: number;
  durationMin: number | null;
  /** Доля принятых точек, несущих высоту: ею §12 судит происхождение. */
  altitudeShare: number;
  medianAccuracyM: number | null;
  reasons: string[];
}

export function summarize(state: RecorderState): TrackSummary {
  const pts = state.points;
  const droppedTotal = Object.values(state.dropped).reduce((a, b) => a + b, 0);
  const seen = pts.length + droppedTotal;
  const acceptedShare = seen === 0 ? null : pts.length / seen;
  const withAlt = pts.filter(p => p.altitude !== null && Number.isFinite(p.altitude)).length;
  const accs = pts.map(p => p.accuracy).sort((a, b) => a - b);
  const medianAccuracyM = accs.length === 0 ? null : accs[Math.floor(accs.length / 2)];
  const durationMin = pts.length < 2 ? null
    : Math.round((pts[pts.length - 1].t - pts[0].t) / 60000);

  const reasons: string[] = [];
  if (pts.length < 2) {
    reasons.push('Принято меньше двух точек — снимать было нечего');
    return {
      quality: 'unknown', points: pts.length, droppedTotal, acceptedShare,
      lengthKm: 0, durationMin, altitudeShare: 0, medianAccuracyM, reasons,
    };
  }

  let quality: TrackQuality = 'usable';
  if (acceptedShare !== null && acceptedShare < MIN_ACCEPTED_SHARE) {
    reasons.push(
      `Принято только ${Math.round(acceptedShare * 100)}% засечек — приёмник ` +
      'большую часть пути не знал, где вы',
    );
    quality = 'poor';
  }
  if (state.dropped.unknown_accuracy > pts.length) {
    reasons.push('Приёмник чаще молчал о точности, чем называл её');
    quality = 'poor';
  }
  if (withAlt / pts.length < 0.5) {
    // Не приговор треку: высота — улика происхождения, а не годности пути.
    reasons.push('Высота есть меньше чем у половины точек — линия не станет доказательством');
  }

  return {
    quality, points: pts.length, droppedTotal, acceptedShare,
    lengthKm: Math.round((state.lengthM / 1000) * 100) / 100,
    durationMin, altitudeShare: Math.round((withAlt / pts.length) * 100) / 100,
    medianAccuracyM, reasons,
  };
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

/**
 * GeoJSON снятого трека. Высота идёт ТРЕТЬИМ числом, как её ждёт
 * `trackEvidence`: без неё запись прибора неотличима от перерисовки.
 */
export function toGeoJson(state: RecorderState): {
  type: 'LineString'; coordinates: number[][];
} | null {
  if (state.points.length < 2) return null;
  return {
    type: 'LineString',
    coordinates: state.points.map(p => (
      p.altitude !== null && Number.isFinite(p.altitude)
        ? [round6(p.lng), round6(p.lat), Math.round(p.altitude)]
        : [round6(p.lng), round6(p.lat)]
    )),
  };
}
