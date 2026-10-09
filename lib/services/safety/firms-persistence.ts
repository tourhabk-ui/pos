/**
 * Термоточки FIRMS, которые стоят на одном месте несколько суток.
 *
 * Повод — скрин владельца 09.10: на радаре «Термоточки (возможен пожар): 1
 * очаг(ов), 54.62°N 160.30°E», и точка, по его словам, висит неделю в одном
 * месте. Пожар за неделю движется или гаснет; единичный пиксель, неделю
 * стоящий на месте, — признак постоянного источника тепла (вулканические
 * термали, промплощадка), а не очага. Но «похоже» — улика, а не приговор:
 * здесь считаются ФАКТЫ (сколько суток, сколько обнаружений, как далеко друг
 * от друга), а вывод о природе источника делает вызывающий и называет его
 * словами «возможно», а не «установлено».
 *
 * Модуль чистый: ни сети, ни базы. Его читает перепись
 * `/api/cron/firms-persistence-census` и (когда правило выбрано по данным
 * переписи) приём `wildfire-firms`.
 */

/** Одна строка CSV FIRMS — ВСЕ уверенности, чтобы перепись видела и отброшенное приёмом. */
export interface FirmsRow {
  lat: number;
  lng: number;
  /** YYYY-MM-DD, как в CSV (UTC). */
  acqDate: string;
  /** HHMM UTC; пусто, если колонки нет. */
  acqTime: string;
  frp: number;
  /** Как в CSV: l/n/h у VIIRS или число у MODIS; пусто — не записано. */
  confidence: string;
  /** 'D' | 'N' | ''. */
  daynight: string;
  satellite: string;
}

export function parseFirmsRows(csv: string): FirmsRow[] {
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return [];
  const header = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const col = (name: string) => header.indexOf(name);
  const iLat = col('latitude');
  const iLng = col('longitude');
  const iDate = col('acq_date');
  if (iLat < 0 || iLng < 0 || iDate < 0) return [];
  const iTime = col('acq_time');
  const iFrp = col('frp');
  const iConf = col('confidence');
  const iDn = col('daynight');
  const iSat = col('satellite');

  const out: FirmsRow[] = [];
  for (const line of lines.slice(1)) {
    const c = line.split(',');
    const lat = parseFloat(c[iLat]);
    const lng = parseFloat(c[iLng]);
    const acqDate = (c[iDate] ?? '').trim();
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !/^\d{4}-\d{2}-\d{2}$/.test(acqDate)) continue;
    const frp = iFrp >= 0 ? parseFloat(c[iFrp] ?? '') : NaN;
    out.push({
      lat,
      lng,
      acqDate,
      acqTime: iTime >= 0 ? (c[iTime] ?? '').trim() : '',
      frp: Number.isFinite(frp) ? frp : 0,
      confidence: iConf >= 0 ? (c[iConf] ?? '').trim().toLowerCase() : '',
      daynight: iDn >= 0 ? (c[iDn] ?? '').trim().toUpperCase() : '',
      satellite: iSat >= 0 ? (c[iSat] ?? '').trim() : '',
    });
  }
  return out;
}

const EARTH_KM = 6371;
export function distanceKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(s));
}

export interface PersistentCell {
  /** Ячейка сетки: целые шаги широты/долготы — ключ, не координата. */
  key: string;
  lat: number;
  lng: number;
  /** Различные сутки с обнаружением в этой ячейке, по возрастанию. */
  days: string[];
  detections: number;
  /** Сколько обнаружений было в каждые сутки (в порядке `days`). */
  perDay: number[];
  frpMin: number;
  frpMax: number;
  frpMean: number;
  /** Самое большое расстояние между двумя обнаружениями ячейки, км. */
  spreadKm: number;
  /** Сколько обнаружений ночных: пожар в тундре ночью почти всегда виден, днём — нет, источник тепла виден всегда. */
  night: number;
  firstDay: string;
  lastDay: string;
}

export interface PersistenceOptions {
  /** Размер ячейки сетки, градусов широты. 0.02 ≈ 2,2 км — пиксель VIIRS 375 м плюс разброс привязки. */
  cellDeg?: number;
  /** Сколько различных суток нужно, чтобы ячейка считалась «стоящей на месте». */
  minDays?: number;
}

export const DEFAULT_CELL_DEG = 0.02;
export const DEFAULT_MIN_DAYS = 3;

/**
 * Ячейки, где обнаружения повторяются в разные сутки. Граница ячейки режет
 * источник на две половины, если он стоит на стыке, поэтому соседние ячейки
 * с общим происхождением надо сверять глазами по `spreadKm`/`lat`/`lng` — функция
 * этого не склеивает, чтобы не выдумывать кластер там, где его нет.
 */
export function persistentCells(rows: readonly FirmsRow[], opts: PersistenceOptions = {}): PersistentCell[] {
  const cellDeg = opts.cellDeg ?? DEFAULT_CELL_DEG;
  const minDays = opts.minDays ?? DEFAULT_MIN_DAYS;
  const groups = new Map<string, FirmsRow[]>();
  for (const r of rows) {
    // Долгота на 55° сужается вдвое: ячейка по долготе шире в градусах, чтобы быть квадратной в километрах.
    // Шаг по долготе берётся от СЕРЕДИНЫ широтной полосы, а не от широты самой точки: иначе две точки на
    // одной долготе, но на чуть разных широтах получали разный шаг и попадали в разные ячейки (поймал тест).
    const latBand = Math.floor(r.lat / cellDeg);
    const bandMid = (latBand + 0.5) * cellDeg;
    const lngDeg = cellDeg / Math.max(0.2, Math.cos((bandMid * Math.PI) / 180));
    const key = `${latBand}:${Math.floor(r.lng / lngDeg)}`;
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }

  const out: PersistentCell[] = [];
  for (const [key, g] of groups) {
    const days = [...new Set(g.map((r) => r.acqDate))].sort();
    if (days.length < minDays) continue;
    const frps = g.map((r) => r.frp);
    let spread = 0;
    for (let i = 0; i < g.length; i++) {
      for (let j = i + 1; j < g.length; j++) {
        spread = Math.max(spread, distanceKm(g[i].lat, g[i].lng, g[j].lat, g[j].lng));
      }
    }
    out.push({
      key,
      lat: g.reduce((s, r) => s + r.lat, 0) / g.length,
      lng: g.reduce((s, r) => s + r.lng, 0) / g.length,
      days,
      detections: g.length,
      perDay: days.map((d) => g.filter((r) => r.acqDate === d).length),
      frpMin: Math.min(...frps),
      frpMax: Math.max(...frps),
      frpMean: frps.reduce((s, v) => s + v, 0) / frps.length,
      spreadKm: spread,
      night: g.filter((r) => r.daynight === 'N').length,
      firstDay: days[0],
      lastDay: days[days.length - 1],
    });
  }
  return out.sort((a, b) => b.days.length - a.days.length || b.detections - a.detections);
}
