/**
 * tests/unit/parks-from-db.test.ts
 *
 * GET /api/parks/[slug] и GET /api/parks — справочник парков переехал из
 * хардкода (PARK_MAP) в таблицу parks (migration 712). Контракт ответа
 * карточки парка прежний (slug/displayName/description/zone/permit_url/
 * routes); маршруты ищутся по search_term из БД; неизвестный slug → 404;
 * ошибка запроса маршрутов не роняет карточку парка.
 *
 * `mchs_phone` из контракта УБРАН 15.09 и проверяется на отсутствие. В
 * колонке лежали `+7 (4152) 23-53-62` (назван поимённо в шапке
 * `lib/safety/emergency-numbers.ts` среди пяти разъехавшихся «номеров МЧС»,
 * владелец 17.07 подтвердить не смог) и NULL у двух парков — последний давал
 * на плитке «112 — Спасение» строку «МЧС:» и пустоту. Экран берёт
 * региональный номер из единого проверенного источника; отдавать второй
 * источник того же факта наружу нельзя — подхватит следующий экран и
 * разойдётся снова. Подробности и сторож: tests/unit/park-emergency-number.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const poolQueryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => poolQueryMock(...args) },
}));

import { GET as getPark } from '@/app/api/parks/[slug]/route';
import { GET as listParks } from '@/app/api/parks/route';

const PARK_ROW = {
  slug: 'nalychevo',
  display_name: 'Природный парк «Налычево»',
  description: 'Термальные источники и вулканы.',
  zone: 'avachinsky',
  mchs_phone: '+7 (4152) 23-53-62',
  permit_url: 'https://nalychevo.ru',
  search_term: 'Налычево',
};

const ROUTE_ROW = {
  id: '1', title: 'К Налычевским источникам', description: null,
  distance_km: '20', elevation_gain_m: 400, duration_hours: '8',
  difficulty: 'medium', season: 'summer',
  mchs_registration_required: true, hazards: [],
};

function ctx(slug: string) {
  return { params: Promise.resolve({ slug }) };
}
const req = new Request('http://localhost/api/parks/nalychevo');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/parks/[slug] — из таблицы parks', () => {
  it('парк из БД → прежний контракт, маршруты по search_term', async () => {
    poolQueryMock.mockImplementation((sql: string, params: unknown[]) => {
      if (sql.includes('FROM parks')) return Promise.resolve({ rows: [PARK_ROW] });
      if (sql.includes('FROM kamchatka_routes')) {
        expect(params).toEqual(['%Налычево%']);
        return Promise.resolve({ rows: [ROUTE_ROW] });
      }
      throw new Error('unexpected SQL: ' + sql);
    });

    const res = await getPark(req, ctx('nalychevo'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toMatchObject({
      slug: 'nalychevo',
      displayName: 'Природный парк «Налычево»',
      zone: 'avachinsky',
      permit_url: 'https://nalychevo.ru',
    });
    // Фикстура строки БД по-прежнему несёт номер — именно поэтому проверка
    // нужна: она о том, что роут его НЕ ПРОПУСКАЕТ, а не о том, что его нет
    // в таблице.
    expect(json).not.toHaveProperty('mchs_phone');
    expect(json.routes).toHaveLength(1);
    expect(json.routes[0].title).toBe('К Налычевским источникам');
  });

  it('неизвестный slug → 404', async () => {
    poolQueryMock.mockResolvedValue({ rows: [] });

    const res = await getPark(req, ctx('narnia'));
    expect(res.status).toBe(404);
  });

  it('невалидный slug → 404 без запроса в БД', async () => {
    const res = await getPark(req, ctx('DROP TABLE;'));
    expect(res.status).toBe(404);
    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it('ошибка запроса маршрутов → парк отдаётся с routes: []', async () => {
    poolQueryMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM parks')) return Promise.resolve({ rows: [PARK_ROW] });
      return Promise.reject(new Error('db down'));
    });

    const res = await getPark(req, ctx('nalychevo'));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.routes).toEqual([]);
  });
});

describe('GET /api/parks — список', () => {
  it('активные парки в camelCase', async () => {
    poolQueryMock.mockResolvedValue({ rows: [
      { slug: 'nalychevo', display_name: 'Природный парк «Налычево»', description: 'x', zone: 'avachinsky' },
    ] });

    const res = await listParks();
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.parks).toEqual([
      { slug: 'nalychevo', displayName: 'Природный парк «Налычево»', description: 'x', zone: 'avachinsky' },
    ]);
  });

  it('ошибка БД → честный 500', async () => {
    poolQueryMock.mockRejectedValue(new Error('db down'));
    const res = await listParks();
    expect(res.status).toBe(500);
  });
});
