/**
 * Пожарный слой safety-ingest: спутниковые термоточки NASA FIRMS (VIIRS).
 *
 * Зачем: лесные пожары — реальная сезонная опасность Камчатки, но до 27.07
 * конвейер их видел только через новости kamgov/МЧС (текст, без координат).
 * FIRMS даёт детерминированные координатные данные: спутник видит очаг —
 * строка в CSV, не видит — строки нет. Никакой интерпретации модели.
 *
 * API: https://firms.modaps.eosdis.nasa.gov/api/area/csv/{KEY}/VIIRS_SNPP_NRT/{bbox}/{days}
 * Ключ бесплатный (регистрация MAP_KEY), env FIRMS_MAP_KEY. Без ключа источник
 * молчит — тот же паттерн, что VK_SERVICE_TOKEN у ingestVkMchs.
 *
 * Термоточка ≠ пожар (бывают вулканические термали, промышленные источники),
 * поэтому: фильтр по уверенности (nominal/high), кластеризация — десяток
 * строк одного пожара становится одним алертом, и severity растёт только с
 * масштабом кластера. Alert-тип 'fire_danger' уже существует в external_alerts
 * (им пользуется классификатор МЧС-новостей) — карточки маршрутов и
 * updateRealTimeStatus подхватывают пожарные алерты без единой правки UI.
 */
import { saveEvent, type ParseResult, type SeismicEvent } from '@/lib/services/safety/seismic-parser';
import { query } from '@/lib/database';
import {
  DEFAULT_RADIUS_KM,
  KAMCHATKA_BBOX,
  distanceKm as geoDistanceKm,
  judgeStatic,
  parseFirmsRows,
  persistentClusters,
  type NearFeature,
  type StaticReason,
} from '@/lib/services/safety/firms-persistence';

// Камчатка с запасом: юг Курил не берём, Чукотку не берём. Определение живёт
// в чистом модуле firms-persistence, чтобы перепись (только чтение) не
// тянула сюда за константой код, который пишет в базу.
export { KAMCHATKA_BBOX };

export interface FirmsHotspot {
  lat: number;
  lng: number;
  /** Fire Radiative Power, МВт — мощность очага по спутнику. */
  frp: number;
  /** l | n | h (VIIRS) или 0-100 (MODIS) — нормализуем в l/n/h. */
  confidence: 'l' | 'n' | 'h';
  acqDate: string; // YYYY-MM-DD
}

/**
 * Разбор CSV FIRMS. Колонки ищем по заголовку (порядок в API стабилен, но
 * жёсткие индексы ломаются молча — по имени честнее).
 * Отбрасываем: низкую уверенность ('l' / <30), точки вне бокса, битые строки.
 */
export function parseFirmsCsv(csv: string): FirmsHotspot[] {
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return [];

  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const iLat = col('latitude');
  const iLng = col('longitude');
  const iConf = col('confidence');
  const iFrp = col('frp');
  const iDate = col('acq_date');
  if (iLat < 0 || iLng < 0 || iDate < 0) return [];

  const out: FirmsHotspot[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    const lat = parseFloat(cells[iLat]);
    const lng = parseFloat(cells[iLng]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    if (lat < KAMCHATKA_BBOX.south || lat > KAMCHATKA_BBOX.north) continue;
    if (lng < KAMCHATKA_BBOX.west || lng > KAMCHATKA_BBOX.east) continue;

    const rawConf = (cells[iConf] ?? '').trim().toLowerCase();
    let confidence: FirmsHotspot['confidence'];
    if (rawConf === 'l' || rawConf === 'n' || rawConf === 'h') {
      confidence = rawConf;
    } else {
      const num = parseFloat(rawConf);
      confidence = !Number.isFinite(num) ? 'l' : num >= 80 ? 'h' : num >= 30 ? 'n' : 'l';
    }
    if (confidence === 'l') continue;

    const frp = parseFloat(cells[iFrp] ?? '');
    const acqDate = (cells[iDate] ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(acqDate)) continue;

    out.push({ lat, lng, frp: Number.isFinite(frp) ? frp : 0, confidence, acqDate });
  }
  return out;
}

export interface FireCluster {
  lat: number;
  lng: number;
  count: number;
  frpSum: number;
  acqDate: string;
}

const EARTH_KM = 6371;
function distanceKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(s));
}

/**
 * Жадная кластеризация: один пожар даёт десятки термоточек — туристу нужен
 * один алерт «очаг там-то», а не двадцать. Центроид пересчитывается по мере
 * присоединения точек.
 */
export function clusterHotspots(points: FirmsHotspot[], radiusKm = 10): FireCluster[] {
  const clusters: FireCluster[] = [];
  for (const p of points) {
    const near = clusters.find((c) => distanceKm(c.lat, c.lng, p.lat, p.lng) <= radiusKm);
    if (near) {
      near.lat = (near.lat * near.count + p.lat) / (near.count + 1);
      near.lng = (near.lng * near.count + p.lng) / (near.count + 1);
      near.count += 1;
      near.frpSum += p.frp;
      if (p.acqDate > near.acqDate) near.acqDate = p.acqDate;
    } else {
      clusters.push({ lat: p.lat, lng: p.lng, count: 1, frpSum: p.frp, acqDate: p.acqDate });
    }
  }
  return clusters;
}

/** Та же зональная логика, что у землетрясений в seismic-parser. */
function zonesFor(lat: number, lng: number): string[] {
  if (lat >= 55.5) return ['northern'];
  if (lat >= 52 && lng >= 161) return ['eastern'];
  return ['avachinsky'];
}

/**
 * Кластер → событие external_alerts.
 *
 * severity консервативна: одиночная точка — 0 (информация: возможна вулканическая
 * термаль), заметный очаг — 1, крупный (10+ точек или суммарный FRP ≥ 150 МВт) —
 * 2 (порог push-рассылки). external_id стабилен на день+ячейку ~10 км: тот же
 * пожар в течение дня не плодит алерты (ON CONFLICT DO NOTHING), новый день —
 * новый алерт, и это честно: пожар «всё ещё горит» — значимая новость.
 */
export function wildfireEvents(clusters: FireCluster[]): SeismicEvent[] {
  return clusters.map((c) => {
    const severity: 0 | 1 | 2 = c.count >= 10 || c.frpSum >= 150 ? 2 : c.count >= 3 || c.frpSum >= 30 ? 1 : 0;
    const zones = zonesFor(c.lat, c.lng);
    const coords = `${c.lat.toFixed(2)}°N ${c.lng.toFixed(2)}°E`;
    return {
      source_id: `firms/${c.acqDate}/${c.lat.toFixed(1)},${c.lng.toFixed(1)}`,
      source_url: 'https://firms.modaps.eosdis.nasa.gov/map/',
      published_at: new Date(`${c.acqDate}T00:00:00Z`),
      alert_type: 'fire_danger',
      severity,
      title: `Термоточки (возможен пожар): ${c.count} очаг(ов), ${coords}`,
      description:
        `Спутник VIIRS зафиксировал ${c.count} термоточек (суммарная мощность ~${Math.round(c.frpSum)} МВт) ` +
        `в районе ${coords}. Источник: NASA FIRMS. Термоточка не всегда пожар (вулканические термали, ` +
        `промышленные источники), но в пожароопасный сезон — повод сверить маршрут.`,
      affected_zones: zones,
      lat: c.lat,
      lng: c.lng,
      expires_hours: 48,
    };
  });
}

/** Типы мест, которые сами дают постоянное тепло: вулкан, гейзер, горячий источник. */
const HEAT_FEATURE_TYPES = ['volcano', 'geyser', 'hot_spring'];

/**
 * Что из нашего каталога греет само. `null` — спросить не получилось (и
 * вызывающий НЕ гасит тревогу, §4.0); пустой список — спросили, таких мест нет.
 * Отказ базы не глушится: имя проверки и SQLSTATE идут в лог.
 */
async function loadHeatFeatures(): Promise<Array<{ name: string; type: string | null; lat: number; lng: number }> | null> {
  try {
    const { rows } = await query<{ name: string; location_type: string | null; lat: number; lng: number }>(
      `SELECT name, location_type, lat::float AS lat, lng::float AS lng
         FROM places
        WHERE is_visible = TRUE AND merged_into_id IS NULL
          AND location_type = ANY($1::text[])`,
      [HEAT_FEATURE_TYPES],
    );
    return rows.map((r) => ({ name: r.name, type: r.location_type, lat: r.lat, lng: r.lng }));
  } catch (e) {
    const err = e as { code?: string; message?: string };
    console.error('[wildfire-firms] places для проверки постоянного источника не прочитаны', err.code, err.message);
    return null;
  }
}

/**
 * Снять уже лежащие тревоги по месту, которое теперь признано постоянным
 * источником. Без этого точка продолжала бы висеть на радаре ещё двое суток
 * после правки: запись, продлённая дедупом, живёт своим сроком. Срок только
 * СОКРАЩАЕТСЯ до «сейчас» (приём meteoalert.retractWithdrawn): строка остаётся
 * в базе и перестаёт действовать. Радиус — радиус кластера, не «рядом с
 * вулканом»: настоящий очаг в нескольких километрах от конуса не задевается.
 */
async function retractStaticAlerts(lat: number, lng: number): Promise<number> {
  const r = await query<{ id: string }>(
    `UPDATE external_alerts
        SET expires_at = NOW()
      WHERE alert_type = 'fire_danger'
        AND external_id LIKE 'firms/%'
        AND expires_at > NOW()
        AND lat IS NOT NULL AND lng IS NOT NULL
        AND 6371 * 2 * asin(sqrt(
              power(sin(radians(lat::float8 - $1::float8) / 2), 2) +
              cos(radians($1::float8)) * cos(radians(lat::float8)) *
              power(sin(radians(lng::float8 - $2::float8) / 2), 2)
            )) <= $3::float8
      RETURNING id::text`,
    [lat, lng, DEFAULT_RADIUS_KM],
  );
  return r.rows.length;
}

/** Термоточки, которые приём НЕ превратил в тревогу, и почему — чтобы подавление было видно, а не молчаливо. */
export interface SuppressedFirms {
  lat: number;
  lng: number;
  days: number;
  detections_today: number;
  nearest: string;
  nearest_km: number;
  /** Сколько уже действовавших тревог по этому месту снято (0 — их не было или снять не удалось, см. errors). */
  retracted: number;
}

/**
 * Полный ingest: fetch CSV → parse → отсев постоянных источников → cluster → save.
 * Без FIRMS_MAP_KEY молчим (опциональный источник, как VK).
 *
 * ── Постоянный источник тепла — не пожар (скрин владельца 09.10) ──────────
 *
 * Окно 5 суток (было 1): по одним суткам не видно, что точка стоит на месте.
 * Кандидатами в тревогу остаются обнаружения СЕГОДНЯШНИХ суток — ровно то,
 * что давало прежнее окно в сутки; остальные дни нужны только для проверки
 * «стоит ли здесь одно и то же несколько суток».
 *
 * Гасится кандидат, только когда известно всё: он в кластере, повторявшемся
 * не меньше DEFAULT_MIN_DAYS суток, рядом (≤ STATIC_FEATURE_KM) вулкан,
 * гейзер или горячий источник из нашего каталога, и сегодня не крупнее, чем
 * бывало (`judgeStatic`). Любое «не знаю» — каталог не прочитан, источника
 * рядом нет, точка заметно выросла — оставляет тревогу как есть.
 */
export async function ingestFirmsWildfires(now: Date = new Date()): Promise<ParseResult & { suppressed: SuppressedFirms[] }> {
  const result: ParseResult & { suppressed: SuppressedFirms[] } = { events: [], inserted: 0, skipped: 0, errors: [], suppressed: [] };
  const key = process.env.FIRMS_MAP_KEY;
  if (!key) return result;

  try {
    const { west, south, east, north } = KAMCHATKA_BBOX;
    const url =
      `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(key)}` +
      `/VIIRS_SNPP_NRT/${west},${south},${east},${north}/5`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) {
      result.errors.push(`firms http ${res.status}`);
      return result;
    }
    const csv = await res.text();
    const today = now.toISOString().slice(0, 10);
    const todays = parseFirmsCsv(csv).filter((h) => h.acqDate === today);
    result.rawItems = todays.length;

    // Каталог читаем, только если есть что проверять: без повторяющихся
    // кластеров ответ базы ничего не решает.
    const clusters = persistentClusters(parseFirmsRows(csv));
    let features: Awaited<ReturnType<typeof loadHeatFeatures>> | undefined;
    const verdictFor = new Map<(typeof clusters)[number], { isStatic: boolean; reason: StaticReason; nearest: NearFeature | null | undefined }>();
    const hotspots = [];
    for (const h of todays) {
      const cluster = clusters.find((c) => c.members.some((m) => m.acqDate === h.acqDate && m.lat === h.lat && m.lng === h.lng)) ?? null;
      if (!cluster) { hotspots.push(h); continue; }
      let verdict = verdictFor.get(cluster);
      if (!verdict) {
        if (features === undefined) features = await loadHeatFeatures();
        const nearest: NearFeature | null | undefined = features === null || features === undefined
          ? undefined
          : features
              .map((f) => ({ name: f.name, type: f.type, km: geoDistanceKm(cluster.lat, cluster.lng, f.lat, f.lng) }))
              .sort((a, b) => a.km - b.km)[0] ?? null;
        verdict = { ...judgeStatic(cluster, today, nearest), nearest };
        verdictFor.set(cluster, verdict);
        if (verdict.isStatic && verdict.nearest) {
          const todayAt = cluster.days.indexOf(today);
          result.suppressed.push({
            lat: Math.round(cluster.lat * 10000) / 10000,
            lng: Math.round(cluster.lng * 10000) / 10000,
            days: cluster.days.length,
            detections_today: todayAt >= 0 ? cluster.perDay[todayAt] : 0,
            nearest: verdict.nearest.name,
            nearest_km: Math.round(verdict.nearest.km * 10) / 10,
            retracted: 0,
          });
        }
      }
      if (!verdict.isStatic) hotspots.push(h);
    }
    for (const s of result.suppressed) {
      try {
        s.retracted = await retractStaticAlerts(s.lat, s.lng);
      } catch (e) {
        // Отказ не глушится: тревога просто доживёт свой срок, но об этом скажет ответ приёма.
        const err = e as { code?: string; message?: string };
        console.error('[wildfire-firms] снять тревоги по постоянному источнику не удалось', err.code, err.message);
        result.errors.push(`firms retract: ${err.code ?? ''} ${err.message ?? ''}`.trim());
      }
      console.warn(
        `[wildfire-firms] постоянный источник тепла, не тревога: ${s.lat}N ${s.lng}E, суток ${s.days}, ` +
        `сегодня ${s.detections_today}, рядом «${s.nearest}» ${s.nearest_km} км`,
      );
    }

    const events = wildfireEvents(clusterHotspots(hotspots));
    for (const event of events) {
      result.events.push(event);
      try {
        const status = await saveEvent(event);
        if (status === 'inserted') result.inserted++;
        else result.skipped++;
      } catch (e) {
        result.errors.push((e as Error).message);
      }
    }
  } catch (e) {
    result.errors.push((e as Error).message);
  }
  return result;
}
