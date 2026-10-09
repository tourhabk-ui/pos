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
 * Модуль чистый: ни сети, ни базы. Его читают перепись
 * `/api/cron/firms-persistence-census` и приём `wildfire-firms` — одно правило
 * на обоих: перепись показывает ровно то, что приём решает.
 */

/** Область запроса к FIRMS: Камчатка с запасом (юг Курил и Чукотку не берём). */
export const KAMCHATKA_BBOX = { west: 155, south: 50, east: 167, north: 63 } as const;

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

export interface PersistentCluster {
  lat: number;
  lng: number;
  /** Различные сутки с обнаружением в радиусе кластера, по возрастанию. */
  days: string[];
  detections: number;
  /** Сколько обнаружений в каждые сутки (в порядке `days`). */
  perDay: number[];
  /** Суммарная мощность по суткам, МВт (в порядке `days`). */
  perDayFrp: number[];
  frpMin: number;
  frpMax: number;
  frpMean: number;
  /** Самое большое расстояние между двумя обнаружениями кластера, км. */
  spreadKm: number;
  /** Сколько обнаружений ночных: источник тепла виден и днём, и ночью. */
  night: number;
  firstDay: string;
  lastDay: string;
  /** Сами обнаружения — для решения «какие из сегодняшних относятся к этому месту». */
  members: FirmsRow[];
}

export interface PersistenceOptions {
  /**
   * Радиус кластера, км. Пиксель VIIRS — 375 м, разброс привязки между
   * пролётами спутника ещё около километра: три километра собирают один
   * неподвижный источник в одно целое, а фронт, ползущий на пять километров
   * в сутки, — нет (он уходит за радиус от центроида и становится новым).
   */
  radiusKm?: number;
  /** Сколько различных суток нужно, чтобы кластер считался «стоящим на месте». */
  minDays?: number;
}

export const DEFAULT_RADIUS_KM = 3;
export const DEFAULT_MIN_DAYS = 3;

/**
 * Кластеры по расстоянию, а не по сетке. Первая редакция резала карту на
 * ячейки, и источник на стыке двух ячеек распадался надвое (поймал тест);
 * радиус от центроида этого не знает. Жадная кластеризация зависит от порядка
 * строк, поэтому строки сортируются по дате и времени — результат одинаков
 * при любом порядке входа.
 */
export function persistentClusters(rows: readonly FirmsRow[], opts: PersistenceOptions = {}): PersistentCluster[] {
  const radiusKm = opts.radiusKm ?? DEFAULT_RADIUS_KM;
  const minDays = opts.minDays ?? DEFAULT_MIN_DAYS;
  const ordered = [...rows].sort((a, b) => (a.acqDate + a.acqTime).localeCompare(b.acqDate + b.acqTime) || a.lat - b.lat || a.lng - b.lng);

  const groups: Array<{ lat: number; lng: number; rows: FirmsRow[] }> = [];
  for (const r of ordered) {
    const near = groups.find((g) => distanceKm(g.lat, g.lng, r.lat, r.lng) <= radiusKm);
    if (near) {
      near.lat = (near.lat * near.rows.length + r.lat) / (near.rows.length + 1);
      near.lng = (near.lng * near.rows.length + r.lng) / (near.rows.length + 1);
      near.rows.push(r);
    } else {
      groups.push({ lat: r.lat, lng: r.lng, rows: [r] });
    }
  }

  const out: PersistentCluster[] = [];
  for (const g of groups) {
    const days = [...new Set(g.rows.map((r) => r.acqDate))].sort();
    if (days.length < minDays) continue;
    const frps = g.rows.map((r) => r.frp);
    let spread = 0;
    for (let i = 0; i < g.rows.length; i++) {
      for (let j = i + 1; j < g.rows.length; j++) {
        spread = Math.max(spread, distanceKm(g.rows[i].lat, g.rows[i].lng, g.rows[j].lat, g.rows[j].lng));
      }
    }
    out.push({
      lat: g.lat,
      lng: g.lng,
      days,
      detections: g.rows.length,
      perDay: days.map((d) => g.rows.filter((r) => r.acqDate === d).length),
      perDayFrp: days.map((d) => g.rows.filter((r) => r.acqDate === d).reduce((sum, r) => sum + r.frp, 0)),
      frpMin: Math.min(...frps),
      frpMax: Math.max(...frps),
      frpMean: frps.reduce((sum, v) => sum + v, 0) / frps.length,
      spreadKm: spread,
      night: g.rows.filter((r) => r.daynight === 'N').length,
      firstDay: days[0],
      lastDay: days[days.length - 1],
      members: g.rows,
    });
  }
  return out.sort((a, b) => b.days.length - a.days.length || b.detections - a.detections);
}

// ── Приговор: постоянный источник тепла или повод для пожарной тревоги ──────

/** Ближайшее известное нам место, которое само источник тепла: вулкан, гейзер, горячий источник. */
export interface NearFeature { name: string; type: string | null; km: number }

/**
 * Расстояние до ближайшего вулкана/гейзера/источника, внутри которого
 * стоящая на месте термоточка читается как их собственное тепло. Число из
 * данных: замер 09.10 — точка 54.62N 160.30E стоит в 2,1 км от вулкана
 * Крашенинникова и держится не меньше месяца; 5 км — с запасом на разброс
 * привязки, но не до соседних долин (Долина гейзеров от неё в 22 км).
 */
export const STATIC_FEATURE_KM = 5;

/** Рост против прошлых суток, за которым термоточка перестаёт быть «как всегда». */
export const ESCALATION_FACTOR = 2;
/** Но не при мелких числах: с 1 до 3 точек — не рост пожара. */
export const ESCALATION_MIN_COUNT = 5;
export const ESCALATION_MIN_FRP_MW = 30;

export type StaticReason =
  | 'static_source'     // стоит на месте И рядом вулкан/источник И не растёт — не пожар
  | 'not_persistent'    // повторяется меньше суток, чем нужно: пожар, пока не доказано иное
  | 'escalating'        // стоит давно, но сегодня сильно крупнее обычного: могла вспыхнуть настоящая
  | 'no_known_feature'  // стоит давно, но рядом нет вулкана/источника: чем это тепло — не знаем
  | 'feature_unknown';  // не смогли спросить, что рядом: не знаем, и поэтому не гасим

export interface StaticVerdict { isStatic: boolean; reason: StaticReason }

/**
 * Решение по кластеру. Гасить пожарную тревогу можно только когда ВСЕ три
 * условия известны и выполнены: стоит на месте (факт из данных), рядом есть
 * вулкан или источник (факт из базы мест), и сегодня не крупнее, чем бывало
 * (факт из тех же данных). Любое «не знаю» оставляет тревогу как есть — тихая
 * ошибка здесь стоит настоящего пожара, а лишняя строка на радаре стоит
 * строки (§4.0: не знаем — не гасим).
 *
 * `nearest`: объект — ближайшее место; `null` — спросили и ничего нет в
 * радиусе; `undefined` — спросить не получилось.
 */
export function judgeStatic(
  cluster: PersistentCluster | null,
  today: string,
  nearest: NearFeature | null | undefined,
  minDays: number = DEFAULT_MIN_DAYS,
): StaticVerdict {
  if (!cluster || cluster.days.length < minDays) return { isStatic: false, reason: 'not_persistent' };

  const todayAt = cluster.days.indexOf(today);
  if (todayAt >= 0) {
    const prior = cluster.days.map((_, i) => i).filter((i) => i !== todayAt);
    const priorCount = Math.max(0, ...prior.map((i) => cluster.perDay[i]));
    const priorFrp = Math.max(0, ...prior.map((i) => cluster.perDayFrp[i]));
    const count = cluster.perDay[todayAt];
    const frp = cluster.perDayFrp[todayAt];
    if (
      (count >= ESCALATION_MIN_COUNT && count > ESCALATION_FACTOR * priorCount) ||
      (frp >= ESCALATION_MIN_FRP_MW && frp > ESCALATION_FACTOR * priorFrp)
    ) {
      return { isStatic: false, reason: 'escalating' };
    }
  }

  if (nearest === undefined) return { isStatic: false, reason: 'feature_unknown' };
  if (nearest === null || nearest.km > STATIC_FEATURE_KM) return { isStatic: false, reason: 'no_known_feature' };
  return { isStatic: true, reason: 'static_source' };
}
