/**
 * lib/routes/track-attachment-audit.ts
 *
 * Пересуд уже привязанных треков сегодняшним правилом.
 *
 * ── Зачем ──────────────────────────────────────────────────────────────────
 *
 * Треки на маршруты привязывались автоматически, по близости. Правило было
 * такое: взять ОДНУ точку трека, найти маршрут, чей якорь ближе всех в
 * пределах нескольких километров, и записать. У `scripts/import-idilesom-
 * tracks.ts` радиус 5 км и запись без всякой защиты — просто `UPDATE
 * geometry`; у KML-инбокса было 4 км от конца трека.
 *
 * Лог импорта 26.07 показал, чем это кончается: трек «Вулкан Ичинская сопка»
 * привязался к «Эссовским (Уксичанским) термальным источникам». Разные
 * объекты. Не легло на карточку только потому, что там уже была геометрия.
 *
 * Причина камчатская: маршруты стартуют из общих посёлков. Эссо — перевалка
 * и к источникам, и к сопке; близость одной точки не говорит, КУДА ведёт путь.
 *
 * Правило в KML-инбоксе починено (`lib/import/kml-inbox.ts`: расстояние до
 * всего трека, запрет привязки длинных треков по близости, требование
 * однозначности). Но привязки, сделанные ПРЕЖНИМ правилом, уже лежат в базе,
 * и сколько из них сидят на чужих маршрутах — неизвестно.
 *
 * Лить новые треки поверх непроверенных старых значит добавлять к неизвестной
 * ошибке ещё одну. Сначала измерение.
 *
 * READ-ONLY: ничего не пишет и ничего не отвязывает. Решение по каждому
 * случаю — за человеком: трек может быть привязан верно и без поддержки
 * близости (например, вручную или по имени).
 */

import { pool } from '@/lib/db-pool';
import { geometryToTrack } from '@/lib/routes/geometry-audit';
import {
  MAX_MATCH_DIST_KM, AMBIGUOUS_MARGIN_KM, PROXIMITY_MAX_TRACK_KM,
} from '@/lib/import/kml-inbox';

/** Приговор сегодняшнего правила привязке, сделанной вчерашним. */
export type AttachmentVerdict =
  /** Якорь маршрута дальше радиуса от собственного трека — близость не подтверждает привязку. */
  | 'anchor_far'
  /** Трек длинный: близость одной точки на Камчатке ничего не доказывает. */
  | 'track_long'
  /** Рядом есть другой маршрут — выбор был не выбором, а угадыванием. */
  | 'ambiguous'
  /** Сегодняшнее правило привязало бы так же. */
  | 'holds';

export interface AttachmentCase {
  id: string;
  title: string;
  verdict: AttachmentVerdict;
  /** Насколько якорь маршрута отстоит от собственного трека, км. */
  anchorToTrackKm: number;
  /** Габарит трека, км. */
  spanKm: number;
  /** Ближайший ЧУЖОЙ маршрут к этому треку: имя и расстояние. */
  nearestOther: { title: string; km: number } | null;
  points: number;
}

export interface AttachmentAudit {
  /** Треков рассмотрено. */
  checked: number;
  /** Разбор по приговорам. */
  by_verdict: Record<AttachmentVerdict, number>;
  /** Пороги, которыми судили — чтобы цифру можно было перепроверить. */
  thresholds: { anchor_km: number; margin_km: number; long_track_km: number };
  /** Самые сомнительные — с них и начинать разбор руками. */
  worst: AttachmentCase[];
  /** Какие источники геометрии рассматривались. */
  sources: string[];
  duration_ms: number;
}

interface RouteRow {
  id: string;
  title: string | null;
  lat: string | null;
  lng: string | null;
  geometry: unknown;
  geom_source: string | null;
}

const R = 6371;

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const t = (d: number) => (d * Math.PI) / 180;
  const dLat = t(lat2 - lat1);
  const dLng = t(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(t(lat1)) * Math.cos(t(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Расстояние от точки до ближайшей вершины трека, км. */
function toTrackKm(lat: number, lng: number, track: Array<{ lat: number; lng: number }>): number {
  let best = Infinity;
  for (const p of track) {
    const d = haversineKm(lat, lng, p.lat, p.lng);
    if (d < best) best = d;
  }
  return best;
}

/** Габарит трека, км. */
function spanKm(track: Array<{ lat: number; lng: number }>): number {
  if (track.length < 2) return 0;
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const p of track) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  return haversineKm(minLat, minLng, maxLat, maxLng);
}

/**
 * Приговор одной привязке.
 *
 * Порядок ветвей — от «привязка не опирается на близость вовсе» к «опирается,
 * но выбор был неоднозначен». Чинить их надо по-разному, поэтому и названы
 * они по-разному, а не одним «подозрительно».
 */
export function judgeAttachment(input: {
  anchorToTrackKm: number;
  spanKm: number;
  nearestOtherKm: number | null;
}): AttachmentVerdict {
  if (input.anchorToTrackKm > MAX_MATCH_DIST_KM) return 'anchor_far';
  if (input.spanKm > PROXIMITY_MAX_TRACK_KM) return 'track_long';
  if (input.nearestOtherKm !== null
      && input.nearestOtherKm - input.anchorToTrackKm < AMBIGUOUS_MARGIN_KM) {
    return 'ambiguous';
  }
  return 'holds';
}

/**
 * Пересуд всех треков указанных источников.
 *
 * `sources` — метки в `geometry->>'source'`. По умолчанию оба автоматических
 * привязывателя. Треки без метки не трогаем: их происхождение неизвестно, и
 * судить их правилом, по которому они, возможно, не привязывались, значило бы
 * выдать догадку за измерение.
 */
export async function runAttachmentAudit(
  sources: string[] = ['idilesom', 'kml_inbox'],
): Promise<AttachmentAudit> {
  const startedAt = Date.now();

  // Только живое и не слитое: слияния 20.08 показали, что пересуд без этого
  // фильтра выносил «худшими» уже слитые скрытые записи (Верхне-Паратунские
  // с якорем в 191 км) — шум о мёртвых заслонял живые случаи. Соседи-якоря
  // ниже по той же причине только живые: скрытый сосед не оправдание.
  const all = await pool.query<RouteRow>(
    `SELECT id::text, title, lat::text, lng::text, geometry,
            geometry->>'source' AS geom_source
       FROM kamchatka_routes
      WHERE lat IS NOT NULL AND lng IS NOT NULL
        AND is_visible = true AND merged_into_id IS NULL`,
  );

  // Якоря ВСЕХ маршрутов: чужой сосед ищется среди всех, а не только среди
  // тех, у кого трек с той же меткой.
  const anchors = all.rows
    .map((r) => ({ id: r.id, title: r.title ?? '(без названия)', lat: Number(r.lat), lng: Number(r.lng) }))
    .filter((a) => Number.isFinite(a.lat) && Number.isFinite(a.lng));

  const by_verdict: Record<AttachmentVerdict, number> = {
    anchor_far: 0, track_long: 0, ambiguous: 0, holds: 0,
  };
  const cases: AttachmentCase[] = [];

  for (const r of all.rows) {
    if (!r.geom_source || !sources.includes(r.geom_source)) continue;
    const track = geometryToTrack(r.geometry);
    if (track.length < 2) continue;

    const lat = Number(r.lat), lng = Number(r.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const anchorToTrackKm = toTrackKm(lat, lng, track);
    const span = spanKm(track);

    let nearestOther: { title: string; km: number } | null = null;
    for (const a of anchors) {
      if (a.id === r.id) continue;
      const d = toTrackKm(a.lat, a.lng, track);
      if (!nearestOther || d < nearestOther.km) nearestOther = { title: a.title, km: d };
    }

    const verdict = judgeAttachment({
      anchorToTrackKm,
      spanKm: span,
      nearestOtherKm: nearestOther ? nearestOther.km : null,
    });
    by_verdict[verdict] += 1;

    if (verdict !== 'holds') {
      cases.push({
        id: r.id,
        title: r.title ?? '(без названия)',
        verdict,
        anchorToTrackKm: Math.round(anchorToTrackKm * 10) / 10,
        spanKm: Math.round(span * 10) / 10,
        nearestOther: nearestOther
          ? { title: nearestOther.title, km: Math.round(nearestOther.km * 10) / 10 }
          : null,
        points: track.length,
      });
    }
  }

  // Сначала те, где якорь дальше всего от собственного трека: там привязка
  // держится ни на чём.
  cases.sort((a, b) => b.anchorToTrackKm - a.anchorToTrackKm);

  return {
    checked: Object.values(by_verdict).reduce((s, n) => s + n, 0),
    by_verdict,
    thresholds: {
      anchor_km: MAX_MATCH_DIST_KM,
      margin_km: AMBIGUOUS_MARGIN_KM,
      long_track_km: PROXIMITY_MAX_TRACK_KM,
    },
    worst: cases.slice(0, 20),
    sources,
    duration_ms: Date.now() - startedAt,
  };
}
