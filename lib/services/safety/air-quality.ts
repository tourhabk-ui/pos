/**
 * lib/services/air-quality.ts
 *
 * Качество воздуха по вулканическим зонам Камчатки через IQAir (api.airvisual.com) —
 * дополнительный сигнал к МЧС/КБГС-алертам (lib/services/seismic-parser.ts):
 * пепловый выброс вулкана поднимает PM2.5/AQI в ближайших станциях мониторинга.
 *
 * IQAir не гарантирует станцию мониторинга рядом с удалённым вулканом —
 * "nearest_city" может вернуть станцию за сотни км (реалистично только для
 * Петропавловска-Камчатского/avachinsky). Отсутствие данных — не "плохо",
 * это отдельный флаг, а не 0/null AQI молча.
 *
 * Env: IQAIR_API_KEY (без ключа — функция возвращает null, без ошибки).
 */

import { ZONES, type ZoneKey } from './zone-weather';
import { haversineKm } from '@/lib/field/geo';

export type AqiCategory = 'good' | 'moderate' | 'unhealthy_sensitive' | 'unhealthy' | 'very_unhealthy' | 'hazardous';

export interface ZoneAirQuality {
  zone: ZoneKey;
  zoneName: string;
  aqiUs: number;
  mainPollutant: string | null;
  category: AqiCategory;
  /**
   * Станция, которая эту цифру дала, и как далеко она от зоны.
   *
   * До 23.08.2026 модуль брал из ответа IQAir только `aqius` и `mainus`, а
   * `city`/`state`/координаты выбрасывал. Получалось «Толбачик: AQI 42» без
   * возможности узнать, что мерили в Петропавловске за сотни километров.
   * Замер того же дня: из шести зон отвечают две, обе рядом с городом, —
   * значит вопрос «откуда цифра» не теоретический, он решает, можно ли её
   * вообще показывать.
   *
   * `null` — IQAir станцию не назвал. Это «не знаю», и оно не равно «рядом».
   */
  station: AirStation | null;
}

export interface AirStation {
  /** Как назвал себя источник: город и регион станции. */
  name: string;
  /** Расстояние от центра зоны до станции; null — координат станции нет. */
  distanceKm: number | null;
  /** Годится ли цифра как воздух ЭТОЙ зоны — см. STATION_NEAR_KM. */
  represents: StationProximity;
}

/**
 * Что цифра описывает: саму зону, окрестность или далёкое место.
 *
 * `unknown` — расстояние неизвестно, и выдавать его за близкое нельзя (§4.0).
 */
export type StationProximity = 'zone' | 'nearby' | 'distant' | 'unknown';

/**
 * Почему зона осталась без цифры. До 23.08.2026 все эти случаи возвращали
 * один `null`, и различить их было нельзя ничем.
 *
 * Цена неразличимости измерена в тот же день: по ответу «четыре зоны без
 * данных» был сделан вывод «IQAir не покрывает Толбачик и Ключевскую группу»
 * — вывод, которого данные не выдерживают. Через минуту тот же прод отдал
 * ПУСТОЙ список по всем шести зонам, включая те две, что только что
 * отвечали. Шесть параллельных запросов дважды подряд — это двенадцать
 * обращений в минуту, а у бесплатного плана IQAir предел около десяти.
 * То есть «нет станции» и «нас притормозили» выглядели одинаково.
 */
export type AirFailure =
  | 'no_key'        // ключ не задан
  | 'no_station'    // IQAir ответил, но станции рядом нет
  | 'rate_limited'  // упёрлись в предел плана (429)
  | 'unauthorized'  // ключ не принят (401/403)
  | 'http_error'    // иной отказ провайдера
  | 'network'       // не дозвонились: таймаут или сеть
  | 'malformed';    // ответ пришёл, но без числа

export const FAILURE_LABELS: Record<AirFailure, string> = {
  no_key:       'ключ IQAIR_API_KEY не задан',
  no_station:   'станции рядом с зоной нет',
  rate_limited: 'предел запросов плана IQAir',
  unauthorized: 'ключ не принят провайдером',
  http_error:   'провайдер ответил отказом',
  network:      'не дозвонились до провайдера',
  malformed:    'ответ без числа AQI',
};

export type ZoneAirResult =
  | { ok: true;  data: ZoneAirQuality }
  | { ok: false; reason: AirFailure; status?: number };

/**
 * Порог «это воздух зоны», км. Тридцать — потому что пепловый шлейф на таком
 * расстоянии ещё один и тот же, а городская станция за полсотни километров
 * меряет уже другой воздух: транспорт и котельные, а не вулкан.
 */
export const STATION_NEAR_KM = 30;
/** Дальше этого станция к зоне отношения не имеет — только к региону. */
export const STATION_REGION_KM = 120;

/** Чистая: как далеко станция и что это значит. Без сети и без БД. */
export function stationProximity(distanceKm: number | null): StationProximity {
  if (distanceKm === null) return 'unknown';
  if (distanceKm <= STATION_NEAR_KM) return 'zone';
  if (distanceKm <= STATION_REGION_KM) return 'nearby';
  return 'distant';
}

interface IqAirResponse {
  status: string;
  data?: {
    /** Город станции — IQAir его возвращает, мы его раньше выбрасывали. */
    city?: string;
    state?: string;
    /** GeoJSON: [долгота, широта] — порядок именно такой. */
    location?: { coordinates?: [number, number] };
    current?: {
      pollution?: {
        aqius?: number;
        mainus?: string;
      };
    };
  };
}

export function categorizeAqi(aqi: number): AqiCategory {
  if (aqi <= 50) return 'good';
  if (aqi <= 100) return 'moderate';
  if (aqi <= 150) return 'unhealthy_sensitive';
  if (aqi <= 200) return 'unhealthy';
  if (aqi <= 300) return 'very_unhealthy';
  return 'hazardous';
}

// Последние успешные измерения по зонам — для метрики покрытия (issue #291):
// «свежесть» сигнала = был ли успешный ответ IQAir за последние 6 часов.
// In-memory достаточно: метрика про живость внешнего сигнала, не про историю.
const lastSuccess = new Map<ZoneKey, { at: number; aqiUs: number; station: AirStation | null }>();

/**
 * Кэш ответа по зоне. У соседнего `getZoneWeather` он есть с самого начала, у
 * воздуха не было вовсе — и это при том, что бесплатный план IQAir куда
 * скупее погодного. Каждый показ панели здоровья бил шестью параллельными
 * запросами, а две страницы подряд уже упирались в предел.
 *
 * Успех держим полчаса: AQI так быстро не меняется. Отказ — пять минут:
 * исправленный ключ должен заработать без ожидания, но и долбить провайдера
 * в упор нельзя.
 */
const _cache = new Map<ZoneKey, { result: ZoneAirResult; at: number }>();
const CACHE_OK_MS = 30 * 60 * 1000;
const CACHE_FAIL_MS = 5 * 60 * 1000;

/** Для тестов: забыть кэш между кейсами. */
export function clearAirQualityCache(): void {
  _cache.clear();
}

/** Для тестов: сброс стора свежести между кейсами */
export function clearAirQualityFreshness(): void {
  lastSuccess.clear();
}

/**
 * Кто ответил и откуда. Ничего не выдумывает: нет имени — нет станции, нет
 * координат — расстояние `null`, а не ноль.
 */
function readStation(res: IqAirResponse, zoneLat: number, zoneLon: number): AirStation | null {
  const city = res.data?.city?.trim();
  const state = res.data?.state?.trim();
  if (!city && !state) return null;

  const coords = res.data?.location?.coordinates;
  // GeoJSON — [lon, lat]. Перепутать местами здесь значит получить станцию в
  // океане и «расстояние» в тысячи километров, выглядящее как настоящее.
  const distanceKm = Array.isArray(coords) && coords.length === 2
    && Number.isFinite(coords[0]) && Number.isFinite(coords[1])
    ? Math.round(haversineKm(zoneLat, zoneLon, coords[1], coords[0]))
    : null;

  return {
    name: [city, state].filter(Boolean).join(', '),
    distanceKm,
    represents: stationProximity(distanceKm),
  };
}

/**
 * Качество воздуха зоны — с названной причиной, если цифры нет.
 *
 * Возвращает результат, а не `null`: «станции нет» и «нас притормозили» — это
 * разные ответы, и по ним принимают разные решения. Первое означает, что зона
 * этим источником не покрывается никогда; второе — что спросили слишком часто
 * и надо просто подождать.
 */
export async function getZoneAirQuality(zoneKey: ZoneKey): Promise<ZoneAirResult> {
  const cached = _cache.get(zoneKey);
  if (cached && Date.now() - cached.at < (cached.result.ok ? CACHE_OK_MS : CACHE_FAIL_MS)) {
    return cached.result;
  }

  const remember = (result: ZoneAirResult): ZoneAirResult => {
    _cache.set(zoneKey, { result, at: Date.now() });
    return result;
  };

  // Обрезка обязательна: значение из пробелов проходит проверку на
  // truthiness и уезжает в URL как ключ. Провайдер отвечает отказом, а
  // платформа считает, что ключ задан, — 09.08 это уже стоило дня разбора.
  const apiKey = (process.env.IQAIR_API_KEY ?? '').trim();
  if (apiKey === '') return remember({ ok: false, reason: 'no_key' });

  const zone = ZONES[zoneKey];
  try {
    const res = await fetch(
      `https://api.airvisual.com/v2/nearest_city?lat=${zone.lat}&lon=${zone.lon}&key=${apiKey}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (!res.ok) {
      // 429 у IQAir — самый частый отказ на бесплатном плане, и раньше он был
      // неотличим от «нет станции». Разница решает: ждать или не спрашивать.
      const reason: AirFailure = res.status === 429 ? 'rate_limited'
        : res.status === 401 || res.status === 403 ? 'unauthorized'
        : 'http_error';
      return remember({ ok: false, reason, status: res.status });
    }

    const data = await res.json() as IqAirResponse;
    const aqi = data?.data?.current?.pollution?.aqius;
    if (typeof aqi !== 'number') {
      // `status: "fail"` — источник ответил и станции у него нет. Это единственный
      // случай, который вправе называться отсутствием покрытия.
      return remember({
        ok: false,
        reason: data?.status === 'success' ? 'malformed' : 'no_station',
      });
    }

    const station = readStation(data, zone.lat, zone.lon);
    lastSuccess.set(zoneKey, { at: Date.now(), aqiUs: aqi, station });

    return remember({
      ok: true,
      data: {
        zone: zoneKey,
        zoneName: zone.name,
        aqiUs: aqi,
        mainPollutant: data.data?.current?.pollution?.mainus ?? null,
        category: categorizeAqi(aqi),
        station,
      },
    });
  } catch (err) {
    // Отказ сети не выдаём за отсутствие станции и не глушим совсем: имя
    // зоны и текст ошибки — в лог, иначе поломка неотличима от тишины (§4.0).
    console.error(`[air-quality] зона ${zoneKey}: запрос не выполнился:`,
      err instanceof Error ? err.message : err);
    return remember({ ok: false, reason: 'network' });
  }
}

export async function getAllZonesAirQuality(): Promise<ZoneAirQuality[]> {
  const results = await getAllZonesAirOutcomes();
  return results.filter((r): r is { key: ZoneKey; result: { ok: true; data: ZoneAirQuality } } =>
    r.result.ok).map(r => r.result.data);
}

/** Все зоны с исходом каждой — для диагностики и покрытия. */
export async function getAllZonesAirOutcomes(): Promise<Array<{ key: ZoneKey; result: ZoneAirResult }>> {
  const keys = Object.keys(ZONES) as ZoneKey[];
  const results = await Promise.all(keys.map(async key => ({ key, result: await getZoneAirQuality(key) })));
  return results;
}

// ── Метрика покрытия (issue #291) ─────────────────────────────────────────────

/** Свежим считаем сигнал не старше 6 часов — пепловая обстановка меняется быстрее суток */
const FRESHNESS_WINDOW_MS = 6 * 60 * 60 * 1000;

export interface ZoneCoverage {
  zone: ZoneKey;
  zoneName: string;
  fresh: boolean;
  /** Возраст последнего успешного измерения в минутах; null — данных не было вовсе */
  ageMinutes: number | null;
  /**
   * Кто ответил за эту зону и как далеко он от неё.
   *
   * Покрытие без этого поля отвечает «данные есть», умалчивая, что мерили за
   * сотни километров. Замер 23.08: отвечают две зоны из шести, обе рядом с
   * Петропавловском, — то есть вопрос «откуда цифра» решает, годится ли
   * сигнал вообще.
   */
  station: AirStation | null;
  /**
   * Почему цифры нет. `null` — она есть.
   *
   * Без этого поля «четыре зоны без данных» читается как «источник их не
   * покрывает», хотя на деле это мог быть предел запросов. Ровно так 23.08 и
   * ошиблись, приняв одно за другое.
   */
  failure: AirFailure | null;
}

export interface CoverageStats {
  total_zones: number;
  zones_with_fresh_data: number;
  stale_zones: ZoneCoverage[];
  coverage_pct: number;
  zones: ZoneCoverage[];
}

/**
 * Пробует все вулканические зоны и считает долю с живым (<6ч) сигналом IQAir.
 * Проба обновляет lastSuccess внутри getZoneAirQuality, поэтому зона, ответившая
 * сейчас, всегда fresh; упавшая — fresh только если недавно отвечала.
 */
export async function getCoverageStats(): Promise<CoverageStats> {
  const outcomes = await getAllZonesAirOutcomes();
  const byKey = new Map(outcomes.map(o => [o.key, o.result]));

  const now = Date.now();
  const zones: ZoneCoverage[] = outcomes.map(({ key }) => {
    const last = lastSuccess.get(key);
    const ageMs = last ? now - last.at : null;
    const result = byKey.get(key);
    return {
      zone: key,
      zoneName: ZONES[key].name,
      fresh: ageMs !== null && ageMs < FRESHNESS_WINDOW_MS,
      ageMinutes: ageMs !== null ? Math.round(ageMs / 60_000) : null,
      station: last?.station ?? null,
      failure: result !== undefined && !result.ok ? result.reason : null,
    };
  });

  const freshCount = zones.filter(z => z.fresh).length;
  return {
    total_zones: zones.length,
    zones_with_fresh_data: freshCount,
    stale_zones: zones.filter(z => !z.fresh),
    coverage_pct: zones.length > 0 ? Math.round((freshCount / zones.length) * 100) : 0,
    zones,
  };
}
