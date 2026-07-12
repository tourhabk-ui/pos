/**
 * lib/services/data-repair.ts
 *
 * Ремонт географических данных по итогам инвентаризации (июль 2026,
 * «поехали» владельца):
 *
 * 1. Кластеры фейковых координат: десятки мест стоят В ОДНОЙ точке
 *    (след сломанного геокодинга — заглушка). Координату чиним из финиша
 *    непривязанного трека с сильным совпадением имени; без трека —
 *    пере-геокодим Nominatim'ом; не вышло — скрываем до ручной проверки.
 * 2. Дубли мест: одинаковый набор слов имени (ё=е) + < 1 км — дубль
 *    скрывается, ссылки (route_waypoints, треки) перевешиваются на основного.
 * 3. Привязка треков ВСЕХ источников к местам (раньше — только idilesom).
 * 4. Нормализация source_name: 'idilesom' -> 'idilesom.com'.
 * 5. Скрытие мест-статей (точный список имён из инвентаризации).
 *
 * Каждый шаг идемпотентен. dry_run=true (дефолт) — только диагностика,
 * ни одного UPDATE.
 */

import { pool } from '@/lib/db-pool';
import { matchTrackToPlace, nameMatchStrength, type PlaceRef } from '@/lib/services/idilesom-importer';
import { geocodeAddress, withinKamchatka } from '@/lib/services/geocode';

// Места-статьи/события из инвентаризации — скрыть (точное имя, не паттерн:
// «Здесь начинается Россия» и памятники — реальные места, их не трогаем)
const ARTICLE_PLACE_NAMES = [
  'Пока дремлют вулканы',
  'Камчатка глазами детей. 100 километров до Мутновской ГеоТЭС',
  'Гонка на собачьих упряжках «Берингия. Авача». Гонка среди вулканов',
  'Забег на Аагские (Чистинские) источники',
];

export interface RepairItem {
  step: string;
  place?: string;
  detail: string;
}

export interface DataRepairResult {
  dry_run: boolean;
  bogus_clusters: number;
  bogus_places: number;
  coords_from_track: number;
  coords_from_geocode: number;
  hidden_unfixable: number;
  merged_dupes: number;
  linked_tracks: number;
  normalized_sources: number;
  hidden_articles: number;
  errors: number;
  duration_ms: number;
  items: RepairItem[];
}

/** Набор слов нормализованного имени: «Озеро Курильское» == «Курильское озеро». */
export function nameWordSet(name: string): string {
  return name
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^а-яa-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

/** Финиш трека — обычно сам объект (старт — тропа/парковка). */
export function trackDestination(coordinates: number[][]): { lat: number; lng: number } | null {
  for (let i = coordinates.length - 1; i >= 0; i--) {
    const c = coordinates[i];
    if (Array.isArray(c) && c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1])) {
      return { lat: c[1], lng: c[0] };
    }
  }
  return null;
}

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface TrackRow {
  id: string;
  title: string;
  geometry: { coordinates?: number[][] } | null;
}

export async function runDataRepair(dryRun = true): Promise<DataRepairResult> {
  const t0 = Date.now();
  const items: RepairItem[] = [];
  const res: DataRepairResult = {
    dry_run: dryRun,
    bogus_clusters: 0,
    bogus_places: 0,
    coords_from_track: 0,
    coords_from_geocode: 0,
    hidden_unfixable: 0,
    merged_dupes: 0,
    linked_tracks: 0,
    normalized_sources: 0,
    hidden_articles: 0,
    errors: 0,
    duration_ms: 0,
    items,
  };

  // ── Шаг 1: кластеры фейковых координат ──────────────────────────────────
  // >= 3 мест в ОДНОЙ точке — так не бывает, это заглушка геокодера
  const { rows: clusterRows } = await pool.query<{ lat: number; lng: number; n: number }>(
    `SELECT lat::float AS lat, lng::float AS lng, COUNT(*)::int AS n
     FROM places
     WHERE lat IS NOT NULL AND lng IS NOT NULL
     GROUP BY lat, lng HAVING COUNT(*) >= 3`,
  );
  res.bogus_clusters = clusterRows.length;

  if (clusterRows.length > 0) {
    const { rows: bogusPlaces } = await pool.query<{ id: string; ark_id: string | null; name: string; lat: number; lng: number }>(
      `SELECT p.id, p.ark_id, p.name, p.lat::float AS lat, p.lng::float AS lng
       FROM places p
       JOIN (
         SELECT lat, lng FROM places
         WHERE lat IS NOT NULL AND lng IS NOT NULL
         GROUP BY lat, lng HAVING COUNT(*) >= 3
       ) c ON c.lat = p.lat AND c.lng = p.lng`,
    );
    res.bogus_places = bogusPlaces.length;

    // Непривязанные треки — кандидаты-доноры координат (имя-only: дистанцию
    // с фейковой координатой сверять бессмысленно)
    const { rows: freeTracks } = await pool.query<TrackRow>(
      `SELECT id, title, geometry FROM kamchatka_routes
       WHERE geometry IS NOT NULL AND (metadata->>'place_ark_id') IS NULL`,
    );

    for (const place of bogusPlaces) {
      const donor = freeTracks.find(
        t => nameMatchStrength(place.name, t.title) === 'strong' && t.geometry?.coordinates?.length,
      );
      if (donor) {
        const dest = trackDestination(donor.geometry!.coordinates!);
        if (dest && withinKamchatka(dest.lat, dest.lng)) {
          if (!dryRun) {
            await pool.query(`UPDATE places SET lat = $1, lng = $2 WHERE id = $3`, [dest.lat, dest.lng, place.id]);
            if (place.ark_id) {
              await pool.query(
                `UPDATE kamchatka_routes
                 SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('place_ark_id', $1::text)
                 WHERE id = $2`,
                [place.ark_id, donor.id],
              );
            }
          }
          res.coords_from_track++;
          items.push({ step: 'coords', place: place.name, detail: `из финиша трека «${donor.title}» -> ${dest.lat.toFixed(4)}, ${dest.lng.toFixed(4)}` });
          continue;
        }
      }

      // Без трека — пере-геокодим (Nominatim: 1 зап/сек)
      let fixed = false;
      try {
        const geo = await geocodeAddress(`${place.name}, Камчатский край`);
        if (geo && withinKamchatka(geo.lat, geo.lng)) {
          if (!dryRun) {
            await pool.query(`UPDATE places SET lat = $1, lng = $2 WHERE id = $3`, [geo.lat, geo.lng, place.id]);
          }
          res.coords_from_geocode++;
          items.push({ step: 'coords', place: place.name, detail: `геокод (${geo.source}) -> ${geo.lat.toFixed(4)}, ${geo.lng.toFixed(4)}` });
          fixed = true;
        }
        if (geo?.source === 'nominatim') await sleep(1100);
      } catch {
        res.errors++;
      }
      if (!fixed) {
        if (!dryRun) {
          await pool.query(`UPDATE places SET is_visible = false WHERE id = $1`, [place.id]);
        }
        res.hidden_unfixable++;
        items.push({ step: 'coords', place: place.name, detail: 'координата не восстановилась — скрыто до ручной проверки' });
      }
    }
  }

  // ── Шаг 2: дубли мест (набор слов имени + < 1 км) ───────────────────────
  const { rows: allPlaces } = await pool.query<{
    id: string; ark_id: string | null; name: string; lat: number | null; lng: number | null;
    desc_len: number; has_photo: boolean; is_visible: boolean;
  }>(
    `SELECT p.id, p.ark_id, p.name, p.lat::float AS lat, p.lng::float AS lng,
            length(COALESCE(p.description,''))::int AS desc_len,
            EXISTS (SELECT 1 FROM ai_route_images img WHERE img.route_id = p.ark_id) AS has_photo,
            p.is_visible
     FROM places p`,
  );

  const byWordSet = new Map<string, typeof allPlaces>();
  for (const p of allPlaces) {
    if (!p.is_visible) continue;
    const key = nameWordSet(p.name);
    if (!key) continue;
    const arr = byWordSet.get(key) ?? [];
    arr.push(p);
    byWordSet.set(key, arr);
  }

  for (const [, group] of byWordSet) {
    if (group.length < 2) continue;
    // Основной — с фото, затем с самым длинным описанием
    const sorted = [...group].sort((a, b) =>
      Number(b.has_photo) - Number(a.has_photo) || b.desc_len - a.desc_len,
    );
    const keeper = sorted[0];
    for (const dupe of sorted.slice(1)) {
      if (dupe.lat == null || keeper.lat == null || dupe.lng == null || keeper.lng == null) continue;
      if (haversineKm(dupe.lat, dupe.lng, keeper.lat, keeper.lng) > 1) continue;
      if (!dryRun) {
        await pool.query(`UPDATE places SET is_visible = false WHERE id = $1`, [dupe.id]);
        await pool.query(`UPDATE route_waypoints SET place_id = $1 WHERE place_id = $2`, [keeper.id, dupe.id]);
        if (dupe.ark_id && keeper.ark_id) {
          await pool.query(
            `UPDATE kamchatka_routes
             SET metadata = metadata || jsonb_build_object('place_ark_id', $1::text)
             WHERE metadata->>'place_ark_id' = $2`,
            [keeper.ark_id, dupe.ark_id],
          );
        }
      }
      res.merged_dupes++;
      items.push({ step: 'dupes', place: dupe.name, detail: `дубль скрыт, ссылки -> «${keeper.name}»` });
    }
  }

  // ── Шаг 3: привязка треков всех источников ──────────────────────────────
  const { rows: unlinked } = await pool.query<TrackRow>(
    `SELECT id, title, geometry FROM kamchatka_routes
     WHERE geometry IS NOT NULL AND (metadata->>'place_ark_id') IS NULL`,
  );
  const { rows: places } = await pool.query<PlaceRef>(
    `SELECT ark_id, name, lat::float AS lat, lng::float AS lng
     FROM places
     WHERE is_visible = true AND ark_id IS NOT NULL
       AND lat IS NOT NULL AND lng IS NOT NULL`,
  );
  for (const track of unlinked) {
    const coordinates = track.geometry?.coordinates;
    if (!Array.isArray(coordinates) || coordinates.length < 3) continue;
    const match = matchTrackToPlace({ title: track.title, coordinates }, places);
    if (!match) continue;
    if (!dryRun) {
      await pool.query(
        `UPDATE kamchatka_routes
         SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('place_ark_id', $1::text)
         WHERE id = $2`,
        [match.place.ark_id, track.id],
      );
    }
    res.linked_tracks++;
    items.push({ step: 'link', place: match.place.name, detail: `трек «${track.title}» (${match.minKm.toFixed(2)} км)` });
  }

  // ── Шаг 4: нормализация source_name ─────────────────────────────────────
  if (dryRun) {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM kamchatka_routes WHERE source_name = 'idilesom'`,
    );
    res.normalized_sources = rows[0]?.n ?? 0;
  } else {
    const upd = await pool.query(
      `UPDATE kamchatka_routes SET source_name = 'idilesom.com' WHERE source_name = 'idilesom'`,
    );
    res.normalized_sources = upd.rowCount ?? 0;
  }

  // ── Шаг 5: места-статьи ─────────────────────────────────────────────────
  if (dryRun) {
    const { rows } = await pool.query<{ name: string }>(
      `SELECT name FROM places WHERE name = ANY($1) AND is_visible = true`,
      [ARTICLE_PLACE_NAMES],
    );
    res.hidden_articles = rows.length;
    for (const r of rows) items.push({ step: 'articles', place: r.name, detail: 'будет скрыто' });
  } else {
    const upd = await pool.query(
      `UPDATE places SET is_visible = false WHERE name = ANY($1) AND is_visible = true`,
      [ARTICLE_PLACE_NAMES],
    );
    res.hidden_articles = upd.rowCount ?? 0;
  }

  res.duration_ms = Date.now() - t0;
  return res;
}
