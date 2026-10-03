/**
 * lib/safety/trail-observation-zones.ts
 *
 * Наблюдения туристов об опасностях тропы — брод, завал, осыпь, камнепад —
 * как зоны геофенса: человек, идущий следом, слышит о них на подходе.
 *
 * ── Зачем ──────────────────────────────────────────────────────────────────
 *
 * До 03.10 наблюдение с экрана маршрута (ObservationSheet) доходило до чужого
 * телефона только в одном роде — медведь (bear-sightings.ts). «Опасность»,
 * «Тропа» и «Камнепад» ложились в trail_reports, проходили модерацию — и
 * дальше не шли никуда: прочитать их в поле было нельзя. Российские «Тропы»
 * (RuStore, разбор конкурентов 03.10) предупреждают о броде и завале за
 * несколько сотен метров; данные для этого у нас уже были.
 *
 * ── Границы ────────────────────────────────────────────────────────────────
 *
 * - Только прошедшее модерацию и только свежее: предикат и окно — общие с
 *   медведем (FRESH_APPROVED_SQL, SIGHTING_WINDOW_DAYS). Тропа меняется
 *   быстрее зверя? Возможно; но два окна для одной ленты наблюдений
 *   разошлись бы молча, и менять число — решение владельца.
 * - Срок зоны — от времени НАБЛЮДЕНИЯ, как у медведя: иначе каждое
 *   обновление продлевало бы старый брод ещё на неделю.
 * - Радиус 300 м: внутри — «вы у места», предупреждение «рядом» срабатывает
 *   с полутора радиусов (checkZone), то есть метров за 450. Это расстояние
 *   оповещения, а не размер завала.
 * - Текст — слова туриста, без пересказа и без придуманной подробности:
 *   пустой текст — «отметка без описания» (§4.0).
 */

import { SIGHTING_WINDOW_MS, sightingAgeLabel } from './bear-sightings';
import type { GeofenceZone } from './geofence';

/** Роды наблюдений, которые говорят о самой тропе (миграция 917). */
export const TRAIL_HAZARD_REPORT_TYPES = ['hazard', 'trail', 'rockfall'] as const;
export type TrailHazardReportType = typeof TRAIL_HAZARD_REPORT_TYPES[number];

/** См. шапку: расстояние оповещения. */
export const TRAIL_OBSERVATION_RADIUS_M = 300;

const TITLE: Record<TrailHazardReportType, string> = {
  hazard: 'Опасность на тропе',
  trail: 'Состояние тропы',
  rockfall: 'Камнепад',
};

export interface TrailObservation {
  id: string;
  type: TrailHazardReportType;
  lat: number;
  lng: number;
  text: string | null;
  /** Часов с момента наблюдения. Считает база. */
  hoursAgo: number;
}

export function isTrailHazardType(v: unknown): v is TrailHazardReportType {
  return typeof v === 'string' && (TRAIL_HAZARD_REPORT_TYPES as readonly string[]).includes(v);
}

export function trailObservationZone(o: TrailObservation, now: number = Date.now()): GeofenceZone {
  const observedAt = now - o.hoursAgo * 3_600_000;
  const note = (o.text ?? '').trim().slice(0, 120);
  return {
    id: `trail_${o.id}`,
    name: TITLE[o.type],
    lat: o.lat,
    lng: o.lng,
    radiusM: TRAIL_OBSERVATION_RADIUS_M,
    hazard: 'trail',
    level: 'warning',
    message:
      `${TITLE[o.type]}${note ? `: ${note}` : ' — отметка без описания'} · ${sightingAgeLabel(o.hoursAgo)} · ` +
      'наблюдение туриста, прошло модерацию. Оцените место сами, прежде чем идти дальше.',
    expiresAt: observedAt + SIGHTING_WINDOW_MS,
  };
}
