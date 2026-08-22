/**
 * Приём трека из полевого навигатора: GPX, KML, KMZ.
 *
 * Владелец 22.08, показав MAPS.ME: «вот простые варианты». И это верно —
 * своего рекордера строить не надо. Нативный навигатор пишет трек в фоне с
 * погашенным экраном, качает карты офлайн и умеет «поделиться»; браузер
 * первого не умеет и не будет. Значит наша работа — не повторять его, а
 * ПРИНЯТЬ то, что он отдаёт, одним файлом.
 *
 * Разбор намеренно узкий и без зависимостей: KMZ — это обычный ZIP (штатный
 * zlib), а GPX/KML читаются по своим тегам. Это машинные файлы с известной
 * формой, а не произвольный XML; полноценный парсер здесь стоил бы веса в
 * образе (лимит 50 МБ) и не купил бы ничего.
 *
 * Ничего не решает и никуда не пишет: отдаёт разобранное и мерит. Что с
 * этим делать — вопрос к человеку и к судьям (§12).
 */

import { inflateRawSync } from 'node:zlib';

export type TrackFormat = 'gpx' | 'kml' | 'kmz';

export interface ImportedPoint {
  lat: number;
  lng: number;
  /** Метры; null — в файле высоты нет. Ею §12 судит происхождение линии. */
  ele: number | null;
}

export interface ImportedTrack {
  /** Имя из файла; пустое — навигаторы часто не именуют запись. */
  name: string | null;
  points: ImportedPoint[];
  lengthKm: number;
  spanKm: number;
  /** Доля точек с высотой, 0..1. */
  eleShare: number;
  stepM: { min: number; median: number; max: number } | null;
}

export interface ImportedWaypoint {
  name: string | null;
  lat: number;
  lng: number;
  ele: number | null;
}

export interface ImportedFile {
  format: TrackFormat;
  tracks: ImportedTrack[];
  waypoints: ImportedWaypoint[];
  /** Словами: что помешало разобрать. Пусто — разобралось целиком. */
  problems: string[];
}

const R_KM = 6371;

export function haversineKm(
  aLat: number, aLng: number, bLat: number, bLng: number,
): number {
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const la1 = (aLat * Math.PI) / 180;
  const la2 = (bLat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Первый файл из ZIP. KMZ по устройству — архив с единственным .kml внутри.
 *
 * Читается локальный заголовок, а не центральная директория: у KMZ ровно
 * одна запись, и гоняться за общим случаем незачем. Поддержаны два метода,
 * которыми архивы и бывают: без сжатия (0) и deflate (8).
 */
export function unzipFirstEntry(buf: Buffer): { name: string; data: Buffer } | null {
  if (buf.length < 30) return null;
  // Локальный заголовок: 'PK\x03\x04'
  if (buf.readUInt32LE(0) !== 0x04034b50) return null;
  const method = buf.readUInt16LE(8);
  const compressedSize = buf.readUInt32LE(18);
  const nameLen = buf.readUInt16LE(26);
  const extraLen = buf.readUInt16LE(28);
  const start = 30 + nameLen + extraLen;
  if (start > buf.length) return null;
  const name = buf.subarray(30, 30 + nameLen).toString('utf-8');

  // Размер 0 в локальном заголовке означает, что он вынесен в дескриптор
  // после данных. Тогда берём всё до следующей сигнатуры — иначе получим
  // пустой файл и скажем «пусто» вместо «не смог».
  const end = compressedSize > 0
    ? start + compressedSize
    : (() => {
        const idx = buf.indexOf(Buffer.from([0x50, 0x4b, 0x07, 0x08]), start);
        const idx2 = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), start);
        const candidates = [idx, idx2].filter(i => i > start);
        return candidates.length > 0 ? Math.min(...candidates) : buf.length;
      })();

  const raw = buf.subarray(start, Math.min(end, buf.length));
  try {
    if (method === 0) return { name, data: Buffer.from(raw) };
    if (method === 8) return { name, data: inflateRawSync(raw) };
  } catch { return null; }
  return null;
}

function num(v: string): number | null {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function plausible(lat: number, lng: number): boolean {
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
}

function measure(name: string | null, points: ImportedPoint[]): ImportedTrack {
  const lengthKm = points.length < 2 ? 0 : points.slice(1).reduce(
    (acc, p, i) => acc + haversineKm(points[i].lat, points[i].lng, p.lat, p.lng), 0);
  const lats = points.map(p => p.lat), lngs = points.map(p => p.lng);
  const spanKm = points.length < 2 ? 0
    : haversineKm(Math.min(...lats), Math.min(...lngs), Math.max(...lats), Math.max(...lngs));
  const withEle = points.filter(p => p.ele !== null).length;
  const steps = points.length < 2 ? [] : points.slice(1)
    .map((p, i) => haversineKm(points[i].lat, points[i].lng, p.lat, p.lng) * 1000)
    .sort((a, b) => a - b);
  return {
    name,
    points,
    lengthKm: Math.round(lengthKm * 100) / 100,
    spanKm: Math.round(spanKm * 100) / 100,
    eleShare: points.length === 0 ? 0 : Math.round((withEle / points.length) * 100) / 100,
    stepM: steps.length === 0 ? null : {
      min: Math.round(steps[0]),
      median: Math.round(steps[Math.floor(steps.length / 2)]),
      max: Math.round(steps[steps.length - 1]),
    },
  };
}

function parseGpx(xml: string): { tracks: ImportedTrack[]; waypoints: ImportedWaypoint[] } {
  const tracks: ImportedTrack[] = [];
  const segRe = /<trkseg[^>]*>([\s\S]*?)<\/trkseg>/g;
  const trkRe = /<trk[^>]*>([\s\S]*?)<\/trk>/g;
  let t: RegExpExecArray | null;
  while ((t = trkRe.exec(xml)) !== null) {
    const nameM = /<name[^>]*>([\s\S]*?)<\/name>/.exec(t[1]);
    const points: ImportedPoint[] = [];
    let s: RegExpExecArray | null;
    const segs = new RegExp(segRe.source, 'g');
    while ((s = segs.exec(t[1])) !== null) {
      const ptRe = /<trkpt[^>]*\blat="([^"]+)"[^>]*\blon="([^"]+)"[^>]*>([\s\S]*?)<\/trkpt>|<trkpt[^>]*\blon="([^"]+)"[^>]*\blat="([^"]+)"[^>]*\/>/g;
      let p: RegExpExecArray | null;
      while ((p = ptRe.exec(s[1])) !== null) {
        const lat = num(p[1] ?? p[5] ?? ''), lng = num(p[2] ?? p[4] ?? '');
        if (lat === null || lng === null || !plausible(lat, lng)) continue;
        const eleM = p[3] ? /<ele[^>]*>([^<]+)<\/ele>/.exec(p[3]) : null;
        const rawEle = eleM ? num(eleM[1]) : null;
        // Ноль — то же самое, что в KML: «прибор высоту не писал», а не
        // «уровень моря». Отличить нельзя, и считать ноль высотой значит
        // объявить экспорт без высот записью прибора: у присланного 22.08
        // GPX перевала так и вышло — «высота у 100%» при сплошных нулях.
        points.push({ lat, lng, ele: rawEle === 0 ? null : rawEle });
      }
    }
    if (points.length >= 2) tracks.push(measure(nameM ? nameM[1].trim() || null : null, points));
  }

  const waypoints: ImportedWaypoint[] = [];
  const wptRe = /<wpt[^>]*\blat="([^"]+)"[^>]*\blon="([^"]+)"[^>]*>([\s\S]*?)<\/wpt>/g;
  let w: RegExpExecArray | null;
  while ((w = wptRe.exec(xml)) !== null) {
    const lat = num(w[1]), lng = num(w[2]);
    if (lat === null || lng === null || !plausible(lat, lng)) continue;
    const nameM = /<name[^>]*>([\s\S]*?)<\/name>/.exec(w[3]);
    const eleM = /<ele[^>]*>([^<]+)<\/ele>/.exec(w[3]);
    const rawEle = eleM ? num(eleM[1]) : null;
    waypoints.push({
      name: nameM ? nameM[1].trim() || null : null,
      lat, lng, ele: rawEle === 0 ? null : rawEle,
    });
  }
  return { tracks, waypoints };
}

function parseKml(xml: string): { tracks: ImportedTrack[]; waypoints: ImportedWaypoint[] } {
  const tracks: ImportedTrack[] = [];
  const waypoints: ImportedWaypoint[] = [];
  const pmRe = /<Placemark[^>]*>([\s\S]*?)<\/Placemark>/g;
  let m: RegExpExecArray | null;
  while ((m = pmRe.exec(xml)) !== null) {
    const body = m[1];
    const nameM = /<name[^>]*>([\s\S]*?)<\/name>/.exec(body);
    const name = nameM ? nameM[1].trim() || null : null;

    const lineM = /<LineString[^>]*>[\s\S]*?<coordinates[^>]*>([\s\S]*?)<\/coordinates>/.exec(body);
    if (lineM) {
      const points: ImportedPoint[] = [];
      for (const tok of lineM[1].trim().split(/\s+/)) {
        const a = tok.split(',');
        if (a.length < 2) continue;
        const lng = num(a[0]), lat = num(a[1]);
        if (lat === null || lng === null || !plausible(lat, lng)) continue;
        // Третье число в KML — высота, и НОЛЬ здесь почти всегда значит
        // «прибор её не писал», а не «уровень моря». Отличить нельзя, и
        // выдавать ноль за высоту — то же враньё, что `Number(null) === 0`:
        // нулевую высоту считаем отсутствующей и говорим это долей eleShare.
        const raw = a.length > 2 ? num(a[2]) : null;
        points.push({ lat, lng, ele: raw === null || raw === 0 ? null : raw });
      }
      if (points.length >= 2) tracks.push(measure(name, points));
      continue;
    }

    const ptM = /<Point[^>]*>[\s\S]*?<coordinates[^>]*>([\s\S]*?)<\/coordinates>/.exec(body);
    if (ptM) {
      const a = ptM[1].trim().split(',');
      const lng = num(a[0] ?? ''), lat = num(a[1] ?? '');
      if (lat !== null && lng !== null && plausible(lat, lng)) {
        const raw = a.length > 2 ? num(a[2]) : null;
        waypoints.push({ name, lat, lng, ele: raw === null || raw === 0 ? null : raw });
      }
    }
  }
  return { tracks, waypoints };
}

/**
 * Разобрать присланный файл. Род определяется по СОДЕРЖИМОМУ, а не по
 * расширению: навигаторы переименовывают файлы как хотят, и доверять имени
 * значит падать на верном файле с чужим суффиксом.
 */
export function parseTrackFile(buf: Buffer, filename?: string): ImportedFile {
  const problems: string[] = [];

  let format: TrackFormat;
  let xml: string;

  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) {
    format = 'kmz';
    const entry = unzipFirstEntry(buf);
    if (entry === null) {
      return { format, tracks: [], waypoints: [], problems: ['Архив не разобрался — внутри не нашлось читаемого файла'] };
    }
    xml = entry.data.toString('utf-8');
  } else {
    xml = buf.toString('utf-8');
    format = /<gpx[\s>]/i.test(xml) ? 'gpx' : 'kml';
    if (format === 'kml' && !/<kml[\s>]/i.test(xml)) {
      problems.push('Ни GPX, ни KML в содержимом не опознано — разбираю как KML');
    }
  }

  const parsed = format === 'gpx' ? parseGpx(xml) : parseKml(xml);

  if (parsed.tracks.length === 0 && parsed.waypoints.length === 0) {
    problems.push('В файле не нашлось ни линии, ни точек');
  }
  if (filename && /\.(gpx|kml|kmz)$/i.test(filename) === false) {
    problems.push(`Расширение «${filename}» незнакомо — род определён по содержимому`);
  }

  return { format, tracks: parsed.tracks, waypoints: parsed.waypoints, problems };
}
