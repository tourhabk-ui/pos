/**
 * Высоты треков из DEM — единственный оставшийся путь к рельефу.
 *
 * Проба прода 09.08 (`/api/cron/idilesom-tracks?mode=inspect`) закрыла надежду
 * на первоисточник: у idilesom координаты двухэлементные на всех проверенных
 * страницах, `pointsWithThird: 0`. Высот там нет вовсе — терять их парсеру
 * было нечего, и перезалив не дал бы ни одной. Из 338 треков прода высоты
 * несут 6. Пока их нет, профиль на «На маршруте» честно остаётся тёмным, а
 * блок ETA не может считать набор — то есть главное число, по которому турист
 * решает, идти ли сегодня, не считается вообще.
 *
 * Отсюда дозаполнение из модели рельефа (SRTM 30 м через OpenTopoData).
 * Правила, без которых это была бы очередная красивая ложь:
 *
 *   1. Источник называется. В geometry пишется `elevation_source`, и экран
 *      обязан отличать «высоты из DEM» от «высоты из GPS-трека».
 *   2. Чаще разрешения DEM не спрашиваем. Точки ближе 25 м попадают в ту же
 *      ячейку модели, и лишний запрос дал бы то же число, а не деталь.
 *   3. Между отсчётами интерполируем линейно по пройденному расстоянию.
 *      Детали мельче ячейки у источника нет — придумывать её мы не вправе,
 *      а ступенька «плоско-скачок» добавила бы перепад, которого нет.
 *   4. Явно плохой ответ не пишем. Дыры над водой, промахи по диапазону
 *      Камчатки (высшая точка — Ключевская, 4750 м) и редкое покрытие
 *      означают «модель здесь не знает», а не «здесь равнина».
 */

import { pool } from '@/lib/db-pool';
import { haversineM, MIN_ELEVATION_COVERAGE } from '@/lib/routes/relief';

/** Ячейка SRTM 30 м: спрашивать чаще — тратить лимит на тот же ответ. */
export const DEM_SAMPLE_STEP_M = 25;
/** Публичный OpenTopoData принимает не больше сотни точек за запрос. */
export const DEM_BATCH = 100;
/** И не чаще запроса в секунду. */
export const DEM_MIN_INTERVAL_MS = 1100;
/** Правдоподобный диапазон высот для Камчатки: высшая точка — 4750 м. */
export const DEM_MIN_M = -20;
export const DEM_MAX_M = 5000;
/** Меньше этой доли отвеченных отсчётов — модель здесь не знает. */
export const DEM_MIN_ANSWERED = 0.8;

const DEM_URL = process.env.DEM_API_URL ?? 'https://api.opentopodata.org/v1/srtm30m';
const DEM_NAME = process.env.DEM_API_NAME ?? 'srtm30m';

export interface DemPoint { lat: number; lng: number }

/** Высота отсчёта или null, если модель по нему промолчала. */
export type DemElevation = number | null;

interface OpenTopoResponse {
  status?: string;
  error?: string;
  results?: Array<{ elevation: number | null }>;
}

function plausible(v: unknown): DemElevation {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (v < DEM_MIN_M || v > DEM_MAX_M) return null;
  return Math.round(v);
}

/**
 * Сколько ждём ответа модели. Без своего предела зависший внешний хост
 * висит бесконечно: бюджет прогона проверяется МЕЖДУ запросами, и застряв
 * внутри одного, роут не возвращается вовсе. Прогон 09.08 так и оборвался —
 * партия 7 висела три минуты, пока не сработал таймаут curl в workflow.
 * Свой предел превращает зависание в обычную ошибку партии.
 */
export const DEM_REQUEST_TIMEOUT_MS = 20_000;

/**
 * Спросить у модели высоты пачки точек. Возвращает массив той же длины:
 * позиция без ответа остаётся null, а не подменяется соседом.
 */
export async function fetchDemBatch(points: DemPoint[], fetchImpl = fetch): Promise<DemElevation[]> {
  if (points.length === 0) return [];
  const locations = points.map(p => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`).join('|');
  let res: Response;
  try {
    res = await fetchImpl(DEM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locations }),
      signal: AbortSignal.timeout(DEM_REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new Error(`DEM не ответил за ${DEM_REQUEST_TIMEOUT_MS / 1000} с`);
    }
    throw err;
  }
  // 429 — исчерпан суточный лимит источника, а не сбой. Формулировка важна:
  // иначе следующий прогон будут чинить, а чинить нечего — надо подождать.
  if (res.status === 429) throw new Error('DEM: лимит запросов исчерпан, продолжить позже');
  if (!res.ok) throw new Error(`DEM HTTP ${res.status}`);
  const data = (await res.json()) as OpenTopoResponse;
  if (data.status && data.status !== 'OK') {
    throw new Error(`DEM ${data.status}: ${(data.error ?? '').slice(0, 120)}`);
  }
  const results = data.results ?? [];
  return points.map((_, i) => plausible(results[i]?.elevation));
}

/**
 * Номера точек трека, которые стоит спросить у модели: первая, последняя и
 * дальше по шагу ячейки. Возвращает индексы исходного массива — так ответ
 * потом кладётся обратно без пересчёта координат.
 */
export function sampleIndices(track: DemPoint[], stepM = DEM_SAMPLE_STEP_M): number[] {
  if (track.length <= 2) return track.map((_, i) => i);
  const out = [0];
  let acc = 0;
  for (let i = 1; i < track.length; i++) {
    acc += haversineM(track[i - 1], track[i]);
    if (acc >= stepM) { out.push(i); acc = 0; }
  }
  if (out[out.length - 1] !== track.length - 1) out.push(track.length - 1);
  return out;
}

/**
 * Разложить ответы модели по всем точкам трека: между отсчётами — линейно по
 * пройденному расстоянию. Отсчёт без ответа выпадает, и его пролёт закрывают
 * соседние; если крайние молчат, край берёт ближайший известный.
 *
 * Возвращает null там, где известных отсчётов не нашлось вовсе — такой трек
 * писать нельзя.
 */
export function spreadElevations(
  track: DemPoint[],
  indices: number[],
  values: DemElevation[],
): Array<number | null> {
  const known: Array<{ i: number; z: number; d: number }> = [];
  const dist: number[] = [0];
  for (let i = 1; i < track.length; i++) dist[i] = dist[i - 1] + haversineM(track[i - 1], track[i]);

  indices.forEach((idx, k) => {
    const z = values[k];
    if (z !== null && z !== undefined) known.push({ i: idx, z, d: dist[idx] });
  });
  if (known.length === 0) return track.map(() => null);

  const out: Array<number | null> = [];
  let seg = 0;
  for (let i = 0; i < track.length; i++) {
    while (seg < known.length - 1 && known[seg + 1].i < i) seg++;
    const a = known[seg];
    const b = known[Math.min(seg + 1, known.length - 1)];
    if (i <= a.i || a.i === b.i) { out.push(a.z); continue; }
    if (i >= b.i) { out.push(b.z); continue; }
    const span = b.d - a.d;
    const t = span > 0 ? (dist[i] - a.d) / span : 0;
    out.push(Math.round(a.z + (b.z - a.z) * t));
  }
  return out;
}

export interface RouteGeometryRow {
  id: string;
  title: string;
  geometry: { type?: string; coordinates?: unknown; source?: string } | null;
}

/** Трек в виде точек. Порядок координат GeoJSON: [lng, lat]. */
export function readTrack(geometry: RouteGeometryRow['geometry']): DemPoint[] {
  const raw = geometry?.coordinates;
  if (!Array.isArray(raw)) return [];
  const out: DemPoint[] = [];
  for (const c of raw) {
    if (!Array.isArray(c) || c.length < 2) return [];
    const lng = Number(c[0]);
    const lat = Number(c[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
    out.push({ lat, lng });
  }
  return out;
}

export interface BackfillResult {
  checked: number;
  written: number;
  skipped_no_data: number;
  failed: number;
  points_queried: number;
  duration_ms: number;
  /** Почему прогон закончился раньше выборки — пусто, если прошёл штатно. */
  stopped?: string;
  items: Array<{ route: string; points: number; queried: number; status: string; min?: number; max?: number }>;
  errors: string[];
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

/**
 * Дозаполнить высоты маршрутам без них. Идёт партиями и по бюджету времени:
 * публичный DEM отвечает раз в секунду, а серверный роут живёт две минуты.
 */
export async function backfillDemElevations(opts: {
  limit?: number;
  budgetMs?: number;
  fetchImpl?: typeof fetch;
} = {}): Promise<BackfillResult> {
  const started = Date.now();
  const limit = Math.min(Math.max(opts.limit ?? 5, 1), 50);
  const budgetMs = opts.budgetMs ?? 90_000;
  const fetchImpl = opts.fetchImpl ?? fetch;

  const res: BackfillResult = {
    checked: 0, written: 0, skipped_no_data: 0, failed: 0,
    points_queried: 0, duration_ms: 0, items: [], errors: [],
  };

  // Берём только треки без высот и без отметки о прошлой попытке: иначе
  // маршрут, по которому модель молчит, будет вечно съедать лимит.
  const { rows } = await pool.query<RouteGeometryRow>(
    `SELECT id, title, geometry
       FROM kamchatka_routes
      WHERE geometry IS NOT NULL
        AND geometry->>'elevation_source' IS NULL
        AND jsonb_typeof(geometry->'coordinates') = 'array'
        AND jsonb_array_length(geometry->'coordinates') >= 2
        AND (
          SELECT count(*)
            FROM jsonb_array_elements(geometry->'coordinates') AS c
           -- Проверка типа обязательна: jsonb_array_length падает на элементе,
           -- который массивом не является, и один битый трек уронил бы выборку
           -- для всех остальных.
           WHERE jsonb_typeof(c) = 'array' AND jsonb_array_length(c) >= 3
        )::float / jsonb_array_length(geometry->'coordinates') < $1
      ORDER BY jsonb_array_length(geometry->'coordinates') ASC
      LIMIT $2`,
    [MIN_ELEVATION_COVERAGE, limit],
  );

  let lastCall = 0;
  for (const row of rows) {
    if (res.stopped) break;
    if (Date.now() - started > budgetMs) break;
    res.checked++;
    const track = readTrack(row.geometry);
    if (track.length < 2) {
      res.failed++;
      res.items.push({ route: row.title, points: 0, queried: 0, status: 'трек не читается' });
      continue;
    }

    const indices = sampleIndices(track);
    const values: DemElevation[] = [];
    let broke = false;
    for (let i = 0; i < indices.length; i += DEM_BATCH) {
      if (Date.now() - started > budgetMs) { broke = true; break; }
      const wait = DEM_MIN_INTERVAL_MS - (Date.now() - lastCall);
      if (wait > 0) await sleep(wait);
      lastCall = Date.now();
      try {
        values.push(...await fetchDemBatch(indices.slice(i, i + DEM_BATCH).map(k => track[k]), fetchImpl));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        res.errors.push(`${row.title}: ${msg}`.slice(0, 200));
        broke = true;
        // Исчерпанный лимит источника — не сбой одного маршрута, а конец
        // прогона: следующие пойдут в ту же стену и только съедят время,
        // а в логе останется двадцать одинаковых ошибок вместо одной ясной.
        if (msg.includes('лимит запросов')) res.stopped = msg;
        break;
      }
    }
    res.points_queried += values.length;
    if (broke) { res.failed++; continue; }

    const answered = values.filter(v => v !== null).length;
    if (answered / Math.max(values.length, 1) < DEM_MIN_ANSWERED) {
      // Молчание модели помечаем, чтобы не спрашивать снова: это ответ
      // «здесь не знаю», а не сбой связи.
      await pool.query(
        `UPDATE kamchatka_routes
            SET geometry = geometry || jsonb_build_object('elevation_source', 'none')
          WHERE id = $1`,
        [row.id],
      );
      res.skipped_no_data++;
      res.items.push({ route: row.title, points: track.length, queried: values.length, status: 'модель не знает' });
      continue;
    }

    const spread = spreadElevations(track, indices, values);
    const coords = track.map((p, i) => (spread[i] === null ? [p.lng, p.lat] : [p.lng, p.lat, spread[i]]));
    const zs = spread.filter((z): z is number => z !== null);

    await pool.query(
      `UPDATE kamchatka_routes
          SET geometry = geometry
              || jsonb_build_object('coordinates', $2::jsonb)
              || jsonb_build_object('elevation_source', $3::text)
        WHERE id = $1`,
      [row.id, JSON.stringify(coords), DEM_NAME],
    );
    res.written++;
    res.items.push({
      route: row.title, points: track.length, queried: values.length,
      status: 'высоты записаны', min: Math.min(...zs), max: Math.max(...zs),
    });
  }

  res.duration_ms = Date.now() - started;
  return res;
}

/**
 * Проба источника с известных точек. Достижимость — половина ответа: модель
 * может отвечать и врать, поэтому спрашиваем места с заранее известной
 * высотой и печатаем, что она сказала.
 */
export const DEM_PROBE_POINTS: Array<{ name: string; lat: number; lng: number; expect: string }> = [
  { name: 'Ключевская сопка (вершина)', lat: 56.0564, lng: 160.6417, expect: '≈4750 м' },
  { name: 'Авачинская бухта (вода)', lat: 52.9000, lng: 158.5000, expect: '≈0 м' },
  { name: 'Петропавловск-Камчатский', lat: 53.0195, lng: 158.6483, expect: 'десятки метров' },
];

export async function probeDem(fetchImpl = fetch): Promise<{
  url: string; dataset: string;
  points: Array<{ name: string; expect: string; got: DemElevation }>;
}> {
  const got = await fetchDemBatch(DEM_PROBE_POINTS, fetchImpl);
  return {
    url: DEM_URL,
    dataset: DEM_NAME,
    points: DEM_PROBE_POINTS.map((p, i) => ({ name: p.name, expect: p.expect, got: got[i] ?? null })),
  };
}
