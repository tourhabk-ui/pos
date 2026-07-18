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
  // Тур-маршруты/подборки, попавшие в «места» (у каждой есть реальный аналог-точка) —
  // из инвентаризации run=4, видны на витрине /places как мусорные карточки.
  'Долина гейзеров. Курильское озеро. Вулканы Горелый и Авача',
  'Самые высокие вулканы Камчатки и Долина гейзеров',
  'Камчатка. Такие места',
  // Обзорная статья, а не точка (реальная точка — «Долина гейзеров»).
  // Висела «гейзерным полем» в waypoints городских маршрутов за 181-192 км
  // (run 12: 8 из 21 оставшихся wp_outlier — одно это имя).
  'Гейзеры Камчатки',
  // Дубль-запись Авачинского перевала со статейным именем (основная переименована ниже
  // через RENAME_PLACES) — прячем, чтобы на витрине осталась одна чистая карточка перевала.
  'На Авачинский перевал и Экструзию Верблюд',
];

// Реальные места с «статейным» именем (несколько предложений через точку) → чистое имя.
// Курировано из инвентаризации/скриншота владельца; на витрине имя обрывалось «….».
const RENAME_PLACES: Record<string, string> = {
  'Авачинский перевал. Экструзия Верблюд. Евражки. Безопасность.': 'Авачинский перевал',
};

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
  /** Шаг 1b: координата из трека маршрута-тёзки (псевдокластеры <300 м) */
  coords_from_twin_track: number;
  hidden_unfixable: number;
  merged_dupes: number;
  merged_routes: number;
  linked_tracks: number;
  normalized_sources: number;
  hidden_articles: number;
  renamed_places: number;
  normalized_types: number;
  merged_coord_subset: number;
  merged_morph: number;
  /** Шаг 9b: координата маршрута починена/заполнена из его собственного трека */
  fixed_route_coords: number;
  /** Диагностика (Шаг 10, без изменений БД): waypoints дальше порога от маршрута */
  waypoint_outliers: number;
  errors: number;
  duration_ms: number;
  items: RepairItem[];
}

/** Точное равенство имён без регистра/ё/лишних пробелов: «Кутхины баты» == «Кутхины Баты». */
export function sameExactName(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
  return norm(a) === norm(b);
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

/**
 * Конфликт-безопасный перенос ссылок с дубля на основного (keeper) при слиянии
 * мест. Общий для транзакционных Шагов 8 и 9 (одинаковый SQL, разный executor:
 * pool или client в BEGIN/COMMIT) — чтобы не держать три копии переноса.
 * Сперва убираем dupe-точки на маршрутах, где keeper уже есть (иначе
 * UNIQUE(route_id, place_id) упадёт), затем перевешиваем остальные и метки треков.
 */
async function transferPlaceLinks(
  run: (sql: string, params: unknown[]) => Promise<unknown>,
  keeper: { id: string; ark_id: string | null },
  dupe: { id: string; ark_id: string | null },
): Promise<void> {
  await run(
    `DELETE FROM route_waypoints WHERE place_id = $2 AND route_id IN (SELECT route_id FROM route_waypoints WHERE place_id = $1)`,
    [keeper.id, dupe.id],
  );
  await run(`UPDATE route_waypoints SET place_id = $1 WHERE place_id = $2`, [keeper.id, dupe.id]);
  if (dupe.ark_id && keeper.ark_id) {
    await run(
      `UPDATE kamchatka_routes SET metadata = metadata || jsonb_build_object('place_ark_id', $1::text) WHERE metadata->>'place_ark_id' = $2`,
      [keeper.ark_id, dupe.ark_id],
    );
  }
}

interface PlaceLike {
  name: string;
  lat: number | null;
  lng: number | null;
  location_type: string | null;
}

/**
 * Морфологический координатный дубль: та же точка (< 150 м), тот же тип и сильно
 * похожее имя (падеж/синоним: «Авачинская сопка» ↔ «Авачинский вулкан»).
 * Ловит то, что пропускают Шаг 2 (равные наборы слов) и Шаг 8 (строгое вложение).
 * Тип обязателен одинаковый — иначе рискуем слить, напр., бухту с вулканом
 * (оба «Авачинск*»). Только 'strong' nameMatchStrength — 'weak' недостаточно.
 */
export function shouldMergeMorphological(a: PlaceLike, b: PlaceLike): boolean {
  if (a.location_type !== b.location_type) return false;
  if (a.lat == null || a.lng == null || b.lat == null || b.lng == null) return false;
  if (haversineKm(a.lat, a.lng, b.lat, b.lng) > 0.15) return false;
  return nameMatchStrength(a.name, b.name) === 'strong';
}

/** Классификация «статейного» имени места: скрыть / переименовать / оставить. */
export function classifyPlaceName(name: string): { action: 'hide' | 'rename' | 'keep'; to?: string } {
  if (ARTICLE_PLACE_NAMES.includes(name)) return { action: 'hide' };
  if (RENAME_PLACES[name]) return { action: 'rename', to: RENAME_PLACES[name] };
  return { action: 'keep' };
}

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
    coords_from_twin_track: 0,
    hidden_unfixable: 0,
    merged_dupes: 0,
    merged_routes: 0,
    linked_tracks: 0,
    normalized_sources: 0,
    hidden_articles: 0,
    renamed_places: 0,
    normalized_types: 0,
    merged_coord_subset: 0,
    merged_morph: 0,
    fixed_route_coords: 0,
    waypoint_outliers: 0,
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

  // ── Шаг 1b: псевдокластеры координат → координата из трека тёзки ────────
  // Кластер Эссо (инвентаризация runs 8-14): 5+ РАЗНОимённых мест стоят в
  // 10-20 м друг от друга — тот же сломанный геокодинг, что в Шаге 1, но с
  // «дрожью», поэтому строгое равенство координат его не ловит. Вопрос
  // владельца «на idilesom нет координат?» — есть: треки одноимённых
  // маршрутов уже импортированы в kamchatka_routes.geometry. Для мест из
  // групп ≥3 в радиусе 300 м чиним координату из ФИНИША трека
  // маршрута-тёзки (strong-совпадение имени — механика Шага 1).
  try {
    const clusterCand = allPlaces.filter(p => p.is_visible && p.lat != null && p.lng != null);
    // Компоненты связности по рёбрам < 300 м (union-find без рекурсии)
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r) as string;
      let c = x;
      while (parent.get(c) !== c) { const n = parent.get(c) as string; parent.set(c, r); c = n; }
      return r;
    };
    for (const p of clusterCand) parent.set(p.id, p.id);
    for (let i = 0; i < clusterCand.length; i++) {
      for (let j = i + 1; j < clusterCand.length; j++) {
        const a = clusterCand[i]; const b = clusterCand[j];
        if (Math.abs((a.lat as number) - (b.lat as number)) > 0.005) continue;
        if (haversineKm(a.lat as number, a.lng as number, b.lat as number, b.lng as number) > 0.3) continue;
        parent.set(find(a.id), find(b.id));
      }
    }
    const compSize = new Map<string, number>();
    for (const p of clusterCand) {
      const r = find(p.id);
      compSize.set(r, (compSize.get(r) ?? 0) + 1);
    }
    const suspects = clusterCand.filter(p => (compSize.get(find(p.id)) ?? 0) >= 3);

    if (suspects.length > 0) {
      const { rows: twinTracks } = await pool.query<{ title: string; geometry: { coordinates?: number[][] } | null }>(
        `SELECT title, geometry FROM kamchatka_routes
         WHERE geometry IS NOT NULL AND title IS NOT NULL`,
      );
      for (const place of suspects) {
        // ТОЛЬКО полное совпадение набора слов: strong-матч по nameMatchStrength
        // ловил ложных доноров на генерик-словах — «Природный парк Быстринский»
        // получил трек «Природного парка Налычево» (250 км), «Каньон
        // Сноубордистов» — трек «Каньона Крылья Гамулов» (700 км). Run 15.
        const placeWs = nameWordSet(place.name);
        const donor = twinTracks.find(t =>
          Array.isArray(t.geometry?.coordinates) && (t.geometry?.coordinates?.length ?? 0) >= 3
          && nameWordSet(t.title) === placeWs,
        );
        if (!donor) continue;
        const dest = trackDestination(donor.geometry?.coordinates ?? []);
        if (!dest || !withinKamchatka(dest.lat, dest.lng)) continue;
        // Финиш трека совпал с текущей (кластерной) точкой — чинить нечего
        if (haversineKm(dest.lat, dest.lng, place.lat as number, place.lng as number) < 0.3) continue;
        if (!dryRun) {
          await pool.query(`UPDATE places SET lat = $1, lng = $2 WHERE id = $3`, [dest.lat, dest.lng, place.id]);
        }
        place.lat = dest.lat; place.lng = dest.lng; // дальше по шагам — уже чиненая
        res.coords_from_twin_track++;
        items.push({
          step: 'coords_cluster',
          place: place.name,
          detail: `псевдокластер: из финиша трека «${donor.title}» -> ${dest.lat.toFixed(4)}, ${dest.lng.toFixed(4)}`,
        });
      }
    }
  } catch (err) {
    res.errors++;
    items.push({ step: 'coords_cluster', detail: `шаг не прошёл: ${(err instanceof Error ? err.message : String(err)).slice(0, 80)}` });
  }

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
      const km = haversineKm(dupe.lat, dupe.lng, keeper.lat, keeper.lng);
      // Точная тёзка (посимвольно, без регистра/ё) из ≥2 слов — то же место,
      // даже если координаты разъехались (одна из записей просто неверна:
      // «Кутхины баты»/«Кутхины Баты» из инвентаризации). Для перестановок
      // слов и однословных имён дистанционное вето < 1 км остаётся.
      const exactTwin = sameExactName(dupe.name, keeper.name) && nameWords(keeper.name).size >= 2;
      if (km > 1 && !exactTwin) continue;
      if (!dryRun) {
        await pool.query(`UPDATE places SET is_visible = false WHERE id = $1`, [dupe.id]);
        dupe.is_visible = false; // чтобы Шаг 8 не выбрал уже скрытое место как keeper
        // Конфликт-безопасный перенос: если у маршрута уже есть keeper-точка,
        // удаляем дублирующую dupe-точку (иначе UNIQUE(route_id,place_id) упадёт).
        await pool.query(
          `DELETE FROM route_waypoints WHERE place_id = $2 AND route_id IN (SELECT route_id FROM route_waypoints WHERE place_id = $1)`,
          [keeper.id, dupe.id],
        );
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
      items.push({
        step: 'dupes',
        place: dupe.name,
        detail: km > 1
          ? `точная тёзка в ${km.toFixed(1)} км (одна координата неверна), дубль скрыт, ссылки -> «${keeper.name}»`
          : `дубль скрыт, ссылки -> «${keeper.name}»`,
      });
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

  // ── Шаг 5b: переименование реальных мест со «статейным» именем ───────────
  // «Авачинский перевал. Экструзия Верблюд. Евражки. Безопасность.» → чистое имя.
  // Место реальное (в отличие от Шага 5), поэтому не скрываем, а чистим имя —
  // на витрине карточка перестаёт обрываться «….».
  const renameFrom = Object.keys(RENAME_PLACES);
  if (dryRun) {
    const { rows } = await pool.query<{ name: string }>(
      `SELECT name FROM places WHERE name = ANY($1) AND is_visible = true`,
      [renameFrom],
    );
    res.renamed_places = rows.length;
    for (const r of rows) items.push({ step: 'rename', place: r.name, detail: `-> «${RENAME_PLACES[r.name]}»` });
  } else {
    let renamed = 0;
    for (const [from, to] of Object.entries(RENAME_PLACES)) {
      const upd = await pool.query(
        `UPDATE places SET name = $2 WHERE name = $1 AND is_visible = true`,
        [from, to],
      );
      renamed += upd.rowCount ?? 0;
    }
    res.renamed_places = renamed;
  }

  // ── Шаг 6: дубли МАРШРУТОВ (kamchatka_routes) ───────────────────────────
  // Одно название из разных источников лежит отдельными строками
  // («Горный массив Вачкажец» ×5). v2 (июль 2026, «следующий пласт дублей»
  // владельца): прежние критерии давали merged_routes=0 на 20 группах тёзок
  // из инвентаризации — activity_type сидел в ключе группировки (NULL и
  // 'hiking' расходились), а порог 1 км резал пары, где источники пиннят один
  // маршрут в разных точках (старт в городе vs сам объект — десятки км).
  // Теперь: группа = полный набор слов названия; внутри пары activity
  // совместим (равен или хотя бы один NULL) — разный НЕ-NULL activity
  // (лыжный/снегоходный Вачкажец) по-прежнему разные продукты; дистанция —
  // не вето, а строка аудита. Платформа только про Камчатку, полное
  // совпадение названия = один объект.
  // Keeper: с треком (geometry) > длиннее описание > стабильный id.
  // Туры дубля перевешиваются на keeper, паспортные/safety-поля дубля
  // переливаются в keeper (COALESCE; mchs_registration_required — OR:
  // флаг «регистрация в МЧС обязательна» не теряем никогда).
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
    const arr = routesByKey.get(wordSet) ?? [];
    arr.push(r);
    routesByKey.set(wordSet, arr);
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
      // Разный НЕ-NULL activity_type = разный продукт (лыжный vs снегоходный
      // Вачкажец) — не сливаем. NULL совместим с чем угодно (idilesom часто
      // без activity, но название полностью совпало).
      if (dupe.activity_type && keeper.activity_type && dupe.activity_type !== keeper.activity_type) continue;
      // Дистанция между записями — аудит, не вето: источники пиннят один
      // маршрут в разных точках (офис в ПК vs сам объект).
      const kmApart = (dupe.lat != null && dupe.lng != null && keeper.lat != null && keeper.lng != null)
        ? haversineKm(dupe.lat, dupe.lng, keeper.lat, keeper.lng)
        : null;
      try {
        if (!dryRun) {
          // Атомарно: паспортные/safety-поля дубля -> keeper, туры дубля ->
          // keeper (критично: не осиротить operator_tours) И скрытие дубля
          // должны примениться вместе или никак.
          // waypoints дубля НЕ трогаем: скрытый маршрут не рендерится, а перенос
          // на keeper ломает его порядок точек и нарушает UNIQUE(route_id,place_id).
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            // Данные дубля, которых нет у keeper, не теряем: COALESCE по
            // паспортным полям; mchs_registration_required — OR (флаг
            // «регистрация в МЧС обязательна» не может пропасть при слиянии).
            await client.query(
              `UPDATE kamchatka_routes k SET
                 geometry = COALESCE(k.geometry, d.geometry),
                 lat = COALESCE(k.lat, d.lat),
                 lng = COALESCE(k.lng, d.lng),
                 description = CASE WHEN COALESCE(k.description, '') = '' THEN d.description ELSE k.description END,
                 difficulty = COALESCE(k.difficulty, d.difficulty),
                 zone = COALESCE(k.zone, d.zone),
                 category = COALESCE(k.category, d.category),
                 activity_type = COALESCE(k.activity_type, d.activity_type),
                 distance_km = COALESCE(k.distance_km, d.distance_km),
                 duration_hours = COALESCE(k.duration_hours, d.duration_hours),
                 duration_days = COALESCE(k.duration_days, d.duration_days),
                 elevation_gain_m = COALESCE(k.elevation_gain_m, d.elevation_gain_m),
                 season = COALESCE(k.season, d.season),
                 route_type = COALESCE(k.route_type, d.route_type),
                 hazards = CASE WHEN k.hazards IS NULL OR cardinality(k.hazards) = 0 THEN d.hazards ELSE k.hazards END,
                 equipment = CASE WHEN k.equipment IS NULL OR cardinality(k.equipment) = 0 THEN d.equipment ELSE k.equipment END,
                 mchs_registration_required = (COALESCE(k.mchs_registration_required, false) OR COALESCE(d.mchs_registration_required, false)),
                 mchs_phone = COALESCE(k.mchs_phone, d.mchs_phone),
                 park_name = COALESCE(k.park_name, d.park_name),
                 park_approval_url = COALESCE(k.park_approval_url, d.park_approval_url),
                 flora_fauna = COALESCE(k.flora_fauna, d.flora_fauna),
                 accessibility = COALESCE(k.accessibility, d.accessibility),
                 official_passport_url = COALESCE(k.official_passport_url, d.official_passport_url),
                 passport_agency = COALESCE(k.passport_agency, d.passport_agency),
                 passport_verified_at = COALESCE(k.passport_verified_at, d.passport_verified_at),
                 updated_at = NOW()
               FROM kamchatka_routes d
               WHERE k.id = $1 AND d.id = $2`,
              [keeper.id, dupe.id],
            );
            await client.query(`UPDATE operator_tours SET route_id = $1 WHERE route_id = $2`, [keeper.id, dupe.id]);
            // merged_into в metadata — след слияния: видно, куда ушёл дубль,
            // и слияние обратимо вручную (is_visible = true + удалить метку).
            await client.query(
              `UPDATE kamchatka_routes
               SET is_visible = false,
                   metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('merged_into', $2::text)
               WHERE id = $1`,
              [dupe.id, keeper.id],
            );
            await client.query('COMMIT');
          } catch (txErr) {
            await client.query('ROLLBACK');
            throw txErr;
          } finally {
            client.release();
          }
        }
        res.merged_routes++;
        items.push({
          step: 'route_dupes',
          place: dupe.title,
          detail: `тёзка${kmApart != null ? ` (${kmApart.toFixed(0)} км между записями)` : ''} скрыта, туры и паспортные данные -> «${keeper.title}»`,
        });
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
            await transferPlaceLinks((s, p) => client.query(s, p), keeper, dupe);
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

  // ── Шаг 9: морфологические координатные дубли ────────────────────────────
  // «Авачинская сопка» ↔ «Авачинский вулкан» (50 м, оба volcano): набор слов
  // разный (Шаг 2 мимо), строгого вложения имён нет (Шаг 8 мимо), но точка та же,
  // тип совпадает и имена сильно похожи (падеж/синоним). Слитие — в основного
  // (с фото > длиннее описание > id). Уже скрытые в Шаге 8 (hiddenSubset) и в
  // этом шаге не трогаем.
  const morphCand = coordCand.filter(p => !hiddenSubset.has(p.id));
  const hiddenMorph = new Set<string>();
  for (let i = 0; i < morphCand.length; i++) {
    const a = morphCand[i];
    if (hiddenMorph.has(a.id)) continue;
    for (let j = i + 1; j < morphCand.length; j++) {
      const b = morphCand[j];
      if (hiddenMorph.has(a.id)) break;
      if (hiddenMorph.has(b.id)) continue;
      if (!shouldMergeMorphological(a, b)) continue;
      const [keeper, dupe] = [a, b].sort((x, y) =>
        Number(y.has_photo) - Number(x.has_photo)
        || y.desc_len - x.desc_len
        || x.id.localeCompare(y.id),
      );
      try {
        if (!dryRun) {
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            await transferPlaceLinks((s, p) => client.query(s, p), keeper, dupe);
            await client.query(`UPDATE places SET is_visible = false WHERE id = $1`, [dupe.id]);
            await client.query('COMMIT');
          } catch (txErr) {
            await client.query('ROLLBACK');
            throw txErr;
          } finally {
            client.release();
          }
        }
        hiddenMorph.add(dupe.id);
        res.merged_morph++;
        items.push({ step: 'coord_morph', place: dupe.name, detail: `дубль скрыт -> «${keeper.name}»` });
      } catch (err) {
        res.errors++;
        items.push({ step: 'coord_morph', place: dupe.name, detail: `ошибка: ${(err instanceof Error ? err.message : String(err)).slice(0, 80)}` });
      }
    }
  }

  // ── Шаг 9b: координата маршрута из его же трека ──────────────────────────
  // wp_outlier (run 10) показал: места уже починены (миграции 751-752), а
  // «Вулкан Бакенинг» всё равно в 93 км от одноимённого маршрута — бита
  // координата САМОГО маршрута. Трек маршрута — его собственная правда: если
  // lat/lng дальше 30 км от ВСЕХ точек трека, координата очевидно чужая
  // (заглушка геокодера) — ставим старт трека. Пустая координата при живом
  // треке тоже заполняется стартом. Маршруты БЕЗ трека не трогаем: у морских
  // прогулок координата города-старта легитимна, отличить её от битой без
  // трека нельзя.
  try {
    const { rows: geoRoutes } = await pool.query<{
      id: string; title: string; lat: string | null; lng: string | null;
      geometry: { coordinates?: number[][] } | null;
    }>(
      `SELECT id, title, lat::text AS lat, lng::text AS lng, geometry
       FROM kamchatka_routes
       WHERE is_visible = TRUE AND geometry IS NOT NULL`,
    );
    const ROUTE_COORD_SUSPECT_KM = 30;
    for (const r of geoRoutes) {
      const coords = r.geometry?.coordinates;
      if (!Array.isArray(coords)) continue;
      const pts = coords.filter(
        (c): c is number[] => Array.isArray(c) && c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]),
      );
      if (pts.length < 2) continue;
      const start = pts[0]; // GeoJSON: [lng, lat]
      let action: 'fill' | 'fix' | null = null;
      if (r.lat == null || r.lng == null) {
        action = 'fill';
      } else {
        const lat = Number(r.lat);
        const lng = Number(r.lng);
        // Прореженный проход по треку (+ последняя точка): хватает, чтобы
        // отличить «координата на треке» от «в сотне км», не мучая CPU
        const stride = Math.max(1, Math.floor(pts.length / 50));
        let minKm = Infinity;
        for (let i = 0; i < pts.length && minKm >= ROUTE_COORD_SUSPECT_KM; i += stride) {
          minKm = Math.min(minKm, haversineKm(lat, lng, pts[i][1], pts[i][0]));
        }
        const last = pts[pts.length - 1];
        minKm = Math.min(minKm, haversineKm(lat, lng, last[1], last[0]));
        if (minKm >= ROUTE_COORD_SUSPECT_KM) action = 'fix';
      }
      if (!action) continue;
      if (!dryRun) {
        await pool.query(
          `UPDATE kamchatka_routes SET lat = $1, lng = $2, updated_at = NOW() WHERE id = $3`,
          [start[1], start[0], r.id],
        );
      }
      res.fixed_route_coords++;
      items.push({
        step: 'route_coords',
        place: r.title,
        detail: action === 'fill'
          ? `координаты не было — старт трека ${start[1].toFixed(4)}, ${start[0].toFixed(4)}`
          : `дальше ${ROUTE_COORD_SUSPECT_KM} км от собственного трека — старт трека ${start[1].toFixed(4)}, ${start[0].toFixed(4)}`,
      });
    }
  } catch (err) {
    res.errors++;
    items.push({ step: 'route_coords', detail: `шаг не прошёл: ${(err instanceof Error ? err.message : String(err)).slice(0, 80)}` });
  }

  // ── Шаг 10: ДИАГНОСТИКА кривых waypoints (без изменений БД) ──────────────
  // Кейс владельца: у «Пиначево — Центральный» (Налычево) точками маршрута
  // стояли Козельский и Халактырский пляж — чужие waypoints тянут за собой
  // чужие алерты и врут навигации. Автоматически НЕ отвязываем: многодневные
  // линейные треки легально уходят на десятки км от «координаты маршрута»,
  // поэтому только отчёт с дистанциями — решение по каждой связке за владельцем.
  try {
    const { rows: wpRows } = await pool.query<{
      route_id: string; route_title: string; route_lat: string | null; route_lng: string | null;
      place_id: string; place_name: string; place_lat: string; place_lng: string;
    }>(`
      SELECT kr.id AS route_id, kr.title AS route_title,
             kr.lat::text AS route_lat, kr.lng::text AS route_lng,
             p.id AS place_id, p.name AS place_name,
             p.lat::text AS place_lat, p.lng::text AS place_lng
      FROM route_waypoints rw
      JOIN kamchatka_routes kr ON kr.id = rw.route_id
      JOIN places p ON p.id = rw.place_id
      WHERE kr.lat IS NOT NULL AND kr.lng IS NOT NULL
        AND p.lat IS NOT NULL AND p.lng IS NOT NULL
        AND kr.is_visible = TRUE
        AND p.is_visible = TRUE
    `);

    const WAYPOINT_SUSPECT_KM = 30;
    const outliers: { route: string; place: string; km: number }[] = [];
    for (const w of wpRows) {
      const km = haversineKm(
        Number(w.route_lat), Number(w.route_lng),
        Number(w.place_lat), Number(w.place_lng),
      );
      if (km >= WAYPOINT_SUSPECT_KM) {
        outliers.push({ route: w.route_title, place: w.place_name, km });
      }
    }
    outliers.sort((a, b) => b.km - a.km);
    res.waypoint_outliers = outliers.length;
    for (const o of outliers.slice(0, 60)) {
      items.push({
        step: 'wp_outlier',
        place: o.place,
        detail: `${o.km.toFixed(0)} км от маршрута «${o.route}» — проверить связку`,
      });
    }
    if (outliers.length > 60) {
      items.push({ step: 'wp_outlier', detail: `…и ещё ${outliers.length - 60} связок дальше ${WAYPOINT_SUSPECT_KM} км` });
    }
  } catch (err) {
    res.errors++;
    items.push({ step: 'wp_outlier', detail: `диагностика не прошла: ${(err instanceof Error ? err.message : String(err)).slice(0, 80)}` });
  }

  res.duration_ms = Date.now() - t0;
  return res;
}
