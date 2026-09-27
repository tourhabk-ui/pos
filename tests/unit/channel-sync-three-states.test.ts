/**
 * channel-sync: «не настроен», «опрос упал» и «заказов нет» — три разных
 * ответа, а не один ноль (§4.0, 26.09).
 *
 * До этого дня адаптер Авито на отсутствие ключей, на HTTP-ошибку и на
 * исключение одинаково возвращал [] — крон каждые полчаса честно рапортовал
 * «0 новых заказов», хотя не спрашивал площадку ни разу.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

import { syncAllChannels } from '@/lib/channels/channel-manager';
import { avitoAdapter } from '@/lib/channels/avito';
import { tripsterAdapter } from '@/lib/channels/tripster';

const KEYS = ['TRIPSTER_TOKEN', 'TRIPSTER_PARTNER_NAME', 'AVITO_USER_ID', 'AVITO_CLIENT_ID', 'AVITO_CLIENT_SECRET'];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  vi.restoreAllMocks();
});

describe('channel-sync: три исхода на канал', () => {
  it('без ключей — not_configured, а не synced с нулём', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const res = await syncAllChannels();
    expect(res.map(r => [r.channel, r.state])).toEqual([['tripster', 'not_configured'], ['avito', 'not_configured']]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('ключи есть, площадка ответила ошибкой — failed с причиной', async () => {
    process.env.TRIPSTER_TOKEN = 't'; process.env.TRIPSTER_PARTNER_NAME = 'p';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 503 }));
    const [tripster] = await syncAllChannels();
    expect(tripster.state).toBe('failed');
    expect(tripster.errors.join(' ')).toContain('HTTP 503');
  });

  it('ключи есть, заказов нет — synced с нулём', async () => {
    process.env.TRIPSTER_TOKEN = 't'; process.env.TRIPSTER_PARTNER_NAME = 'p';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ results: [] }), { status: 200 }));
    const [tripster] = await syncAllChannels();
    expect(tripster).toMatchObject({ state: 'synced', new_orders: 0, errors: [] });
  });

  it('Авито не глушит отказ: pollOrders бросает, а не отдаёт []', async () => {
    process.env.AVITO_USER_ID = 'u';
    await expect(avitoAdapter.pollOrders(new Date())).rejects.toThrow();
  });

  it('настроенность — по всем ключам канала', () => {
    process.env.AVITO_USER_ID = 'u'; process.env.AVITO_CLIENT_ID = 'c';
    expect(avitoAdapter.isConfigured()).toBe(false);
    process.env.AVITO_CLIENT_SECRET = 's';
    expect(avitoAdapter.isConfigured()).toBe(true);
    expect(tripsterAdapter.isConfigured()).toBe(false);
  });
});
