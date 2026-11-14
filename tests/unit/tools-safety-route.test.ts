/**
 * POST /api/tools/safety — «Анализатор безопасности» отвечает данными карточек,
 * без своей оценки и без модели (слово владельца 14.11 «1 и 2»).
 *
 * До 14.11 роут считал своё число риска и просил модель написать оценку,
 * «конкретные рекомендации» и совет на случай ЧС; у маршрута складывал
 * опасности всех связанных мест, включая места «рядом»; по GPS брал ближайшее
 * место без предела расстояния. Теперь:
 *
 *   место   — то, что отдаёт загрузчик карточки места;
 *   маршрут — оценка дня карточки маршрута (route-today), строка по обоим id;
 *   GPS     — ближайшее живое место; дальше предела оценка не отдаётся.
 *
 * Судится вызовом роута: что спросили у базы и загрузчиков, что ушло в ответ.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const ROW_ID = '11111111-1111-4111-8111-111111111111';
const CARD_ID = '22222222-2222-4222-8222-222222222222';
const HIDDEN_ROW_ID = '33333333-3333-4333-8333-333333333333';
const UNKNOWN_ID = '99999999-9999-4999-8999-999999999999';
const PLACE_ID = '4a474632-d8d6-4147-9fa1-ed149edb1a62';

interface Call { sql: string; params: unknown[] }
const calls: Call[] = [];
let nearest: Record<string, unknown> | null = null;
let dbFails = false;

vi.mock('@/lib/database', () => ({
  query: async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (dbFails) throw Object.assign(new Error('connection refused'), { code: '08006' });
    const id = String(params[0]);
    if (sql.includes('ark_id::text = $1')) {
      const row = id === ROW_ID || id === CARD_ID ? ROW_ID : id === HIDDEN_ROW_ID ? HIDDEN_ROW_ID : null;
      return { rows: row ? [{ id: row, zone: null, season: null, lat: null, lng: null }] : [] };
    }
    if (sql.includes('FROM kamchatka_routes')) {
      // Видимость решает сам запрос: скрытую и слитую строку база не отдаёт.
      return {
        rows: id === ROW_ID
          ? [{ card_id: CARD_ID, title: 'Пиначево — Центральный', hazards: ['bears', 'river_crossing'], mchs_registration_required: true, mchs_phone: '+7 (4152) 23-53-62' }]
          : [],
      };
    }
    if (sql.includes('FROM places p')) return { rows: nearest ? [nearest] : [] };
    return { rows: [] };
  },
}));

const loadPlaceDetail = vi.fn();
vi.mock('@/lib/places/place-detail', () => ({ loadPlaceDetail: (...a: unknown[]) => loadPlaceDetail(...a) }));

const routeToday = vi.fn();
vi.mock('@/lib/routes/route-today', () => ({ routeToday: (...a: unknown[]) => routeToday(...a) }));

// Модель в этом роуте не зовётся никакой дверью: любой вызов — отказ теста.
const modelCalled = vi.fn();
vi.mock('@/lib/ai/providers', () => new Proxy({}, {
  get: (_t, name) => (name === '__esModule' ? true : (...a: unknown[]) => { modelCalled(name, ...a); return Promise.resolve('{}'); }),
  has: () => true,
}));

import { POST } from '@/app/api/tools/safety/route';
import { ROUTE_ROW_BY_ANY_ID_SQL } from '@/lib/routes/collect-signals';
import { NEAREST_PLACE_SQL, NEAREST_PLACE_MAX_KM } from '@/lib/places/nearby';
import { VERDICT_LABELS } from '@/lib/routes/go-verdict';

const PLACE_DATA = {
  id: PLACE_ID,
  name: 'Авачинский вулкан',
  locationType: 'volcano',
  description: 'Длинное описание, которое экрану инструмента не нужно',
  safety: { hazardTypes: ['volcanic_gas'], registrationRequired: true, source: 'manual' },
  realtime: { isOpen: true, status: 'yellow', updatedAt: '2026-11-14T00:00:00Z', activeAlerts: ['Шторм'] },
  volcanoStatus: { colorCode: 'yellow', observedAt: '2026-11-13T00:00:00Z' },
  eco: { zone: 'natural_park', permitRequired: true, rules: null, permitUrl: null },
  tours: [{ id: 't1' }],
};

const VERDICT = { status: 'no', code: 'closure', reason: 'Парк закрыт для посещения', unknown: [] };
const SIGNALS = { alerts: [], volcanoes: [], inSeason: true, weather: null, closures: [{ title: 'Парк закрыт' }] };

let ipSeq = 0;
function ask(body: unknown): Promise<Response> {
  ipSeq += 1;
  return POST(new NextRequest('http://localhost/api/tools/safety', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.8.${Math.floor(ipSeq / 200)}.${ipSeq % 200}` },
    body: JSON.stringify(body),
  }));
}
const json = async (r: Response) => await r.json() as { success: boolean; error?: string; data?: Record<string, unknown> };

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  calls.length = 0;
  nearest = null;
  dbFails = false;
  loadPlaceDetail.mockReset();
  loadPlaceDetail.mockResolvedValue({ status: 200, body: { success: true, data: PLACE_DATA } });
  routeToday.mockReset();
  routeToday.mockResolvedValue({ verdict: VERDICT, signals: SIGNALS });
  modelCalled.mockReset();
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  expect(modelCalled, 'модель в «Анализаторе безопасности» не зовётся').not.toHaveBeenCalled();
  errSpy.mockRestore();
});

describe('место — данные его карточки', () => {
  it('по номеру места: загрузчик карточки, без счёта просмотра; в ответе только то, что рисует экран', async () => {
    const res = await ask({ placeId: PLACE_ID });
    expect(res.status).toBe(200);
    expect(loadPlaceDetail).toHaveBeenCalledWith(PLACE_ID, { countView: false });
    const { data } = await json(res);
    expect(data).toEqual({
      kind: 'place',
      distanceKm: null,
      place: {
        id: PLACE_ID, name: 'Авачинский вулкан', locationType: 'volcano',
        safety: PLACE_DATA.safety, realtime: PLACE_DATA.realtime, volcanoStatus: PLACE_DATA.volcanoStatus, eco: PLACE_DATA.eco,
      },
    });
  });

  it('своей оценки и текстов модели в ответе нет', async () => {
    const { data } = await json(await ask({ placeId: PLACE_ID }));
    for (const gone of ['riskScore', 'kuzmichAssessment', 'recommendations', 'emergencyTip']) {
      expect(data).not.toHaveProperty(gone);
    }
  });

  it('места нет — 404 словами загрузчика; сбой загрузчика — 500, а не «не найдено»', async () => {
    loadPlaceDetail.mockResolvedValueOnce({ status: 404, body: { success: false, error: 'Место не найдено' } });
    const notFound = await ask({ placeId: PLACE_ID });
    expect(notFound.status).toBe(404);
    expect(await json(notFound)).toEqual({ success: false, error: 'Место не найдено' });

    loadPlaceDetail.mockResolvedValueOnce({ status: 500, body: { success: false, error: 'Не удалось загрузить место. Мы записали отказ.' } });
    const failed = await ask({ placeId: PLACE_ID });
    expect(failed.status).toBe(500);
    expect((await json(failed)).error).toBe('Не удалось загрузить место. Мы записали отказ.');
  });
});

describe('GPS — ближайшее живое место, и далёкое за «ваше» не выдаётся', () => {
  const at = { lat: 53.25, lng: 158.83 };

  it('место рядом: спрошено общим запросом ближайшего, отдана его карточка и расстояние', async () => {
    nearest = { id: PLACE_ID, slug: 'avachinsky', name: 'Авачинский вулкан', location_type: 'volcano', km: 3.4 };
    const res = await ask(at);
    expect(calls[0]).toEqual({ sql: NEAREST_PLACE_SQL, params: [at.lat, at.lng] });
    expect(loadPlaceDetail).toHaveBeenCalledWith(PLACE_ID, { countView: false });
    const { data } = await json(res);
    expect(data?.kind).toBe('place');
    expect(data?.distanceKm).toBe(3);
  });

  it('меньше километра — ноль, без ложной точности', async () => {
    nearest = { id: PLACE_ID, slug: null, name: 'Смотровая', location_type: null, km: 0.7 };
    expect((await json(await ask(at))).data?.distanceKm).toBe(0);
  });

  it('ровно на пределе — ещё «ваше место»; чуть дальше — уже нет', async () => {
    nearest = { id: PLACE_ID, slug: null, name: 'Смотровая', location_type: null, km: NEAREST_PLACE_MAX_KM };
    expect((await json(await ask(at))).data?.kind).toBe('place');
    nearest = { id: PLACE_ID, slug: null, name: 'Смотровая', location_type: null, km: NEAREST_PLACE_MAX_KM + 0.01 };
    expect((await json(await ask(at))).data?.kind).toBe('far');
  });

  it('ближайшее место далеко: оценка не отдаётся, карточка не читается; названы место и расстояние', async () => {
    nearest = { id: 'a1', slug: 'vulkan-ksudach', name: 'Вулкан Ксудач', location_type: 'volcano', km: 42.6 };
    const res = await ask(at);
    expect(res.status).toBe(200);
    expect(loadPlaceDetail).not.toHaveBeenCalled();
    expect((await json(res)).data).toEqual({
      kind: 'far',
      nearest: { id: 'a1', slug: 'vulkan-ksudach', name: 'Вулкан Ксудач', locationType: 'volcano', distanceKm: 43 },
    });
  });

  it('мест с координатами нет — свой исход, не «далеко» и не ошибка', async () => {
    nearest = null;
    expect((await json(await ask(at))).data).toEqual({ kind: 'none' });
    expect(loadPlaceDetail).not.toHaveBeenCalled();
  });

  it('человек вне края — свой исход, база не спрашивается', async () => {
    const res = await ask({ lat: 43.1, lng: 131.9 });
    expect((await json(res)).data).toEqual({ kind: 'outside' });
    expect(calls).toHaveLength(0);
  });

  it('север края и Командоры — внутри края: база спрашивается (прежняя рамка роута их отсекала)', async () => {
    for (const p of [{ lat: 60.5, lng: 166.0 }, { lat: 55.2, lng: 166.2 }]) {
      calls.length = 0;
      const res = await ask(p);
      expect((await json(res)).data?.kind).toBe('none');
      expect(calls).toHaveLength(1);
    }
  });

  it('база не ответила — 500 словами и строка в логе, а не «мест нет»', async () => {
    dbFails = true;
    const res = await ask(at);
    expect(res.status).toBe(500);
    expect((await json(res)).error).toMatch(/не прочиталось/);
    expect(errSpy).toHaveBeenCalled();
    expect(String(errSpy.mock.calls[0]?.[1])).toContain('08006');
  });

  it('расстояние пришло не числом — отказ, а не «рядом»', async () => {
    nearest = { id: PLACE_ID, slug: null, name: 'Смотровая', location_type: null, km: null };
    // null → Number(null) = 0 был бы «меньше километра»: читаем строго.
    nearest.km = 'нет';
    const res = await ask(at);
    expect(res.status).toBe(500);
    expect(loadPlaceDetail).not.toHaveBeenCalled();
  });
});

describe('маршрут — оценка дня его карточки', () => {
  it('по номеру карточки (его отдаёт поиск): оценка спрошена по номеру строки и отдана как есть', async () => {
    const res = await ask({ routeId: CARD_ID });
    expect(res.status).toBe(200);
    expect(calls[0]).toEqual({ sql: ROUTE_ROW_BY_ANY_ID_SQL, params: [CARD_ID] });
    expect(calls[1]?.params).toEqual([ROW_ID]);
    expect(routeToday).toHaveBeenCalledWith(ROW_ID);
    expect((await json(res)).data).toEqual({
      kind: 'route',
      route: { cardId: CARD_ID, title: 'Пиначево — Центральный', hazards: ['bears', 'river_crossing'], registrationRequired: true },
      verdict: { ...VERDICT, label: VERDICT_LABELS.no },
      signals: SIGNALS,
    });
  });

  it('по номеру строки — тот же маршрут и та же ссылка на карточку', async () => {
    const { data } = await json(await ask({ routeId: ROW_ID }));
    expect((data?.route as { cardId: string }).cardId).toBe(CARD_ID);
    expect(routeToday).toHaveBeenCalledWith(ROW_ID);
  });

  it('опасности — только самого маршрута: связанные места не читаются вовсе', async () => {
    await ask({ routeId: CARD_ID });
    expect(calls.some(c => /route_waypoints|location_safety_profile/.test(c.sql))).toBe(false);
  });

  it('телефон из записи маршрута в ответ не уходит', async () => {
    const text = JSON.stringify((await json(await ask({ routeId: CARD_ID }))).data);
    expect(text).not.toContain('23-53-62');
    expect(calls[1]?.sql).not.toMatch(/mchs_phone/);
  });

  it('маршрута нет и маршрут скрыт или слит — 404, оценка не считается', async () => {
    for (const id of [UNKNOWN_ID, HIDDEN_ROW_ID]) {
      const res = await ask({ routeId: id });
      expect(res.status).toBe(404);
      expect(await json(res)).toEqual({ success: false, error: 'Маршрут не найден' });
    }
    expect(routeToday).not.toHaveBeenCalled();
  });

  it('видимость маршрута — условием самого запроса, как у карточки', async () => {
    await ask({ routeId: CARD_ID });
    expect(calls[1]?.sql).toMatch(/merged_into_id IS NULL/);
    expect(calls[1]?.sql).toMatch(/is_visible = TRUE/);
  });

  it('база не ответила — 500 словами и строка в логе, а не «не найден»', async () => {
    dbFails = true;
    const res = await ask({ routeId: CARD_ID });
    expect(res.status).toBe(500);
    expect((await json(res)).error).toMatch(/не прочитался/);
    expect(errSpy).toHaveBeenCalled();
    expect(routeToday).not.toHaveBeenCalled();
  });
});

describe('ближайшее место — только живое и по настоящему расстоянию', () => {
  it('запрос отбирает видимые и не слитые места и сортирует по километрам', () => {
    expect(NEAREST_PLACE_SQL).toMatch(/p\.is_visible = true/);
    expect(NEAREST_PLACE_SQL).toMatch(/p\.merged_into_id IS NULL/);
    expect(NEAREST_PLACE_SQL).toMatch(/ORDER BY d\.km/);
    expect(NEAREST_PLACE_SQL).toMatch(/6371 \* acos/);
    // Прежняя сортировка — сумма квадратов разниц в градусах.
    expect(NEAREST_PLACE_SQL).not.toMatch(/\^2/);
  });
});

describe('вход', () => {
  it('ни места, ни маршрута, ни координат — 400 словами', async () => {
    const res = await ask({ q: 'Авачинский' });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toMatch(/место|маршрут|координаты/i);
  });
});
