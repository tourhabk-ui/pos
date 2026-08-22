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
  /** Сколько длилась запись, минуты; null — времени в файле нет. */
  timespanMin: number | null;
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

/** Потолок распакованного: архив сжимается в тысячи раз, вход мы ограничили,
 *  а выход — нет. У самого Organic Maps этой защиты нет (zip_reader.cpp
 *  читает без проверки), и повторять их дыру незачем. */
const MAX_UNZIPPED_BYTES = 40_000_000;

/**
 * ВСЕ файлы из ZIP, а не первый.
 *
 * Ошибка, найденная по исходнику Organic Maps (libs/map/bookmark_helpers.cpp,
 * GetFilePathsToLoadFromKmz): KMZ вовсе не обязан нести один .kml. При
 * выгрузке нескольких категорий они кладут в корень `doc.kml` — это ИНДЕКС
 * из NetworkLink, а не данные, — и сами данные в `files/<имя>.kml`. Мой
 * разбор брал первую запись, то есть на таком архиве нашёл бы индекс и
 * честно сказал «ни линии, ни точек», потеряв весь выход.
 *
 * Читаются локальные заголовки подряд. Методы те же, что бывают у архивов:
 * без сжатия (0) и deflate (8).
 */
export function unzipEntries(buf: Buffer): Array<{ name: string; data: Buffer }> {
  const out: Array<{ name: string; data: Buffer }> = [];
  let pos = 0;
  let unzipped = 0;

  while (pos + 30 <= buf.length && buf.readUInt32LE(pos) === 0x04034b50) {
    const method = buf.readUInt16LE(pos + 8);
    const compressedSize = buf.readUInt32LE(pos + 18);
    const nameLen = buf.readUInt16LE(pos + 26);
    const extraLen = buf.readUInt16LE(pos + 28);
    const start = pos + 30 + nameLen + extraLen;
    if (start > buf.length) break;
    const name = buf.subarray(pos + 30, pos + 30 + nameLen).toString('utf-8');

    // Размер 0 в локальном заголовке означает, что он вынесен в дескриптор
    // ПОСЛЕ данных. Тогда берём всё до ближайшей следующей сигнатуры —
    // иначе получим пустой файл и скажем «пусто» вместо «не смог».
    const end = compressedSize > 0
      ? start + compressedSize
      : (() => {
          const marks = [
            buf.indexOf(Buffer.from([0x50, 0x4b, 0x07, 0x08]), start),
            buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), start),
            buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), start),
          ].filter(i => i > start);
          return marks.length > 0 ? Math.min(...marks) : buf.length;
        })();

    const raw = buf.subarray(start, Math.min(end, buf.length));
    try {
      const data = method === 0 ? Buffer.from(raw)
        : method === 8 ? inflateRawSync(raw)
        : null;
      if (data !== null) {
        unzipped += data.length;
        if (unzipped > MAX_UNZIPPED_BYTES) break;
        out.push({ name, data });
      }
    } catch { /* одна порченая запись не должна ронять весь архив */ }

    if (compressedSize > 0) {
      pos = start + compressedSize;
      // Дескриптор данных после записи, если он есть.
      if (pos + 4 <= buf.length && buf.readUInt32LE(pos) === 0x08074b50) pos += 16;
    } else {
      pos = end;
      if (pos + 4 <= buf.length && buf.readUInt32LE(pos) === 0x08074b50) pos += 16;
    }
  }
  return out;
}

function num(v: string): number | null {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function plausible(lat: number, lng: number): boolean {
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
}

/**
 * Соседние точки ближе метра — одна точка.
 *
 * Organic Maps режет дубликаты тем же порядком величины (kMwmPointAccuracy
 * ≈ 1e-5 градуса, libs/map/bookmark_helpers.cpp), и не зря: экспорт из
 * разных приложений плодит повторы, а они портят и длину, и замер шага.
 */
function dedupe(points: ImportedPoint[]): ImportedPoint[] {
  const out: ImportedPoint[] = [];
  for (const p of points) {
    const prev = out[out.length - 1];
    if (prev && haversineKm(prev.lat, prev.lng, p.lat, p.lng) * 1000 < 1) continue;
    out.push(p);
  }
  return out;
}

/**
 * Длительность записи по меткам времени. Немонотонные метки — это не время,
 * а мусор: Organic Maps в таком случае стирает их целиком, и мы тоже не
 * станем выдавать беспорядок за длительность.
 */
function timespanMinutes(whens: string[]): number | null {
  const ts = whens.map(w => Date.parse(w)).filter(n => Number.isFinite(n));
  if (ts.length < 2) return null;
  for (let i = 1; i < ts.length; i++) if (ts[i] < ts[i - 1]) return null;
  return Math.round((ts[ts.length - 1] - ts[0]) / 60000);
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
    timespanMin: null,
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
    const clean = dedupe(points);
    if (clean.length >= 2) {
      const tr = measure(nameM ? nameM[1].trim() || null : null, clean);
      const whens = [...t[1].matchAll(/<time[^>]*>([^<]*)<\/time>/g)].map(w => w[1].trim());
      tr.timespanMin = whens.length >= 2 ? timespanMinutes(whens) : null;
      tracks.push(tr);
    }
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

/**
 * Точка из «lon,lat[,alt]». Ноль высоты — НЕ высота.
 *
 * Правило подтверждено исходником Organic Maps: у них есть отдельный
 * предикат `LineHasAltitude` (libs/kml/serdes_common.cpp) — «высота есть,
 * если она не kInvalidAltitude И не ноль», и в GPX-экспорте они по нему
 * режут высоты целиком. Нам это правило нужно ровно затем же: по наличию
 * высот §12 отличает запись прибора от перерисовки.
 */
function pointFromTriple(a: string[]): ImportedPoint | null {
  if (a.length < 2) return null;
  const lng = num(a[0]), lat = num(a[1]);
  if (lat === null || lng === null || !plausible(lat, lng)) return null;
  const raw = a.length > 2 ? num(a[2]) : null;
  return { lat, lng, ele: raw === null || raw === 0 ? null : raw };
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

    // ── gx:Track ──────────────────────────────────────────────────────────
    //
    // Organic Maps пишет линию С ВРЕМЕНЕМ именно так, а без времени — как
    // LineString (libs/kml/serdes.cpp: две разные ветки, они не смешиваются).
    // Мой разбор знал только LineString, то есть трек с временем — самый
    // ценный для нас — не увидел бы вовсе.
    //
    // Порядок внутри у них: сначала ВСЕ <when>, потом ВСЕ <gx:coord>. Читаем
    // и вперемешку: чужие файлы бывают любыми.
    const trackRe = /<(?:gx:)?Track[^>]*>([\s\S]*?)<\/(?:gx:)?Track>/g;
    let tm: RegExpExecArray | null;
    let sawTrack = false;
    while ((tm = trackRe.exec(body)) !== null) {
      sawTrack = true;
      const inner = tm[1];
      const coords = [...inner.matchAll(/<(?:gx:)?coord[^>]*>([^<]*)<\/(?:gx:)?coord>/g)]
        .map(c => pointFromTriple(c[1].trim().split(/[\s,]+/)))
        .filter((p): p is ImportedPoint => p !== null);
      const whens = [...inner.matchAll(/<when[^>]*>([^<]*)<\/when>/g)].map(w => w[1].trim());
      const points = dedupe(coords);
      if (points.length >= 2) {
        const t = measure(name, points);
        // Время берётся, только если его РОВНО столько же, сколько точек:
        // у Organic Maps несовпадение — это исключение и отказ читать файл.
        // Мы мягче (линию не теряем), но врать про время не станем.
        t.timespanMin = whens.length === coords.length ? timespanMinutes(whens) : null;
        tracks.push(t);
      }
    }

    // ── LineString, в том числе несколько в MultiGeometry ─────────────────
    const lineRe = /<LineString[^>]*>[\s\S]*?<coordinates[^>]*>([\s\S]*?)<\/coordinates>/g;
    let lm: RegExpExecArray | null;
    let sawLine = false;
    while ((lm = lineRe.exec(body)) !== null) {
      sawLine = true;
      const points = dedupe(
        lm[1].trim().split(/\s+/)
          .map(tok => pointFromTriple(tok.split(',')))
          .filter((p): p is ImportedPoint => p !== null),
      );
      if (points.length >= 2) tracks.push(measure(name, points));
    }

    if (sawTrack || sawLine) continue;

    const ptM = /<Point[^>]*>[\s\S]*?<coordinates[^>]*>([\s\S]*?)<\/coordinates>/.exec(body);
    if (ptM) {
      const p = pointFromTriple(ptM[1].trim().split(','));
      if (p !== null) waypoints.push({ name, lat: p.lat, lng: p.lng, ele: p.ele });
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
    const entries = unzipEntries(buf);
    const kmls = entries.filter(e => /\.kml$/i.test(e.name));
    if (kmls.length === 0) {
      return {
        format, tracks: [], waypoints: [],
        problems: entries.length === 0
          ? ['Архив не разобрался — внутри не нашлось читаемого файла']
          : [`В архиве ${entries.length} файлов, но ни одного .kml`],
      };
    }
    // `doc.kml` в корне — ИНДЕКС из NetworkLink, а не данные (так Organic
    // Maps выгружает несколько категорий). Он читается последним: если
    // данные лежат в files/*.kml, они и должны победить.
    kmls.sort((a, b) => Number(/^doc\.kml$/i.test(a.name)) - Number(/^doc\.kml$/i.test(b.name)));
    xml = kmls.map(e => e.data.toString('utf-8')).join('\n');
    if (kmls.length > 1) problems.push(`В архиве ${kmls.length} файлов .kml — разобраны все`);
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
