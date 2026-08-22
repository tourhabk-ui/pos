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
import { parseTrackFile, unzipFirstEntry, haversineKm } from '@/lib/field/track-import';

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
    const entry = unzipFirstEntry(KMZ);
    expect(entry).not.toBeNull();
    expect(entry!.data.toString('utf-8')).toContain('<kml');
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
