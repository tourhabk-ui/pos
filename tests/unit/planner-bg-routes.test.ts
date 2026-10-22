/**
 * Сторож: фоновые маршруты карты планировщика — три исхода, не два (§4.0).
 *
 * До 22.10 `.catch(() => [])` и `r.json()` без проверки `r.ok` превращали
 * отказ каталога в «маршрутов нет», и карта молча пустела. А ответ
 * приводился к своей форме вслепую: каталог отдаёт camelCase и (теперь) зону,
 * экран ждал snake_case — и вид маршрута, и зона были пустыми всегда.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { loadBackgroundRoutes, toPlannerRoute } from '@/lib/planner/bg-routes';

type Reply = { ok: boolean; status: number; body?: unknown; throws?: boolean };

function fakeFetch(byType: Record<string, Reply>) {
  const calls: string[] = [];
  const impl = async (url: string) => {
    calls.push(url);
    const type = new URL(url, 'http://x').searchParams.get('activity_type') ?? '';
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
    expect(await loadBackgroundRoutes(['volcano', 'fishing'], impl)).toEqual({ state: 'empty' });
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
