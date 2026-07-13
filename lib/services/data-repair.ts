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
  'Памятная табличка имени Родыгина Николач Александровича, первого мед. Работника западного побережья Камчатки',
  'Удивительные деревья России: Пущинская хранительница старины - Берёза Эрмана (каменная)',
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
  merged_routes: number;
  linked_tracks: number;
  normalized_sources: number;
  hidden_articles: number;
  normalized_types: number;
  merged_coord_subset: number;
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

/** Множество слов имени — для проверки «одно имя строго входит в другое». */
function nameWords(name: string): Set<string> {
  return new Set(nameWordSet(name).split(' ').filter(Boolean));
}

/** true, если a — строгое подмножество b (все слова a в b, и |a| < |b|). */
function isStrictSubset(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || a.size >= b.size) return false;
  for (const w of a) if (!b.has(w)) return false;
  return true;
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
    merged_routes: 0,
    linked_tracks: 0,
    normalized_sources: 0,
    hidden_articles: 0,
    normalized_types: 0,
    merged_coord_subset: 0,
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
        // Nominatim: 1 зап/сек — пауза после ЛЮБОГО сетевого похода,
        // включая неуспешный (null); без паузы только кэш-попадания
        if (geo?.source !== 'cache') await sleep(1100);
      } catch {
        res.errors++;
        await sleep(1100);
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
    desc_len: number; has_photo: boolean; is_visible: boolean; location_type: string | null;
  }>(
    `SELECT p.id, p.ark_id, p.name, p.location_type, p.lat::float AS lat, p.lng::float AS lng,
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

  // ── Шаг 6: дубли МАРШРУТОВ (kamchatka_routes) ───────────────────────────
  // Одно название из разных источников лежит отдельными строками
  // («Вилючинский водопад» ×9). Критерий СТРОЖЕ мест: набор слов имени +
  // совпадающий activity_type (или оба NULL) + координаты < 1 км. Разный
  // activity_type = разный продукт (лыжный/снегоходный Вачкажец), не дубль.
  // Keeper: с треком (geometry) > длиннее описание > стабильный id.
  // Туры дубля перевешиваются на keeper — не осиротеют.
  const { rows: allRoutes } = await pool.query<{
    id: string; title: string; activity_type: string | null;
    lat: number | null; lng: number | null;
    desc_len: number; has_geometry: boolean; is_visible: boolean;
  }>(
    `SELECT id, title, activity_type, lat::float AS lat, lng::float AS lng,
            length(COALESCE(description,''))::int AS desc_len,
            (geometry IS NOT NULL) AS has_geometry,
            is_visible
     FROM kamchatka_routes`,
  );

  const routesByKey = new Map<string, typeof allRoutes>();
  for (const r of allRoutes) {
    if (!r.is_visible) continue;
    const wordSet = nameWordSet(r.title);
    if (!wordSet) continue;
    const key = `${wordSet}|${r.activity_type ?? ''}`;
    const arr = routesByKey.get(key) ?? [];
    arr.push(r);
    routesByKey.set(key, arr);
  }

  for (const [, group] of routesByKey) {
    if (group.length < 2) continue;
    // Keeper: с треком (geometry) > длиннее описание > стабильный id (tie-break
    // по id делает выбор keeper детерминированным между прогонами)
    const sorted = [...group].sort((a, b) =>
      Number(b.has_geometry) - Number(a.has_geometry)
      || b.desc_len - a.desc_len
      || a.id.localeCompare(b.id),
    );
    const keeper = sorted[0];
    for (const dupe of sorted.slice(1)) {
      // Координатная сверка: если у обоих есть координаты — < 1 км; если у
      // одного нет — доверяем совпадению имени+activity (idilesom без lat/lng)
      if (dupe.lat != null && dupe.lng != null && keeper.lat != null && keeper.lng != null
          && haversineKm(dupe.lat, dupe.lng, keeper.lat, keeper.lng) > 1) continue;
      try {
        if (!dryRun) {
          // Атомарно: туры дубля -> keeper (критично: не осиротить
          // operator_tours) И скрытие дубля должны примениться вместе или никак.
          // waypoints дубля НЕ трогаем: скрытый маршрут не рендерится, а перенос
          // на keeper ломает его порядок точек и нарушает UNIQUE(route_id,place_id).
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            await client.query(`UPDATE operator_tours SET route_id = $1 WHERE route_id = $2`, [keeper.id, dupe.id]);
            await client.query(`UPDATE kamchatka_routes SET is_visible = false WHERE id = $1`, [dupe.id]);
            await client.query('COMMIT');
          } catch (txErr) {
            await client.query('ROLLBACK');
            throw txErr;
          } finally {
            client.release();
          }
        }
        res.merged_routes++;
        items.push({ step: 'route_dupes', place: dupe.title, detail: `дубль-маршрут скрыт, туры -> «${keeper.title}»` });
      } catch (err) {
        res.errors++;
        items.push({ step: 'route_dupes', place: dupe.title, detail: `ошибка слияния: ${(err instanceof Error ? err.message : String(err)).slice(0, 80)}` });
      }
    }
  }

  // ── Шаг 7: нормализация типа thermal -> hot_spring ──────────────────────
  // location_type='thermal' — рудимент: те же термальные источники, но не
  // попадают в фильтр «Термальные» (hot_spring) на /places.
  if (dryRun) {
    const { rows } = await pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM places WHERE location_type = 'thermal'`,
    );
    res.normalized_types = rows[0]?.n ?? 0;
    if (res.normalized_types > 0) items.push({ step: 'types', detail: `thermal -> hot_spring: ${res.normalized_types}` });
  } else {
    const upd = await pool.query(
      `UPDATE places SET location_type = 'hot_spring' WHERE location_type = 'thermal'`,
    );
    res.normalized_types = upd.rowCount ?? 0;
  }

  // ── Шаг 8: координатные дубли по подмножеству имени ─────────────────────
  // «Опала» ⊂ «Вулкан Опала», «Безымянный» ⊂ «Вулкан Безымянный»: набор слов
  // разный (Шаг 2 их не берёт), но координаты < 150 м и одно имя строго
  // входит в другое. Сливаем ТОЛЬКО при совпадении location_type — иначе
  // рискуем убрать уникальную опасную зону (напр. volcano) из геофенса.
  // keeper: с фото > длиннее описание > более полное имя (больше слов) > id.
  const coordCand = allPlaces.filter(
    p => p.is_visible && p.lat != null && p.lng != null && nameWordSet(p.name),
  );
  const wordsById = new Map<string, Set<string>>();
  for (const p of coordCand) wordsById.set(p.id, nameWords(p.name));
  const hiddenSubset = new Set<string>();
  for (let i = 0; i < coordCand.length; i++) {
    const a = coordCand[i];
    if (hiddenSubset.has(a.id)) continue;
    for (let j = i + 1; j < coordCand.length; j++) {
      const b = coordCand[j];
      if (hiddenSubset.has(a.id)) break;
      if (hiddenSubset.has(b.id)) continue;
      if (a.location_type !== b.location_type) continue;
      if (haversineKm(a.lat as number, a.lng as number, b.lat as number, b.lng as number) > 0.15) continue;
      const wa = wordsById.get(a.id) as Set<string>;
      const wb = wordsById.get(b.id) as Set<string>;
      if (!isStrictSubset(wa, wb) && !isStrictSubset(wb, wa)) continue;
      const [keeper, dupe] = [a, b].sort((x, y) =>
        Number(y.has_photo) - Number(x.has_photo)
        || y.desc_len - x.desc_len
        || (wordsById.get(y.id) as Set<string>).size - (wordsById.get(x.id) as Set<string>).size
        || x.id.localeCompare(y.id),
      );
      try {
        if (!dryRun) {
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            await client.query(`UPDATE route_waypoints SET place_id = $1 WHERE place_id = $2`, [keeper.id, dupe.id]);
            if (dupe.ark_id && keeper.ark_id) {
              await client.query(
                `UPDATE kamchatka_routes SET metadata = metadata || jsonb_build_object('place_ark_id', $1::text) WHERE metadata->>'place_ark_id' = $2`,
                [keeper.ark_id, dupe.ark_id],
              );
            }
            await client.query(`UPDATE places SET is_visible = false WHERE id = $1`, [dupe.id]);
            await client.query('COMMIT');
          } catch (txErr) {
            await client.query('ROLLBACK');
            throw txErr;
          } finally {
            client.release();
          }
        }
        hiddenSubset.add(dupe.id);
        res.merged_coord_subset++;
        items.push({ step: 'coord_subset', place: dupe.name, detail: `подмножество, скрыт -> «${keeper.name}»` });
      } catch (err) {
        res.errors++;
        items.push({ step: 'coord_subset', place: dupe.name, detail: `ошибка: ${(err instanceof Error ? err.message : String(err)).slice(0, 80)}` });
      }
    }
  }

  res.duration_ms = Date.now() - t0;
  return res;
}
