/**
 * Досыл офлайн-очередей поля (#2448) — вызовом, а не чтением исходника.
 *
 * До 14.10 у наблюдений с экрана маршрута и у полевых проверок было три дыры:
 *  1. любой неуспешный ответ останавливал проход, и запись, которую сервер не
 *     примет никогда (400 на форме), стояла первой навсегда — всё за ней не
 *     уходило;
 *  2. у наблюдения не ушёл второй снимок — запись удалялась вместе с третьим;
 *  3. отказ уходил в `catch { break; }` без следа.
 *
 * Здесь — настоящие описания обеих очередей (lib/offline/field-queues), само
 * правило досыла (lib/offline/outbox), хранилище в памяти и подменённый fetch.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  flushOutbox, isRecordRefusal, memoryStore, postJson, serialized, queueCounts,
  type OutboxRecord, type OutboxSpec,
} from '@/lib/offline/outbox';
import { TRAIL_OBSERVATIONS, FIELD_CHECKS } from '@/lib/offline/field-queues';
import type { TrailObservationDraft, FieldCheckQueueItem } from '@/lib/offline/db';

type Reply = Response | 'network';
type Call = { url: string; body: Record<string, unknown> };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** fetch, который отвечает по сценарию и запоминает, что у него просили. */
function fakeNet(reply: (call: Call, n: number) => Reply | Promise<Reply>) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const call = { url, body: JSON.parse(String(init?.body ?? 'null')) as Record<string, unknown> };
    calls.push(call);
    const r = await reply(call, calls.length);
    if (r === 'network') throw new TypeError('Failed to fetch');
    return r;
  }) as unknown as typeof fetch;
  const post = (url: string, payload: unknown) => postJson(url, payload, fetchImpl);
  return { calls, post };
}

function obs(id: string, text: string, photos: string[] = []): TrailObservationDraft {
  return { id, reportType: 'animal', text, lat: 53.1, lng: 158.6, photos, queuedAt: Number(id.replace(/\D/g, '')) || 1 };
}

function check(id: string, over: Partial<FieldCheckQueueItem> = {}): FieldCheckQueueItem {
  return {
    id, targetKind: 'route', targetId: 'route-1', verdict: 'ok',
    reportedLat: 53.1, reportedLng: 158.6, accuracyM: 8, note: null, tripTag: null,
    objectLat: null, objectLng: null, objectSource: null, photos: [], queuedAt: 1, ...over,
  };
}

const REPORTS = '/api/safety/reports';
const REPORT_PHOTO = '/api/safety/reports/photo';

afterEach(() => { vi.restoreAllMocks(); });

describe('наблюдения: одна запись не держит очередь', () => {
  it('400 на первой записи не держит вторую: первая отложена с причиной, вторая ушла', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = memoryStore([obs('o1', 'Медведица с медвежатами у ручья'), obs('o2', 'Тропа размыта после дождя')]);
    const net = fakeNet(({ body }) => body.text === 'Медведица с медвежатами у ручья'
      ? json(400, { success: false, error: 'Неверные данные' })
      : json(201, { success: true, data: { id: 'r-2' } }));

    const result = await flushOutbox(TRAIL_OBSERVATIONS, store, net.post);

    expect(result).toEqual({ sent: 1, waiting: 0, rejected: 1 });
    expect(net.calls.map(c => c.url)).toEqual([REPORTS, REPORTS]);
    const left = store.items();
    expect(left.map(i => i.id)).toEqual(['o1']);
    expect(left[0].rejected).toMatchObject({ part: 'record', status: 400, reason: 'Неверные данные' });
    expect(left[0].text).toBe('Медведица с медвежатами у ручья');
  });

  it('422 (мат, координаты вне края) — тоже отказ записи, а не повод ждать', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = memoryStore([obs('o1', 'текст'), obs('o2', 'второе')]);
    const net = fakeNet((_c, n) => n === 1
      ? json(422, { success: false, error: 'Координаты вне Камчатки — наблюдение не сохранено' })
      : json(201, { success: true, data: { id: 'r-2' } }));

    await flushOutbox(TRAIL_OBSERVATIONS, store, net.post);

    expect(store.items()[0].rejected?.reason).toBe('Координаты вне Камчатки — наблюдение не сохранено');
    expect(store.items()).toHaveLength(1);
  });

  it.each([
    ['нет связи', 'network' as const],
    ['503', 503],
    ['429 — лимит приёмника', 429],
    ['401 от шлюза', 401],
    ['404 — выкладка без роута', 404],
  ])('отказ среды (%s) останавливает проход и ничего не теряет', async (_name, reply) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = memoryStore([obs('o1', 'первое'), obs('o2', 'второе')]);
    const net = fakeNet(() => reply === 'network' ? 'network' : json(reply, { success: false, error: 'сбой' }));

    const result = await flushOutbox(TRAIL_OBSERVATIONS, store, net.post);

    expect(result).toEqual({ sent: 0, waiting: 2, rejected: 0 });
    expect(net.calls).toHaveLength(1);
    expect(store.items().map(i => [i.id, i.rejected ?? null])).toEqual([['o1', null], ['o2', null]]);
  });

  it('200 не от нашего сервера (страница входа в Wi-Fi) — запись ждёт, а не считается ушедшей', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = memoryStore([obs('o1', 'первое')]);
    const net = fakeNet(() => new Response('<html>Войдите в сеть гостиницы</html>', { status: 200 }));

    const result = await flushOutbox(TRAIL_OBSERVATIONS, store, net.post);

    expect(result.waiting).toBe(1);
    expect(store.items()[0].rejected ?? null).toBeNull();
  });

  it('отложенная запись больше не шлётся сама — решает человек', async () => {
    const store = memoryStore([{
      ...obs('o1', 'первое'),
      rejected: { part: 'record' as const, status: 400, reason: 'Неверные данные', at: 1 },
    }]);
    const net = fakeNet(() => json(201, { success: true, data: { id: 'r' } }));

    const result = await flushOutbox(TRAIL_OBSERVATIONS, store, net.post);

    expect(net.calls).toHaveLength(0);
    expect(result).toEqual({ sent: 0, waiting: 0, rejected: 1 });
    expect(queueCounts(store.items())).toEqual({ waiting: 0, rejected: 1 });
  });
});

describe('наблюдения: снимки не теряются', () => {
  it('сбой второго снимка не удаляет запись с третьим, а текст второй раз не уходит', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = memoryStore([obs('o1', 'Медведь на тропе', ['p1', 'p2', 'p3'])]);
    let netUp = false;
    const net = fakeNet(({ url, body }) => {
      if (url === REPORTS) return json(201, { success: true, data: { id: 'r-1' } });
      if (!netUp && body.data === 'p2') return 'network';
      return json(200, { success: true, id: `ph-${String(body.data)}` });
    });

    const first = await flushOutbox(TRAIL_OBSERVATIONS, store, net.post);
    expect(first).toEqual({ sent: 0, waiting: 1, rejected: 0 });
    expect(store.items()[0]).toMatchObject({ sentReportId: 'r-1', photos: ['p2', 'p3'] });

    netUp = true;
    const second = await flushOutbox(TRAIL_OBSERVATIONS, store, net.post);
    expect(second).toEqual({ sent: 1, waiting: 0, rejected: 0 });
    expect(store.items()).toHaveLength(0);
    // Текст ушёл один раз, снимки — все три, и все к принятому наблюдению.
    expect(net.calls.filter(c => c.url === REPORTS)).toHaveLength(1);
    const photos = net.calls.filter(c => c.url === REPORT_PHOTO);
    // Первый заход: p1 ушёл, p2 упёрся в сеть, p3 не пробовали. Второй: p2 и p3.
    expect(photos.map(c => c.body.data)).toEqual(['p1', 'p2', 'p2', 'p3']);
    expect(new Set(photos.map(c => c.body.report_id))).toEqual(new Set(['r-1']));
  });

  it('снимок, который сервер не примет (413), не держит остальные и не пропадает молча', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = memoryStore([obs('o1', 'Камнепад', ['big', 'ok'])]);
    const net = fakeNet(({ url, body }) => {
      if (url === REPORTS) return json(201, { success: true, data: { id: 'r-1' } });
      return body.data === 'big'
        ? json(413, { success: false, error: 'Снимок слишком большой — пересжать на телефоне' })
        : json(200, { success: true, id: 'ph' });
    });

    const result = await flushOutbox(TRAIL_OBSERVATIONS, store, net.post);

    expect(result).toEqual({ sent: 0, waiting: 0, rejected: 1 });
    expect(net.calls.filter(c => c.url === REPORT_PHOTO).map(c => c.body.data)).toEqual(['big', 'ok']);
    expect(store.items()[0]).toMatchObject({
      sentReportId: 'r-1',
      photos: ['big'],
      rejected: { part: 'photo', status: 413, reason: 'Снимок слишком большой — пересжать на телефоне' },
    });
  });
});

describe('полевые проверки: то же правило', () => {
  it('400 на первой проверке не держит вторую', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = memoryStore([check('c1', { targetId: null }), check('c2')]);
    const net = fakeNet(({ body }) => body.target_id === null
      ? json(400, { success: false, error: 'Не указано, какую запись проверяли' })
      : json(200, { success: true, id: 'chk-2' }));

    const result = await flushOutbox(FIELD_CHECKS, store, net.post);

    expect(result).toEqual({ sent: 1, waiting: 0, rejected: 1 });
    expect(store.items().map(i => [i.id, i.rejected?.reason])).toEqual([['c1', 'Не указано, какую запись проверяли']]);
  });

  it('вердикт уходит один раз, недовезённый снимок ждёт следующего захода', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = memoryStore([check('c1', { photos: ['a', 'b'] })]);
    let up = false;
    const net = fakeNet(({ url, body }) => {
      if (url === '/api/field-check/report') return json(200, { success: true, id: 'chk-1' });
      if (!up && body.data === 'b') return json(502, { success: false, error: 'хранилище недоступно' });
      return json(200, { success: true, id: 'ph' });
    });

    await flushOutbox(FIELD_CHECKS, store, net.post);
    expect(store.items()[0]).toMatchObject({ sentCheckId: 'chk-1', photos: ['b'] });

    up = true;
    await flushOutbox(FIELD_CHECKS, store, net.post);
    expect(store.items()).toHaveLength(0);
    expect(net.calls.filter(c => c.url === '/api/field-check/report')).toHaveLength(1);
    expect(net.calls.filter(c => c.url === '/api/field-check/photo').map(c => c.body.check_id))
      .toEqual(['chk-1', 'chk-1', 'chk-1']);
  });

  it('находка уходит без id записи и с именем — как ждёт приёмник', async () => {
    const store = memoryStore([check('c1', { targetKind: 'new', targetId: null, proposedName: 'брод' })]);
    const net = fakeNet(() => json(200, { success: true, id: 'chk' }));

    await flushOutbox(FIELD_CHECKS, store, net.post);

    expect(net.calls[0].body).toMatchObject({ target_kind: 'new', target_id: null, proposed_name: 'брод' });
  });
});

describe('след отказа', () => {
  it('отказ пишется в лог: имя очереди, код и слова сервера — без текста записи', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = memoryStore([obs('o1', 'Иван Петров, телефон для связи')]);
    const net = fakeNet(() => json(400, { success: false, error: 'Неверные данные' }));

    await flushOutbox(TRAIL_OBSERVATIONS, store, net.post);

    const logged = spy.mock.calls.map(args => args.join(' ')).join('\n');
    expect(logged).toMatch(/\[очередь: наблюдения\].*код 400.*Неверные данные/);
    expect(logged).not.toContain('Иван Петров');
  });
});

describe('проходы не наслаиваются', () => {
  it('два досыла подряд шлют запись один раз', async () => {
    const store = memoryStore([obs('o1', 'первое')]);
    const net = fakeNet(async () => {
      await new Promise(r => setTimeout(r, 5));
      return json(201, { success: true, data: { id: 'r-1' } });
    });
    const flush = serialized(() => flushOutbox(TRAIL_OBSERVATIONS, store, net.post));

    await Promise.all([flush(), flush()]);

    expect(net.calls).toHaveLength(1);
    expect(store.items()).toHaveLength(0);
  });
});

describe('какой отказ — от записи, а какой — от среды', () => {
  it.each([400, 409, 413, 422])('%i — отказ записи', (status) => {
    expect(isRecordRefusal(status)).toBe(true);
  });
  it.each([401, 403, 404, 405, 408, 429, 500, 502, 503])('%i — отказ среды', (status) => {
    expect(isRecordRefusal(status)).toBe(false);
  });
});

describe('общий движок без привязки к очереди', () => {
  it('запись без снимков удаляется, только когда приёмник принял её', async () => {
    const spec: OutboxSpec<OutboxRecord & { v: string }> = {
      name: 'проба', recordUrl: '/r', recordPayload: i => ({ v: i.v }), recordId: () => 'x',
      photoUrl: '/p', photoPayload: () => ({}), sentId: () => null, withSentId: i => i,
    };
    const store = memoryStore([{ id: 'a', photos: [], v: '1' }]);
    const net = fakeNet(() => json(200, { success: true }));
    expect(await flushOutbox(spec, store, net.post)).toEqual({ sent: 1, waiting: 0, rejected: 0 });
    expect(store.items()).toHaveLength(0);
  });
});
