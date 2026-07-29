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

// Камчатка с запасом: юг Курил не берём, Чукотку не берём.
export const KAMCHATKA_BBOX = { west: 155, south: 50, east: 167, north: 63 } as const;

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

/**
 * Полный ingest: fetch CSV за сутки → parse → cluster → save.
 * Без FIRMS_MAP_KEY молчим (опциональный источник, как VK).
 */
export async function ingestFirmsWildfires(): Promise<ParseResult> {
  const result: ParseResult = { events: [], inserted: 0, skipped: 0, errors: [] };
  const key = process.env.FIRMS_MAP_KEY;
  if (!key) return result;

  try {
    const { west, south, east, north } = KAMCHATKA_BBOX;
    const url =
      `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(key)}` +
      `/VIIRS_SNPP_NRT/${west},${south},${east},${north}/1`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) {
      result.errors.push(`firms http ${res.status}`);
      return result;
    }
    const csv = await res.text();
    const hotspots = parseFirmsCsv(csv);
    result.rawItems = hotspots.length;

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
