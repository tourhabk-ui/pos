/**
 * Сторож: фоновые маршруты карты планировщика — три исхода, не два (§4.0).
 *
 * До 22.10 `.catch(() => [])` и `r.json()` без проверки `r.ok` превращали
 * отказ каталога в «маршрутов нет», и карта молча пустела. А ответ
 * приводился к своей форме вслепую: каталог отдаёт camelCase и (теперь) зону,
 * экран ждал snake_case — и вид маршрута, и зона были пустыми всегда.
 *
 * Пятый круг (22.10): плитки мест ищут маршрут по месту ПУТИ (`place_type`
 * каталога), занятия — по виду маршрута; виды мест — из словаря мест и
 * проходят схему входа каталога; по умолчанию спрашивается только то, что
 * даёт точки.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  BG_DEFAULT_TYPES, PLACE_TILE_LOCATION_TYPES, bgRoutesUrl, loadBackgroundRoutes, toPlannerRoute,
} from '@/lib/planner/bg-routes';
import { CatalogQuerySchema } from '@/lib/routes/catalog-query';
import { LOCATION_TYPES } from '@/lib/places/location-types';

type Reply = { ok: boolean; status: number; body?: unknown; throws?: boolean };

function fakeFetch(byType: Record<string, Reply>) {
  const calls: string[] = [];
  const impl = async (url: string) => {
    calls.push(url);
    // Плитка занятия — по виду маршрута, плитка места — по виду места пути.
    const sp = new URL(url, 'http://x').searchParams;
    const type = sp.get('activity_type') ?? sp.get('place_type') ?? '';
    const r = byType[type];
    if (!r || r.throws) throw new TypeError('Failed to fetch');
    return { ok: r.ok, status: r.status, json: async () => r.body } as Response;
  };
  return { impl, calls };
}

const item = (id: string, extra: Record<string, unknown> = {}) => ({
  id, title: `Маршрут ${id}`, description: 'Описание', lat: 53.2, lng: 158.8,
  activityType: 'helicopter', locationType: 'volcano', zone: 'avachinsky', kind: 'route', ...extra,
});

afterEach(() => { vi.restoreAllMocks(); });

describe('три исхода', () => {
  it('503 каталога — отказ, а не «маршрутов нет», и в лог с именем проверки', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { impl } = fakeFetch({ trekking: { ok: false, status: 503, body: { success: false } } });
    const r = await loadBackgroundRoutes(['trekking'], impl);
    expect(r).toEqual({ state: 'failed', failedTypes: ['trekking'] });
    expect(err).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ check: 'planner_bg_routes', type: 'trekking', status: 503 }));
  });

  it('сеть оборвалась — отказ', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { impl } = fakeFetch({ trekking: { ok: true, status: 200, throws: true } });
    expect((await loadBackgroundRoutes(['trekking'], impl)).state).toBe('failed');
  });

  it('success:false при 200 — отказ', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { impl } = fakeFetch({ trekking: { ok: true, status: 200, body: { success: false, error: 'x' } } });
    expect((await loadBackgroundRoutes(['trekking'], impl)).state).toBe('failed');
  });

  it('записи пришли, а разобрать нельзя ни одну — отказ (сменилась форма), не пустота', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { impl } = fakeFetch({ trekking: { ok: true, status: 200, body: { success: true, data: [{ id: 'a' }] } } });
    expect((await loadBackgroundRoutes(['trekking'], impl)).state).toBe('failed');
  });

  it('все ответили, маршрутов нет — пусто', async () => {
    const { impl } = fakeFetch({
      volcano: { ok: true, status: 200, body: { success: true, data: [] } },
      fishing: { ok: true, status: 200, body: { success: true, data: [] } },
    });
    expect(await loadBackgroundRoutes(['volcano', 'fishing'], impl)).toEqual({ state: 'empty', emptyTypes: ['volcano', 'fishing'] });
  });

  it('точки есть, а по одному виду маршрутов нет — этот вид назван пустым, а не отказом', async () => {
    const { impl } = fakeFetch({
      trekking: { ok: true, status: 200, body: { success: true, data: [item('a')] } },
      volcano: { ok: true, status: 200, body: { success: true, data: [] } },
    });
    expect(await loadBackgroundRoutes(['volcano', 'trekking'], impl)).toMatchObject({
      state: 'ok', failedTypes: [], emptyTypes: ['volcano'],
    });
  });

  it('вид, чьи маршруты уже пришли по другому виду, — не пустой: маршруты у него есть', async () => {
    const { impl } = fakeFetch({
      trekking: { ok: true, status: 200, body: { success: true, data: [item('a')] } },
      helicopter: { ok: true, status: 200, body: { success: true, data: [item('a')] } },
    });
    expect(await loadBackgroundRoutes(['trekking', 'helicopter'], impl)).toMatchObject({ state: 'ok', emptyTypes: [] });
  });

  it('один не ответил, второй пуст — «не загрузились», а не «нет»', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { impl } = fakeFetch({
      volcano: { ok: true, status: 200, body: { success: true, data: [] } },
      fishing: { ok: false, status: 500 },
    });
    expect(await loadBackgroundRoutes(['volcano', 'fishing'], impl)).toEqual({ state: 'failed', failedTypes: ['fishing'] });
  });

  it('часть не ответила, точки есть — рисуем и называем, что не всё', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { impl } = fakeFetch({
      trekking: { ok: true, status: 200, body: { success: true, data: [item('a'), item('b')] } },
      fishing: { ok: false, status: 502 },
    });
    const r = await loadBackgroundRoutes(['trekking', 'fishing'], impl);
    expect(r.state).toBe('ok');
    if (r.state === 'ok') {
      expect(r.routes.map(x => x.id)).toEqual(['a', 'b']);
      expect(r.failedTypes).toEqual(['fishing']);
      // Отказ — не «пусто».
      expect(r.emptyTypes).toEqual([]);
    }
  });

  it('один маршрут в двух интересах — одна точка', async () => {
    const { impl, calls } = fakeFetch({
      trekking: { ok: true, status: 200, body: { success: true, data: [item('a'), item('b')] } },
      volcano: { ok: true, status: 200, body: { success: true, data: [item('b'), item('c')] } },
    });
    const r = await loadBackgroundRoutes(['trekking', 'volcano', 'trekking'], impl);
    expect(calls).toHaveLength(2);
    expect(r.state === 'ok' && r.routes.map(x => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('без интересов — отказ, а не «пусто» (ноль на нулевом входе)', async () => {
    const { impl } = fakeFetch({});
    expect((await loadBackgroundRoutes([], impl)).state).toBe('failed');
  });
});

describe('разбор ответа каталога', () => {
  it('camelCase каталога → поля экрана, зона из базы', () => {
    expect(toPlannerRoute(item('a'))).toEqual({
      id: 'a', title: 'Маршрут a', description: 'Описание', lat: 53.2, lng: 158.8,
      activity_type: 'helicopter', location_type: 'volcano', zone: 'avachinsky', plannerZone: 'avachinsky',
    });
  });

  it('зона не записана — null, район вне четырёх зон — записан, но не зона планировщика', () => {
    expect(toPlannerRoute(item('a', { zone: null }))?.zone).toBeNull();
    const far = toPlannerRoute(item('a', { zone: 'krai_koryak' }));
    expect(far?.zone).toBe('krai_koryak');
    expect(far?.plannerZone).toBeNull();
  });

  it('без координат или id точку не рисуем', () => {
    expect(toPlannerRoute(item('a', { lat: null }))).toBeNull();
    expect(toPlannerRoute(item('', {}))).toBeNull();
    expect(toPlannerRoute(null)).toBeNull();
  });
});

describe('что спрашивается у каталога', () => {
  const params = (url: string) => new URL(url, 'http://x').searchParams;

  it('плитка места — по месту пути (place_type), занятие — по виду маршрута; оба с координатами', async () => {
    const { impl, calls } = fakeFetch({});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await loadBackgroundRoutes(['volcano', 'hot_spring', 'sea', 'trekking'], impl);
    const byKey = new Map(calls.map(u => [params(u).get('activity_type') ?? params(u).get('place_type'), params(u)]));
    expect(byKey.get('volcano')?.get('activity_type')).toBeNull();
    expect(byKey.get('volcano')?.get('place_type')).toBe('volcano');
    expect(byKey.get('hot_spring,thermal')?.get('place_type')).toBe('hot_spring,thermal');
    expect(byKey.get('bay,cape,beach')?.get('activity_type')).toBeNull();
    expect(byKey.get('trekking')?.get('place_type')).toBeNull();
    for (const p of byKey.values()) expect(p.get('hasCoords')).toBe('true');
  });

  it('виды мест плиток — из словаря мест (без выдуманных) и проходят схему входа каталога', () => {
    for (const [tile, types] of Object.entries(PLACE_TILE_LOCATION_TYPES)) {
      expect(types.length, tile).toBeGreaterThan(0);
      for (const t of types) expect(Object.keys(LOCATION_TYPES), `${tile}: ${t}`).toContain(t);
      const sent = params(bgRoutesUrl(tile)).get('place_type');
      const parsed = CatalogQuerySchema.safeParse({ place_type: sent });
      expect(parsed.success, tile).toBe(true);
      if (parsed.success) expect(parsed.data.place_type).toEqual([...types]);
    }
  });

  it('по умолчанию — только интересы, что дают точки: треккинг и вулканы, без «Рыбалки»', async () => {
    const { impl, calls } = fakeFetch({});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await loadBackgroundRoutes(BG_DEFAULT_TYPES, impl);
    expect(calls.map(u => params(u).get('activity_type') ?? params(u).get('place_type')).sort()).toEqual(['trekking', 'volcano']);
  });

  it('только маршруты, порядок для поля, описание первой строкой — и форма проходит схему каталога', () => {
    for (const tile of ['volcano', 'sea', 'trekking', 'helicopter']) {
      const sp = params(bgRoutesUrl(tile));
      // Сервер, не знающий place_type, без рода отдал бы и места.
      expect(sp.get('kind'), tile).toBe('route');
      expect(sp.get('sort'), tile).toBe('navigable');
      expect(sp.get('brief'), tile).toBe('1');
      expect(sp.get('hasCoords'), tile).toBe('true');
      expect(sp.get('limit'), tile).toBe(String(30));
      const parsed = CatalogQuerySchema.safeParse(Object.fromEntries(sp));
      expect(parsed.success, tile).toBe(true);
      // Порядок — тот, что схема знает, а не молча отброшенный к «по алфавиту».
      if (parsed.success) expect(parsed.data.sort).toBe('navigable');
    }
  });
});

describe('сколько маршрутов есть, а сколько показано', () => {
  const reply = (data: unknown[], meta?: unknown): Reply => ({ ok: true, status: 200, body: { success: true, data, ...(meta === undefined ? {} : { meta }) } });

  it('каталог знает больше, чем пришло, — интерес назван с числами', async () => {
    const { impl } = fakeFetch({
      volcano: reply([item('a'), item('b')], { total: 52, page: 1, limit: 30, pages: 2 }),
      trekking: reply([item('c')], { total: 1, page: 1, limit: 30, pages: 1 }),
    });
    const r = await loadBackgroundRoutes(['volcano', 'trekking'], impl);
    expect(r.state === 'ok' && r.truncated).toEqual([{ type: 'volcano', shown: 2, total: 52 }]);
  });

  it('total не пришёл или не число — «показаны все» не утверждается, и усечения не выдумывается', async () => {
    const { impl } = fakeFetch({
      volcano: reply([item('a')]),
      trekking: reply([item('b')], { total: 'много' }),
    });
    const r = await loadBackgroundRoutes(['volcano', 'trekking'], impl);
    expect(r.state === 'ok' && r.truncated).toEqual([]);
  });
});
