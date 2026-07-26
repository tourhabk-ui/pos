/**
 * KML-инбокс: разбор треков сообщества и правила честности импорта —
 * реальные треки не перетираются, несматченное создаётся скрытым.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const queryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => queryMock(...args) },
}));

import { parseKml, cleanTrackName, importKmlTrack } from '@/lib/import/kml-inbox';

const KML = (name: string, coords: string) => `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
<name>${name}</name>
<description>Скачено с сайта https://idilesom.com</description>
<Placemark><LineString><tessellate>1</tessellate>
<coordinates>${coords}</coordinates>
</LineString></Placemark></Document></kml>`;

const COORDS = '158.638,53.078,0 158.640,53.079,0 158.644,53.080,0';

describe('parseKml / cleanTrackName', () => {
  it('вытаскивает имя, автора и координаты [lng,lat] (нулевая высота отбрасывается)', () => {
    const p = parseKml(KML('Маршрут Озеро Синичкино. Маршрут загрузил(а) Roman Pozdny', COORDS));
    expect(p?.name).toBe('Озеро Синичкино');
    expect(p?.uploader).toBe('Roman Pozdny');
    expect(p?.coordinates).toEqual([[158.638, 53.078], [158.64, 53.079], [158.644, 53.08]]);
  });

  it('имя без служебных префиксов остаётся как есть', () => {
    expect(cleanTrackName('Озеро Большой Кар')).toEqual({ name: 'Озеро Большой Кар', uploader: null });
  });

  it('нет coordinates — parse_error, не падение', () => {
    expect(parseKml('<kml><Document><name>x</name></Document></kml>')).toBeNull();
  });
});

describe('importKmlTrack — правила честности', () => {
  const route = (over: Record<string, unknown> = {}) => ({
    id: 'r1', title: 'Озеро Синичкино', lat: '53.078', lng: '158.638',
    geom_source: null, has_geometry: false, ...over,
  });

  beforeEach(() => queryMock.mockReset());

  it('матч по имени, пустая геометрия — трек пишется с source=kml_inbox и атрибуцией', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/SELECT id, title/.test(sql)) return { rows: [route()] };
      return { rows: [] };
    });
    const out = await importKmlTrack('sinichkino.kml',
      KML('Маршрут Озеро Синичкино. Маршрут загрузил(а) Roman Pozdny', COORDS));

    expect(out.status).toBe('imported');
    expect(out.match_by).toBe('name');
    const update = queryMock.mock.calls.find(c => /UPDATE kamchatka_routes/.test(c[0] as string));
    const geo = JSON.parse((update![1] as string[])[0]);
    expect(geo.source).toBe('kml_inbox');
    const meta = JSON.parse((update![1] as string[])[1]);
    expect(meta.kml_inbox.uploader).toBe('Roman Pozdny');
  });

  it('реальный трек (osm/idilesom/без метки) НЕ перетирается', async () => {
    for (const geom_source of ['osm', 'idilesom', null]) {
      queryMock.mockReset();
      queryMock.mockImplementation(async (sql: string) => {
        if (/SELECT id, title/.test(sql)) return { rows: [route({ geom_source, has_geometry: true })] };
        return { rows: [] };
      });
      const out = await importKmlTrack('sinichkino.kml', KML('Озеро Синичкино', COORDS));
      expect(out.status, String(geom_source)).toBe('kept_existing_track');
      expect(queryMock.mock.calls.some(c => /UPDATE|INSERT/.test(c[0] as string))).toBe(false);
    }
  });

  it('синтетика перетирается настоящим community-треком', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/SELECT id, title/.test(sql)) {
        return { rows: [route({ geom_source: 'waypoints_synthetic', has_geometry: true })] };
      }
      return { rows: [] };
    });
    const out = await importKmlTrack('sinichkino.kml', KML('Озеро Синичкино', COORDS));
    expect(out.status).toBe('imported');
  });

  it('матч по близости, когда имя не совпало (центр маршрута < 4 км от старта трека)', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/SELECT id, title/.test(sql)) return { rows: [route({ title: 'Совсем другое имя' })] };
      return { rows: [] };
    });
    const out = await importKmlTrack('x.kml', KML('Неизвестное озеро', COORDS));
    expect(out.status).toBe('imported');
    expect(out.match_by).toBe('proximity');
  });

  it('нет совпадений — создаётся СКРЫТЫЙ маршрут (очередь на ревью), не публикация', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/SELECT id, title/.test(sql)) return { rows: [] };
      return { rows: [] };
    });
    const out = await importKmlTrack('kar.kml', KML('Озеро Большой Кар', COORDS));
    expect(out.status).toBe('created_hidden');
    const insert = queryMock.mock.calls.find(c => /INSERT INTO kamchatka_routes/.test(c[0] as string));
    expect(insert![0]).toMatch(/is_visible, dedupe_key/);
    expect(insert![0]).toMatch(/false, \$6/);
  });
});
