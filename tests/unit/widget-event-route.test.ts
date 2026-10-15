/**
 * Маяк открытия виджета POST /api/widget/event (аудит 15.10, находка
 * WID-measure, W6) — вызовом роута.
 *
 * Держит:
 *  - вход проверяется строгой схемой: только партнёр, род, хост и kind=open;
 *    лишний ключ (телефон, путь, текст) — 400, и в базу не идёт ничего;
 *  - в запрос записи уходят ровно slug, хост и род — без IP, UA и пути;
 *  - запись не ждётся и ответ не роняет: при отказе базы маяк отвечает 204,
 *    а отказ — в лог с SQLSTATE (§4.0);
 *  - боты не считаются; частота ограничена.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { poolQuery } = vi.hoisted(() => ({ poolQuery: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: poolQuery } }));

import { POST } from '@/app/api/widget/event/route';
import { WIDGET_OPENED_SQL } from '@/lib/embed/widget-telemetry';

const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/129.0 Safari/537.36';

let ipSeq = 0;
function beacon(body: unknown, opts: { ip?: string; ua?: string } = {}) {
  ipSeq += 1;
  return POST(new NextRequest('https://vedarai.ru/api/widget/event', {
    method: 'POST',
    headers: {
      'content-type': 'text/plain;charset=UTF-8',
      'x-real-ip': opts.ip ?? `10.7.0.${ipSeq}`,
      'user-agent': opts.ua ?? BROWSER,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }));
}

const writes = () => poolQuery.mock.calls.filter((c) => /INSERT/i.test(String(c[0])));

beforeEach(() => {
  poolQuery.mockReset();
  poolQuery.mockResolvedValue({ rows: [], rowCount: 1 });
});

describe('маяк открытия: что пишется', () => {
  it('открытие чата: 204 и +1 по slug, хосту и роду — больше ничего', async () => {
    const res = await beacon({ partner: 'mestechko', kind: 'open', widget: 'chat', host: 'WWW.Mestechkokam.ru' });
    expect(res.status).toBe(204);
    await vi.waitFor(() => expect(writes()).toHaveLength(1));
    const [sql, params] = writes()[0];
    expect(sql).toBe(WIDGET_OPENED_SQL);
    expect(params).toEqual(['mestechko', 'www.mestechkokam.ru', 'chat']);
  });

  it('хост не прислан — открытие считается с хостом null', async () => {
    const res = await beacon({ partner: 'fishingkam', kind: 'open', widget: 'form' });
    expect(res.status).toBe(204);
    await vi.waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0][1]).toEqual(['fishingkam', null, 'form']);
  });

  it('хост — не имя хоста (почта, схема) — пишется null, а не строка', async () => {
    await beacon({ partner: 'fishingkam', kind: 'open', widget: 'form', host: 'ivan@mail.ru' });
    await vi.waitFor(() => expect(writes()).toHaveLength(1));
    expect(writes()[0][1]).toEqual(['fishingkam', null, 'form']);
  });
});

describe('маяк открытия: вход', () => {
  const invalid: Array<[string, unknown]> = [
    ['лишний ключ с телефоном', { partner: 'mestechko', kind: 'open', widget: 'chat', host: 'a.ru', phone: '+79001234567' }],
    ['лишний ключ с путём страницы', { partner: 'mestechko', kind: 'open', widget: 'chat', host: 'a.ru', path: '/tury/' }],
    ['не тот kind', { partner: 'mestechko', kind: 'view', widget: 'chat' }],
    ['не тот род виджета', { partner: 'mestechko', kind: 'open', widget: 'banner' }],
    ['slug с пробелом', { partner: 'mestechko kam', kind: 'open', widget: 'chat' }],
    ['slug пустой', { partner: '', kind: 'open', widget: 'chat' }],
    ['не JSON', 'partner=mestechko'],
    ['слишком длинное тело', { partner: 'mestechko', kind: 'open', widget: 'chat', host: 'a'.repeat(2000) }],
  ];
  for (const [name, body] of invalid) {
    it(`${name} — 400, в базу ничего`, async () => {
      const res = await beacon(body);
      expect(res.status).toBe(400);
      await new Promise((r) => setTimeout(r, 0));
      expect(poolQuery).not.toHaveBeenCalled();
    });
  }

  it('бот — 204, но не считается', async () => {
    const res = await beacon({ partner: 'mestechko', kind: 'open', widget: 'chat' }, { ua: 'Mozilla/5.0 (compatible; Googlebot/2.1)' });
    expect(res.status).toBe(204);
    await new Promise((r) => setTimeout(r, 0));
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('частота ограничена: с одного адреса больше 30 в минуту — 429', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) {
      statuses.push((await beacon({ partner: 'mestechko', kind: 'open', widget: 'chat' }, { ip: '10.8.8.8' })).status);
    }
    expect(statuses.slice(0, 30).every((s) => s === 204)).toBe(true);
    expect(statuses[30]).toBe(429);
  });
});

describe('маяк открытия: отказ записи', () => {
  it('база зависла — маяк отвечает, не дожидаясь записи', async () => {
    poolQuery.mockImplementation(() => new Promise(() => undefined));
    const res = await Promise.race([
      beacon({ partner: 'mestechko', kind: 'open', widget: 'chat', host: 'mestechkokam.ru' }),
      new Promise<'ждёт базу'>((r) => setTimeout(() => r('ждёт базу'), 300)),
    ]);
    expect(res).not.toBe('ждёт базу');
    expect((res as Response).status).toBe(204);
  });

  it('база отказала — маяк всё равно 204, отказ в логе с SQLSTATE', async () => {
    poolQuery.mockRejectedValue(Object.assign(new Error('relation "widget_daily" does not exist'), { code: '42P01' }));
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await beacon({ partner: 'mestechko', kind: 'open', widget: 'form', host: 'mestechkokam.ru' });
    expect(res.status).toBe(204);
    await vi.waitFor(() => expect(err.mock.calls.flat().join(' ')).toMatch(/SQLSTATE=42P01/));
    err.mockRestore();
  });
});
