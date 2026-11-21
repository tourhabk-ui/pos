/**
 * Мелкие правки по проверке 21.11 (пост Reddit «I checked my own vibe coded app»):
 *  - ссылка привязки Telegram без секрета не выдаётся и не проверяется
 *    (запасного 'dev-connect-secret' больше нет);
 *  - мёртвый /api/auth/demo удалён;
 *  - long-polling MAX (GET /api/max/kuzmich) — только с CRON_SECRET.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); });

describe('connect-token: fail-closed без секрета', () => {
  it('в коде нет запасного ключа', () => {
    expect(read('lib/telegram/connect-token.ts')).not.toMatch(/dev-connect-secret/);
  });

  it('без секрета ссылка не выдаётся, токен не проверяется', async () => {
    vi.stubEnv('CONNECT_TOKEN_SECRET', '');
    vi.stubEnv('JWT_SECRET', '');
    const { generateConnectToken, verifyConnectToken } = await import('@/lib/telegram/connect-token');
    expect(() => generateConnectToken('u-1')).toThrow(/Секрет подписи не задан/);
    expect(verifyConnectToken('dTotMToxOTk5OTk5OTk5OTk5OQ.0123456789abcdef')).toBeNull();
  });

  it('пустая CONNECT_TOKEN_SECRET не становится ключом — берётся JWT_SECRET', async () => {
    vi.stubEnv('CONNECT_TOKEN_SECRET', '');
    vi.stubEnv('JWT_SECRET', 'jwt-secret-long-enough-0123456789');
    const { generateConnectToken, verifyConnectToken } = await import('@/lib/telegram/connect-token');
    const t = generateConnectToken('u-1');
    expect(verifyConnectToken(t)).toBe('u-1');
    vi.stubEnv('JWT_SECRET', 'other-secret-long-enough-0123456789');
    expect(verifyConnectToken(t)).toBeNull();
  });
});

describe('мёртвый демо-вход удалён', () => {
  it('файла роута нет', () => {
    expect(existsSync(join(process.cwd(), 'app/api/auth/demo/route.ts'))).toBe(false);
  });
});

describe('MAX: long-polling только с CRON_SECRET, без ключа подписки — fail-closed', () => {
  const route = read('app/api/max/kuzmich/route.ts');

  it('GET проверяет CRON_SECRET до любого обращения к MAX', () => {
    const get = route.slice(route.indexOf('export async function GET'));
    expect(get.indexOf('verifyCronSecret(request)')).toBeGreaterThan(0);
    expect(get.indexOf('verifyCronSecret(request)')).toBeLessThan(get.indexOf('getApi()'));
  });

  it('открытого ответчика без ключа больше нет', () => {
    expect(route).toMatch(/MAX_WEBHOOK_SECRET не задан — апдейт без ключа не обработан \(fail-closed/);
    expect(route).not.toMatch(/пачка из \$\{updates\.length\} апдейтов без ключа подписки/);
  });
});
