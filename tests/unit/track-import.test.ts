/**
 * Приём трека из полевого навигатора — сторож.
 *
 * Владелец 22.08, показав MAPS.ME: «вот простые варианты». Своего рекордера
 * не строим: нативный навигатор пишет трек в фоне с погашенным экраном, чего
 * браузер не умеет. Наша работа — принять то, что он отдаёт, одним файлом.
 *
 * Черты, которые здесь стерегутся:
 *  1. KMZ (обычный ZIP) разбирается без внешних зависимостей — в образ с
 *     лимитом 50 МБ библиотека не поедет.
 *  2. Род файла определяется по СОДЕРЖИМОМУ: навигаторы переименовывают
 *     файлы, и доверять расширению значит падать на верном файле.
 *  3. Нулевая высота — это «прибор не писал», а не «уровень моря».
 *     Одинаково в GPX и в KML: разнобой уже дал «высота у 100%» при
 *     сплошных нулях у присланного GPX перевала.
 *  4. Ничего не разобралось — это отказ словами, а не пустой успех (§4.0).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTrackFile, unzipEntries, haversineKm } from '@/lib/field/track-import';

const KMZ = readFileSync(join(process.cwd(), 'tests/fixtures/field/mapsme-track.kmz'));

const GPX = `<?xml version="1.0"?>
<gpx version="1.1"><trk><name>Тестовый выход</name><trkseg>
<trkpt lat="53.0787" lon="158.6382"><ele>120</ele></trkpt>
<trkpt lat="53.0790" lon="158.6400"><ele>128</ele></trkpt>
<trkpt lat="53.0795" lon="158.6420"><ele>141</ele></trkpt>
</trkseg></trk>
<wpt lat="53.0800" lon="158.6440"><name>Брод</name></wpt></gpx>`;

const GPX_ZERO_ELE = `<?xml version="1.0"?>
<gpx version="1.1"><trk><trkseg>
<trkpt lat="53.0787" lon="158.6382"><ele>0</ele></trkpt>
<trkpt lat="53.0790" lon="158.6400"><ele>0</ele></trkpt>
</trkseg></trk></gpx>`;

const KML_POINT = `<?xml version="1.0"?><kml><Document><Placemark>
<name>Стоянка</name><Point><coordinates>158.6382,53.0787,0</coordinates></Point>
</Placemark></Document></kml>`;

describe('разбор KMZ из MAPS.ME', () => {
  it('архив вскрывается штатным zlib, без зависимостей', () => {
    const entries = unzipEntries(KMZ);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0].data.toString('utf-8')).toContain('<kml');
  });

  it('настоящая запись прогулки разбирается целиком', () => {
    const r = parseTrackFile(KMZ, 'mapsme-track.kmz');
    expect(r.format).toBe('kmz');
    expect(r.problems).toEqual([]);
    expect(r.tracks).toHaveLength(1);
    const t = r.tracks[0];
    expect(t.points.length).toBe(86);
    expect(t.lengthKm).toBeCloseTo(4.11, 1);
    // Живая запись: шаг пляшет, потому что человек то идёт, то стоит.
    expect(t.stepM!.max).toBeGreaterThan(t.stepM!.min * 3);
  });

  it('MAPS.ME высоту не отдаёт — и это видно долей, а не догадкой', () => {
    expect(parseTrackFile(KMZ).tracks[0].eleShare).toBe(0);
  });
});

describe('GPX и KML', () => {
  it('GPX с настоящими высотами: имя, точки, метка', () => {
    const r = parseTrackFile(Buffer.from(GPX), 'x.gpx');
    expect(r.format).toBe('gpx');
    expect(r.tracks[0].name).toBe('Тестовый выход');
    expect(r.tracks[0].eleShare).toBe(1);
    expect(r.waypoints).toEqual([
      { name: 'Брод', lat: 53.08, lng: 158.644, ele: null },
    ]);
  });

  it('нулевая высота не считается высотой ни в GPX, ни в KML', () => {
    expect(parseTrackFile(Buffer.from(GPX_ZERO_ELE)).tracks[0].eleShare).toBe(0);
    expect(parseTrackFile(Buffer.from(KML_POINT)).waypoints[0].ele).toBeNull();
  });

  it('одиночная точка — это метка, а не линия', () => {
    const r = parseTrackFile(Buffer.from(KML_POINT), 'p.kml');
    expect(r.tracks).toHaveLength(0);
    expect(r.waypoints[0].name).toBe('Стоянка');
  });

  it('род читается из содержимого, а не из расширения', () => {
    // Тот же GPX под чужим именем — навигаторы так и делают.
    expect(parseTrackFile(Buffer.from(GPX), 'trek.kml').format).toBe('gpx');
  });
});

describe('отказ называется словами', () => {
  it('пустой файл не выдаётся за успешный разбор', () => {
    const r = parseTrackFile(Buffer.from('<kml><Document></Document></kml>'));
    expect(r.tracks).toEqual([]);
    expect(r.problems.join(' ')).toContain('не нашлось ни линии, ни точек');
  });

  it('битый архив говорит о себе, а не молчит', () => {
    const broken = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40)]);
    const r = parseTrackFile(broken, 'x.kmz');
    expect(r.format).toBe('kmz');
    expect(r.problems.length).toBeGreaterThan(0);
  });

  it('мусорные координаты отбрасываются, а не портят замер', () => {
    const dirty = `<kml><Placemark><LineString><coordinates>
      158.6382,53.0787,0 999,999,0 158.6400,53.0790,0
    </coordinates></LineString></Placemark></kml>`;
    expect(parseTrackFile(Buffer.from(dirty)).tracks[0].points).toHaveLength(2);
  });
});

describe('мера расстояния', () => {
  it('градус широты — около 111 км', () => {
    expect(haversineKm(53, 158, 54, 158)).toBeCloseTo(111.2, 0);
  });
});


/**
 * Три ошибки, найденные по исходнику Organic Maps (форк MAPS.ME), — каждая
 * молча теряла бы данные, и ни одна не проявилась бы на простом файле.
 *
 * Разведка репозитория 22.08: libs/kml/serdes.cpp, serdes_common.cpp,
 * libs/map/bookmark_helpers.cpp.
 */
describe('чему научил чужой исходник', () => {
  it('gx:Track — так пишется линия С ВРЕМЕНЕМ, и её нельзя не увидеть', () => {
    // Organic Maps кладёт линию без времени в LineString, а со временем —
    // только в gx:Track. Разбор, знающий один LineString, терял бы самый
    // ценный для нас файл целиком.
    const kml = `<kml><Placemark><name>Выход</name><gx:Track>
      <when>2026-08-22T09:00:00Z</when>
      <when>2026-08-22T09:30:00Z</when>
      <when>2026-08-22T10:00:00Z</when>
      <gx:coord>158.6382 53.0787 120</gx:coord>
      <gx:coord>158.6500 53.0800 180</gx:coord>
      <gx:coord>158.6600 53.0850 240</gx:coord>
    </gx:Track></Placemark></kml>`;
    const r = parseTrackFile(Buffer.from(kml));
    expect(r.tracks).toHaveLength(1);
    expect(r.tracks[0].points).toHaveLength(3);
    expect(r.tracks[0].eleShare).toBe(1);
    expect(r.tracks[0].timespanMin).toBe(60);
  });

  it('время берётся, только если его столько же, сколько точек', () => {
    const kml = `<kml><Placemark><gx:Track>
      <when>2026-08-22T09:00:00Z</when>
      <gx:coord>158.6382 53.0787</gx:coord>
      <gx:coord>158.6500 53.0800</gx:coord>
    </gx:Track></Placemark></kml>`;
    const r = parseTrackFile(Buffer.from(kml));
    expect(r.tracks[0].points).toHaveLength(2);
    // Линию не теряем, но про время молчим: неполные метки — не время.
    expect(r.tracks[0].timespanMin).toBeNull();
  });

  it('немонотонное время — мусор, а не длительность', () => {
    const kml = `<kml><Placemark><gx:Track>
      <when>2026-08-22T10:00:00Z</when>
      <when>2026-08-22T09:00:00Z</when>
      <gx:coord>158.6382 53.0787</gx:coord>
      <gx:coord>158.6500 53.0800</gx:coord>
    </gx:Track></Placemark></kml>`;
    expect(parseTrackFile(Buffer.from(kml)).tracks[0].timespanMin).toBeNull();
  });

  it('MultiGeometry: несколько линий в одной метке — все, а не первая', () => {
    const kml = `<kml><Placemark><name>Два куска</name><MultiGeometry>
      <LineString><coordinates>158.6382,53.0787 158.6500,53.0800</coordinates></LineString>
      <LineString><coordinates>158.6700,53.0900 158.6800,53.0950</coordinates></LineString>
    </MultiGeometry></Placemark></kml>`;
    expect(parseTrackFile(Buffer.from(kml)).tracks).toHaveLength(2);
  });

  it('KMZ с индексом doc.kml и данными в files/ разбирается по данным', () => {
    // Так Organic Maps выгружает НЕСКОЛЬКО категорий: doc.kml в корне это
    // NetworkLink-индекс, а не данные. Разбор первой записи нашёл бы индекс
    // и сказал «пусто», потеряв весь выход.
    const zip = makeZip([
      ['doc.kml', '<kml><Document><NetworkLink><Link><href>files/a.kml</href></Link></NetworkLink></Document></kml>'],
      ['files/a.kml', '<kml><Placemark><name>Настоящий</name><LineString><coordinates>158.6382,53.0787 158.6500,53.0800</coordinates></LineString></Placemark></kml>'],
    ]);
    const r = parseTrackFile(zip, 'backup.kmz');
    expect(r.format).toBe('kmz');
    expect(r.tracks).toHaveLength(1);
    expect(r.tracks[0].name).toBe('Настоящий');
  });

  it('точки-дубликаты ближе метра не раздувают длину', () => {
    const kml = `<kml><Placemark><LineString><coordinates>
      158.63820,53.07870 158.638201,53.078701 158.63900,53.07880
    </coordinates></LineString></Placemark></kml>`;
    expect(parseTrackFile(Buffer.from(kml)).tracks[0].points).toHaveLength(2);
  });
});

/** Минимальный ZIP без сжатия — чтобы не тащить библиотеку в тесты. */
function makeZip(files: Array<[string, string]>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of files) {
    const nameBuf = Buffer.from(name, 'utf-8');
    const data = Buffer.from(content, 'utf-8');
    const crc = 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8);          // метод 0 — без сжатия
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}
