/**
 * createLead() — вход во ВСЮ воронку продаж: сайт, Telegram, MAX, виджет, MCP.
 * Все семь точек входа зовут одну функцию (lib/leads/create.ts).
 *
 * До 24.08 все три catch внутри были пусты: сбой дедупа, сбой атрибуции
 * оператора и сбой самого INSERT возвращались как обычный «не нашли»/`null`,
 * без единой строки в лог. Тот же класс дефекта уже стоил `funnel_events` и
 * `operator_commissions` всех записей за долгое время — там тоже сбой БД
 * выглядел снаружи как «событий нет» вместо «проверить не смогли» (§4.0).
 *
 * Поведение по контракту не менялось (`null` при неудаче INSERT, тихий
 * пропуск при неудаче дедупа/атрибуции) — только видимость причины.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const poolQueryMock = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => poolQueryMock(...args) },
}));

vi.mock('@/lib/notifications/telegram-channel', () => ({
  notifyAdminNewLead: vi.fn().mockResolvedValue(undefined),
}));

import { createLead } from '@/lib/leads/create';

const BASE_PARAMS = { name: 'Турист', phone: '+79990000000', comment: 'Хочу тур' };

describe('createLead: INSERT падает — причина видна, не проглатывается', () => {
  beforeEach(() => {
    poolQueryMock.mockReset();
  });

  it('возвращает null (контракт не изменился)', async () => {
    poolQueryMock.mockRejectedValueOnce(Object.assign(new Error('relation "leads" does not exist'), { code: '42P01' }));
    const id = await createLead(BASE_PARAMS);
    expect(id).toBeNull();
  });

  it('пишет в лог SQLSTATE и текст ошибки — не молчит', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    poolQueryMock.mockRejectedValueOnce(Object.assign(new Error('relation "leads" does not exist'), { code: '42P01' }));

    await createLead(BASE_PARAMS);

    expect(spy).toHaveBeenCalled();
    const logged = spy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toMatch(/INSERT не выполнился/);
    expect(logged).toMatch(/42P01/);
    expect(logged).toMatch(/relation "leads" does not exist/);
    spy.mockRestore();
  });
});

describe('createLead: дедуп недоступен — лид всё равно создаётся, отказ назван', () => {
  beforeEach(() => {
    poolQueryMock.mockReset();
  });

  it('падение проверки дубля не блокирует создание лида', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    poolQueryMock
      .mockRejectedValueOnce(Object.assign(new Error('connection timeout'), { code: '08006' })) // дедуп
      .mockResolvedValueOnce({ rows: [{ id: 'lead-1' }] }); // INSERT

    const id = await createLead(BASE_PARAMS);

    expect(id).toBe('lead-1');
    const logged = spy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toMatch(/проверка дубля не выполнилась/);
    expect(logged).toMatch(/08006/);
    spy.mockRestore();
  });
});

describe('createLead: атрибуция оператора недоступна — лид создаётся без оператора, отказ назван', () => {
  beforeEach(() => {
    poolQueryMock.mockReset();
  });

  it('падение атрибуции не блокирует создание лида', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    poolQueryMock
      .mockResolvedValueOnce({ rows: [] }) // дедуп: без телефона/комментария не звался бы — здесь звался, дубля нет
      .mockRejectedValueOnce(Object.assign(new Error('column "route_id" does not exist'), { code: '42703' })) // атрибуция
      .mockResolvedValueOnce({ rows: [{ id: 'lead-2' }] }); // INSERT

    const id = await createLead({ ...BASE_PARAMS, route_id: 'route-1' });

    expect(id).toBe('lead-2');
    const logged = spy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toMatch(/атрибуция оператора не выполнилась/);
    expect(logged).toMatch(/route_id=route-1/);
    expect(logged).toMatch(/42703/);
    spy.mockRestore();
  });
});

describe('createLead: успешный путь не логирует ошибок', () => {
  beforeEach(() => {
    poolQueryMock.mockReset();
  });

  it('без телефона+комментария дедуп пропускается, а не падает', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    poolQueryMock.mockResolvedValueOnce({ rows: [{ id: 'lead-3' }] }); // только INSERT

    const id = await createLead({ name: 'Турист' });

    expect(id).toBe('lead-3');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
