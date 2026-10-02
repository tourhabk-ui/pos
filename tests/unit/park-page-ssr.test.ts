/**
 * Карточка парка отдаётся сервером (аудит vedarai.ru 01.10).
 *
 * Прежде /park/[slug] была оболочкой: содержимое клиент тянул из
 * /api/parks/[slug] уже в браузере, и поисковик видел 12–13 слов без
 * заголовка — пять парков, на которые ведут ссылки, для поиска были пусты.
 * Теперь страница и API читают один загрузчик lib/parks/park-page.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const poolQueryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => poolQueryMock(...args) },
}));

import { loadParkPage } from '@/lib/parks/park-page';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const PARK_ROW = {
  slug: 'nalychevo', display_name: 'Природный парк «Налычево»', description: 'Источники и вулканы.',
  zone: 'avachinsky', permit_url: null, permit_email: null, permit_office_address: null,
  permit_office_hours: null, permit_gosuslugi_url: null, permit_online_url: null, search_term: 'Налычево',
};

beforeEach(() => {
  poolQueryMock.mockReset();
});

describe('страница парка не ходит за данными из браузера', () => {
  it('клиентская часть получает данные пропсом и запросов не делает', () => {
    const client = code('app/park/[slug]/_ParkClient.tsx');
    expect(client).toMatch(/export default function ParkClient\(\{ park \}: \{ park: ParkPageData \}\)/);
    expect(client).not.toMatch(/fetch\(/);
    expect(client).not.toMatch(/useEffect/);
  });

  it('страница и API читают один загрузчик', () => {
    expect(code('app/park/[slug]/page.tsx')).toMatch(/loadParkPage\(slug\)/);
    expect(code('app/api/parks/[slug]/route.ts')).toMatch(/loadParkPage\(slug\)/);
    expect(code('app/api/parks/[slug]/route.ts')).not.toMatch(/FROM parks/);
  });

  it('неизвестный парк — 404 страницы, а не пустая оболочка', () => {
    expect(code('app/park/[slug]/page.tsx')).toMatch(/if \(park === null\) notFound\(\)/);
  });

  it('ссылки на маршруты — по ЧПУ, иначе по id карточки маршрута', () => {
    expect(code('app/park/[slug]/_ParkClient.tsx')).toMatch(/href=\{`\/routes\/\$\{route\.slug \?\? route\.id\}`\}/);
    expect(code('lib/parks/park-page.ts')).toMatch(/COALESCE\(ark_id, id\)::text AS id, slug/);
  });
});

describe('загрузчик различает «нет», «пусто» и «не смог»', () => {
  it('нет парка — null', async () => {
    poolQueryMock.mockResolvedValue({ rows: [] });
    expect(await loadParkPage('narnia')).toBeNull();
  });

  it('slug не той формы — null без запроса в базу', async () => {
    expect(await loadParkPage('DROP TABLE;')).toBeNull();
    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it('маршруты не прочитались — парк есть, routesFailed и строка в логе', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    poolQueryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM parks')) return Promise.resolve({ rows: [PARK_ROW] });
      return Promise.reject(Object.assign(new Error('boom'), { code: '42P01' }));
    });
    const park = await loadParkPage('nalychevo');
    expect(park?.displayName).toBe('Природный парк «Налычево»');
    expect(park?.routes).toEqual([]);
    expect(park?.routesFailed).toBe(true);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('[parks] маршруты парка не прочитаны'), 'nalychevo', 'sqlstate=42P01', 'boom');
    errSpy.mockRestore();
  });

  it('база не ответила на сам парк — бросает, решает вызывающий', async () => {
    poolQueryMock.mockRejectedValue(new Error('connection refused'));
    await expect(loadParkPage('nalychevo')).rejects.toThrow('connection refused');
  });

  it('маршрут без ЧПУ получает slug: null, а не undefined', async () => {
    poolQueryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM parks')) return Promise.resolve({ rows: [PARK_ROW] });
      return Promise.resolve({ rows: [{ id: 'a', title: 'К источникам', description: null, distance_km: null,
        elevation_gain_m: null, duration_hours: null, difficulty: null, season: null,
        mchs_registration_required: null, hazards: null }] });
    });
    const park = await loadParkPage('nalychevo');
    expect(park?.routes[0]).toMatchObject({ id: 'a', slug: null, hazards: [] });
    expect(park?.routesFailed).toBe(false);
  });
});
