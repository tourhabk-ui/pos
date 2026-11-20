/**
 * SEO-аудит 20.11.2026: кнопка «Скачать GPX» (500), тестовый оператор в
 * списке /operators (ссылка на 404) и относительная ссылка на PDF-паспорт
 * на карточке Авачинского (404).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const query = vi.fn();
vi.mock('@/lib/database', () => ({ query: (...a: unknown[]) => query(...a) }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: (...a: unknown[]) => query(...a) } }));

import { GET as exportGET } from '@/app/api/routes/[id]/export/route';
import { gpxContentDisposition, gpxAsciiBase } from '@/lib/routes/gpx-filename';
import { queryOperators } from '@/lib/operators/list-query';
import { TEST_STAND_PARTNER_IDS } from '@/lib/seat-requests/test-stand';
import { absoluteHttpUrls } from '@/lib/parks/approved-routes';

const ID = '807f2f60-a92f-4726-9986-67cfe944a2e8';

beforeEach(() => {
  query.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

function call(format?: string) {
  const url = `https://vedarai.ru/api/routes/${ID}/export${format ? `?format=${format}` : ''}`;
  return exportGET(new NextRequest(url), { params: Promise.resolve({ id: ID }) });
}

describe('GPX-экспорт маршрута', () => {
  const row = {
    id: ID, title: 'Гейзеры Камчатки: «Долина» & Узон', description: '<p>Описание маршрута</p>',
    lat: '54.43', lng: '160.14', location_type: 'geyser', activity_type: null, category: 'route',
    payload: {}, geometry: { type: 'LineString', coordinates: [[160.1, 54.4], [160.2, 54.5]] },
  };

  it('русское название больше не роняет ответ: 200 и файл GPX', async () => {
    query.mockResolvedValue({ rows: [row] });
    const res = await call('gpx');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/gpx+xml');
    const cd = res.headers.get('content-disposition')!;
    expect(cd).toMatch(/^attachment; filename="[a-z0-9-]+\.gpx"; filename\*=UTF-8''/);
    expect(decodeURIComponent(cd.split("UTF-8''")[1])).toBe('Гейзеры Камчатки «Долина» & Узон.gpx');
    const body = await res.text();
    expect(body).toContain('<trkpt lat="54.4" lon="160.1">');
    expect(body).toContain('&amp; Узон');
  });

  it('без format — тоже GPX', async () => {
    query.mockResolvedValue({ rows: [row] });
    expect((await call()).status).toBe(200);
  });

  it('другой формат — 400, а не GPX под чужим именем', async () => {
    const res = await call('geojson');
    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('маршрута нет — 404', async () => {
    query.mockResolvedValue({ rows: [] });
    expect((await call('gpx')).status).toBe(404);
  });

  it('заголовок — только Latin-1 при любом названии', () => {
    for (const t of ['Вулкан Горелый', 'Озеро 熊', '"/\\:*?<>|', '', null]) {
      const cd = gpxContentDisposition(t, ID);
      expect(() => new Headers({ 'content-disposition': cd })).not.toThrow();
    }
    expect(gpxAsciiBase('Вулкан Горелый', ID)).toBe('vulkan-gorelyj');
    expect(gpxAsciiBase('熊', ID)).toBe('route-807f2f60');
  });
});

describe('/operators без тестового стенда', () => {
  it('во всех запросах списка — исключение id стенда', async () => {
    query.mockResolvedValue({ rows: [] });
    await queryOperators({ page: 1, limit: 12 });
    const sqls = query.mock.calls.map((c) => String(c[0])).filter((s) => s.includes('FROM partners p'));
    expect(sqls.length).toBeGreaterThan(0);
    for (const s of sqls) expect(s).toContain(`p.id::text NOT IN ('${TEST_STAND_PARTNER_IDS[0]}')`);
  });
});

describe('паспорт маршрута парка: только абсолютные ссылки', () => {
  it('относительная ссылка источника отбрасывается', () => {
    expect(absoluteHttpUrls([
      'https://www.vulcanikamchatki.ru/files/pasport_7_voshozhdenie_na_avachinskij_vulkan.pdf',
      'marshrut_voshozhdenie_na_avachinskij1.pdf',
      'javascript:alert(1)',
    ])).toEqual(['https://www.vulcanikamchatki.ru/files/pasport_7_voshozhdenie_na_avachinskij_vulkan.pdf']);
    expect(absoluteHttpUrls(null)).toEqual([]);
  });
});
