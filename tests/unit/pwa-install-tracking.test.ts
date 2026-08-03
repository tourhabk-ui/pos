/**
 * Учёт установок PWA: раньше платформа не считала, сколько раз приложение
 * поставили на телефон. Теперь считаем устройства (дедуп по анонимному
 * client_id), два честных сигнала (appinstalled + standalone-launch), и число
 * видно в админ-дашборде. Сторож фиксирует контракт: анонимный upsert по
 * client_id, отсутствие ПД, трекер смонтирован, дашборд отдаёт метрику.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const poolQueryMock = vi.fn<(sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>>();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (sql: string, params?: unknown[]) => poolQueryMock(sql, params) },
}));

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

async function post(body: unknown) {
  const { POST } = await import('@/app/api/pwa/install/route');
  return POST(new Request('https://vedarai.ru/api/pwa/install', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as Parameters<typeof POST>[0]);
}

beforeEach(() => poolQueryMock.mockReset());

describe('POST /api/pwa/install', () => {
  it('пишет upsert по client_id (одно устройство — одна строка)', async () => {
    poolQueryMock.mockResolvedValue({ rows: [] });
    const res = await post({ clientId: 'abc12345-uuid', platform: 'android', source: 'appinstalled' });
    expect(res.status).toBe(200);
    const [sql, params] = poolQueryMock.mock.calls[0];
    expect(sql).toContain('INSERT INTO pwa_installs');
    expect(sql).toContain('ON CONFLICT (client_id) DO UPDATE');
    expect(params).toEqual(['abc12345-uuid', 'android', 'appinstalled']);
  });

  it('отклоняет мусорный/короткий clientId (400), БД не трогает', async () => {
    const res = await post({ clientId: 'x' });
    expect(res.status).toBe(400);
    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it('appinstalled — более сильный сигнал, чем standalone-launch', () => {
    const src = read('app/api/pwa/install/route.ts');
    expect(src).toMatch(/EXCLUDED\.install_source = 'appinstalled' THEN 'appinstalled'/);
  });
});

describe('трекер и дашборд', () => {
  it('трекер шлёт client_id без ПД (только uuid, platform, source)', () => {
    const src = read('components/PWA/InstallTracker.tsx');
    expect(src).toContain('appinstalled');
    expect(src).toContain('standalone-launch');
    expect(src).toContain('crypto.randomUUID');
    // никаких персональных полей в теле
    expect(src).not.toMatch(/\bemail\b|\bphone\b|\.name\b/);
  });

  it('трекер смонтирован в корневом layout', () => {
    const layout = read('app/layout.tsx');
    expect(layout).toContain('<InstallTracker');
  });

  it('админ-дашборд отдаёт метрику pwaInstalls', () => {
    const route = read('app/api/admin/dashboard/route.ts');
    expect(route).toContain('FROM pwa_installs');
    expect(route).toContain('pwaInstalls:');
  });
});
