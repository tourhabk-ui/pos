/**
 * lib/routes/unify.ts
 *
 * Сборка единой геометрии маршрута — то, что у Organic Maps даёт `.mwm`.
 *
 * ── Что именно у них единое ────────────────────────────────────────────────
 *
 * Не хранилище. У maps.me карта, маршрут, поиск и высоты приходят из ОДНОГО
 * графа OSM, поэтому разойтись между собой не могут в принципе. Единство там
 * — свойство происхождения, а не место, куда всё сложили.
 *
 * У нас об одном маршруте говорят два независимых источника: линия из
 * `kamchatka_routes.geometry` и точки из `route_waypoints` → `places`.
 * Полевой скриншот 11.08: цель на южном берегу входа в Авачинскую бухту,
 * трек по северному, между ними вода — а экран уверенно считал расстояние и
 * время. Заплатка снимает цифру; причина остаётся в данных.
 *
 * ── Что делает этот модуль ─────────────────────────────────────────────────
 *
 * Выбирает ОДНУ линию записи на маршрут и объявляет её происхождение, после
 * чего положение путевой точки перестаёт быть отдельной координатой и
 * становится свойством этой линии: `along_m` вдоль неё, `offset_m` в сторону.
 * Два числа об одном маршруте теперь считаются из одного и того же — расходиться
 * им больше не с чем.
 *
 * ── Чего он НЕ делает ──────────────────────────────────────────────────────
 *
 * Не создаёт данных. У полутора сотен маршрутов линия построена миграцией 168
 * прямыми между точками; после сборки она честно называется `waypoints` +
 * `sketch`, и экран по-прежнему обязан говорить «по ломаной между точками».
 * Единый источник не превращает набросок в тропу — он делает разницу видимой,
 * счётной и исправимой, вместо того чтобы всплывать сюрпризом на телефоне.
 *
 * Не прячет конфликт. `worst_offset_m` записывается как есть; расхождение
 * становится хранимым свойством маршрута, а не открытием в поле.
 */

import { extractTrackpoints, type TrackPoint } from '@/lib/routes/track';
import { trackFidelity, type TrackFidelity } from '@/lib/routes/track-fidelity';
import { projectOnTrack, straightKm, type GeoPoint } from '@/lib/on-route/approach';

/** Откуда взялась линия записи. Порядок — порядок доверия. */
export type GeometrySource = 'geometry' | 'payload' | 'waypoints';

export interface WaypointInput {
  id: string;
  position: number;
  lat: number | null;
  lng: number | null;
}

export interface WaypointPlacement {
  id: string;
  /** Метры вдоль линии записи. NULL — считать было не по чему. */
  alongM: number | null;
  /** Метры от линии до точки. NULL — не считали; 0 — точка на линии. */
  offsetM: number | null;
}

export interface RouteGeometryRecord {
  geometry: { type: 'LineString'; coordinates: number[][] };
  source: GeometrySource;
  fidelity: TrackFidelity;
  points: number;
  lengthM: number;
  /** Худший отрыв точки от линии, метры. NULL — точек нет. */
  worstOffsetM: number | null;
  placements: WaypointPlacement[];
  fingerprint: string;
}

export interface BuildInput {
  geometry: unknown;
  payload: Record<string, unknown> | null | undefined;
  waypoints: WaypointInput[];
}

/**
 * Отпечаток входа.
 *
 * Нужен ровно для одного: пересобирать только изменившееся. FNV-1a, без
 * `node:crypto` — модуль должен оставаться чистым и запускаться где угодно,
 * а криптостойкость тут не при чём: это признак изменения, не подпись.
 */
export function fingerprint(parts: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < parts.length; i++) {
    h ^= parts.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Координаты с шестью знаками: дальше только шум GPS. */
function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

function inputFingerprint(track: TrackPoint[], source: GeometrySource, wps: WaypointInput[]): string {
  const line = track.map((p) => `${round6(p.lat)},${round6(p.lng)}`).join(';');
  const pts = [...wps]
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
    .map((w) => `${w.id}:${w.lat ?? ''},${w.lng ?? ''}`)
    .join(';');
  return fingerprint(`${source}|${line}|${pts}`);
}

/** Годная координата: число, в пределах Земли, не потерянный ноль-ноль. */
function usable(lat: number | null, lng: number | null): lat is number {
  if (lat === null || lng === null) return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return false;
  return !(lat === 0 && lng === 0);
}

/**
 * Линия записи: первая годная из источников по порядку доверия.
 *
 * `extractTrackpoints` уже знает порядок «geometry → payload.geometry →
 * payload.track» — своего второго порядка не заводим. Здесь добавляется
 * только последний, самый слабый источник: прямые между путевыми точками.
 * Он честно называется своим именем, потому что идти по нему нельзя.
 */
export function chooseTrack(input: BuildInput): { track: TrackPoint[]; source: GeometrySource } | null {
  const direct = extractTrackpoints(
    (input.geometry ?? null) as { type?: string; coordinates?: number[][] } | null,
    null,
  );
  if (direct.length >= 2) return { track: direct, source: 'geometry' };

  const legacy = extractTrackpoints(null, input.payload);
  if (legacy.length >= 2) return { track: legacy, source: 'payload' };

  const fromWps = [...input.waypoints]
    .sort((a, b) => a.position - b.position)
    .filter((w) => usable(w.lat, w.lng))
    .map((w) => ({ lat: w.lat as number, lng: w.lng as number }));
  if (fromWps.length >= 2) return { track: fromWps, source: 'waypoints' };

  return null;
}

/** Длина ломаной, метры. */
function lengthM(track: TrackPoint[]): number {
  let m = 0;
  for (let i = 1; i < track.length; i++) m += straightKm(track[i - 1], track[i]) * 1000;
  return m;
}

/** Метры вдоль ломаной до проекции. */
function alongMeters(track: TrackPoint[], segment: number, t: number): number {
  let m = 0;
  for (let i = 0; i < segment; i++) m += straightKm(track[i], track[i + 1]) * 1000;
  if (segment < track.length - 1) m += straightKm(track[segment], track[segment + 1]) * 1000 * t;
  return m;
}

/**
 * Геометрия записи для одного маршрута.
 *
 * `null` — строить не из чего: ни линии, ни двух годных точек. Пустую линию
 * не выдумываем, потому что пустая линия в поле выглядит как «маршрут есть».
 */
export function buildRouteGeometry(input: BuildInput): RouteGeometryRecord | null {
  const chosen = chooseTrack(input);
  if (!chosen) return null;
  const { track, source } = chosen;

  const placements: WaypointPlacement[] = [];
  let worst: number | null = null;

  for (const w of input.waypoints) {
    if (!usable(w.lat, w.lng)) {
      // Точка без координат — не ноль метров от линии, а «не считали».
      placements.push({ id: w.id, alongM: null, offsetM: null });
      continue;
    }
    const p: GeoPoint = { lat: w.lat as number, lng: w.lng as number };
    const pr = projectOnTrack(p, track);
    if (!pr) {
      placements.push({ id: w.id, alongM: null, offsetM: null });
      continue;
    }
    const offsetM = pr.offTrackKm * 1000;
    placements.push({
      id: w.id,
      alongM: Math.round(alongMeters(track, pr.segment, pr.t)),
      offsetM: Math.round(offsetM),
    });
    if (worst === null || offsetM > worst) worst = offsetM;
  }

  return {
    geometry: {
      type: 'LineString',
      coordinates: track.map((p) =>
        p.elevation != null && Number.isFinite(p.elevation)
          ? [round6(p.lng), round6(p.lat), Math.round(p.elevation)]
          : [round6(p.lng), round6(p.lat)],
      ),
    },
    source,
    // Линия из путевых точек — набросок по построению, а не по плотности:
    // судить её тем же порогом значит иногда назвать тропой прямую через
    // распадок. Про остальные источники решает общее правило платформы.
    fidelity: source === 'waypoints'
      ? 'sketch'
      : trackFidelity(track.map((p) => [p.lat, p.lng] as [number, number])),
    points: track.length,
    lengthM: Math.round(lengthM(track)),
    worstOffsetM: worst === null ? null : Math.round(worst),
    placements,
    fingerprint: inputFingerprint(track, source, input.waypoints),
  };
}
