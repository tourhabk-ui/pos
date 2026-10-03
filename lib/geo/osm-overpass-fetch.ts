/**
 * Выборка именованных объектов OSM по краю — только сеть, без базы (03.10).
 *
 * Отдельно от раннера сверки (lib/geo/osm-crosscheck-runner), потому что зовут
 * её из двух мест с разными возможностями:
 *
 *   - прод (GET /api/cron/places-osm-crosscheck) — короткие таймауты: запрос
 *     живёт под потолком роута;
 *   - раннер GitHub — прежде здесь; 03.10 раннер перешёл на выгрузку
 *     Geofabrik (scripts/osm-crosscheck-from-geojson.ts): Overpass квадратами
 *     прошёл 38 из 42 и упал на 504 у всех четырёх серверов.
 *
 * Повод для второго пути. 03.10 публичные Overpass (overpass-api.de, kumi,
 * private.coffee, maps.mail.ru) не отдали за 40 секунд даже один квадрат
 * 3.5° × 4° вокруг Петропавловска — ни проду, ни раннеру. Сверка не
 * проходила с 10.09, и «Гору Замок» в 6 км от её вершины за это время нашёл
 * турист. Раннер может ждать минутами, прод — нет. База на раннере закрыта
 * файрволом, поэтому имена сравнивает прод, а сеть — раннер.
 *
 * Модуль не импортирует пул БД намеренно: скрипт раннера грузит его без
 * DATABASE_URL.
 */
import {
  buildOsmCrosscheckQuery, parseOsmFeatures, splitBounds,
  type GeoBounds, type OsmFeature,
} from '@/lib/geo/osm-crosscheck';

/** Прод: основной сервер и зеркало Kumi (406 без осмысленного User-Agent). */
export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];


const OSM_HEADERS = {
  'Content-Type': 'application/x-www-form-urlencoded',
  'Accept': 'application/json',
  'User-Agent': 'KamchatourHub-OSM-Crosscheck/1.0 (+https://vedarai.ru)',
};

export interface OverpassFetchOptions {
  endpoints?: string[];
  /** Пауза между квадратами: у публичного Overpass два слота на адрес. */
  tilePauseMs?: number;
  /** Сколько ждать ответа на квадрат, мс. */
  tileTimeoutMs?: number;
  /** Таймаут запроса на стороне Overpass, с (меньше tileTimeoutMs). */
  queryTimeoutS?: number;
  latStep?: number;
  lngStep?: number;
  /** Сколько раз обойти все серверы по одному квадрату. */
  rounds?: number;
  /** Пауза перед следующим кругом, мс. */
  roundPauseMs?: number;
  /** Ход выборки — в лог раннера; на проде не нужен. */
  onTile?: (info: { index: number; total: number; tile: GeoBounds; features: number; via: string }) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Один квадрат: серверы по очереди, несколько кругов. Отказ — со ВСЕМИ
 * причинами: прежде печаталась только последняя (504 зеркала), а причина
 * отказа основного сервера терялась.
 */
async function fetchTile(tile: GeoBounds, o: Required<Omit<OverpassFetchOptions, 'onTile'>>): Promise<{ features: OsmFeature[]; via: string }> {
  const body = `data=${encodeURIComponent(buildOsmCrosscheckQuery(tile, o.queryTimeoutS))}`;
  const errors: string[] = [];
  for (let round = 0; round < o.rounds; round += 1) {
    if (round > 0) await sleep(o.roundPauseMs);
    for (const endpoint of o.endpoints) {
      const host = new URL(endpoint).host;
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: OSM_HEADERS,
          body,
          signal: AbortSignal.timeout(o.tileTimeoutMs),
        });
        if (!res.ok) { errors.push(`${host}: HTTP ${res.status}`); continue; }
        const data = (await res.json()) as { remark?: string };
        // Overpass отвечает 200 и при собственном таймауте — с remark и пустым
        // списком. Пустота здесь — «не смог», а не «объектов нет».
        if (typeof data.remark === 'string' && /error|timed out/i.test(data.remark)) {
          errors.push(`${host}: ${data.remark.slice(0, 120)}`);
          continue;
        }
        return { features: parseOsmFeatures(data), via: host };
      } catch (err) {
        errors.push(`${host}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  const box = `${tile.latMin}–${tile.latMax}° × ${tile.lngMin}–${tile.lngMax}°`;
  throw new Error(`Overpass, квадрат ${box}: ${errors.join('; ')}`);
}

/**
 * Все именованные объекты края — квадратами (splitBounds). Хоть один
 * квадрат не прочитан — отказ целиком с его именем: неполный список выглядел
 * бы как «в этом районе расхождений нет» (§4.0).
 */
export async function fetchOsmFeatures(bounds: GeoBounds, opts: OverpassFetchOptions = {}): Promise<OsmFeature[]> {
  const o = {
    endpoints: opts.endpoints ?? OVERPASS_ENDPOINTS,
    tilePauseMs: opts.tilePauseMs ?? 1_000,
    tileTimeoutMs: opts.tileTimeoutMs ?? 45_000,
    queryTimeoutS: opts.queryTimeoutS ?? 40,
    latStep: opts.latStep ?? 3.5,
    lngStep: opts.lngStep ?? 4,
    rounds: opts.rounds ?? 1,
    roundPauseMs: opts.roundPauseMs ?? 30_000,
  };
  const byKey = new Map<string, OsmFeature>();
  const tiles = splitBounds(bounds, o.latStep, o.lngStep);
  for (let i = 0; i < tiles.length; i += 1) {
    if (i > 0 && o.tilePauseMs > 0) await sleep(o.tilePauseMs);
    const { features, via } = await fetchTile(tiles[i], o);
    // Объект на границе квадратов приходит дважды — склеиваем по роду и id.
    for (const f of features) byKey.set(`${f.kind}:${f.id}`, f);
    opts.onTile?.({ index: i, total: tiles.length, tile: tiles[i], features: features.length, via });
  }
  return [...byKey.values()];
}
