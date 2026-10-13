// @vitest-environment node
/**
 * Журнал видит клиентов РФ (владелец 13.10: «остались российские ИИ»).
 *
 * Тот же механизм, что у реестра КНР (mcp-china-clients.test.ts):
 * самоназвание программы по границе слова, метка «РФ» в срезах админки, своя
 * группа в переписи mcp-census. Проверяется поведение: род по заголовку,
 * регион по имени, срез и перепись — вызовом функций с подменённым пулом.
 * Отрисовка метки — tests/unit/admin-ru-badge.test.tsx.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { uaFamily } from '@/lib/mcp/client-id';
import { ruClientFamily, RU_CLIENT_FAMILIES, RU_REGION_LABEL } from '@/lib/mcp/ru-clients';
import { chinaClientFamily, clientRegion, CHINA_CLIENT_FAMILIES, CHINA_REGION_LABEL } from '@/lib/mcp/china-clients';

type Row = Record<string, unknown>;
type Answer = (sql: string, params: unknown[]) => Row[];

function mockPool(answer: Answer) {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => ({ rows: answer(sql, params) }));
  vi.resetModules();
  vi.doMock('@/lib/db-pool', () => ({ pool: { query } }));
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock('@/lib/db-pool');
  vi.doUnmock('@/lib/auth/middleware');
});

describe('род клиента по заголовку знает продукты РФ', () => {
  it.each([
    ['YandexGPT-Agent/1.0', 'yandex-ai'],
    ['yandex-cloud-mcp-gateway/0.1 (serverless)', 'yandex-ai'],
    ['GigaChat/2.0 python-httpx/0.27', 'gigachat'],
    ['gigachain-agent/0.3', 'gigachat'],
    ['Cotype-Agent/1.0', 'mts-ai'],
    ['t-pro-agent/1', 't-bank-ai'],
    ['vk-cloud-ml/1.0', 'vk-ai'],
  ])('%s → %s', (ua, family) => {
    expect(uaFamily(ua)).toBe(family);
    expect(RU_CLIENT_FAMILIES.map((f) => f.family)).toContain(family);
  });

  it('самоназвание кириллицей тоже опознаётся по границе слова', () => {
    expect(ruClientFamily('Алиса/1.0')).toBe('yandex-ai');
    expect(ruClientFamily('полиса-бот/1.0')).toBeNull();
  });

  it('обходчик YandexBot — не клиент ИИ: «yandexbot» не проходит границу слова', () => {
    const bot = 'Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)';
    expect(ruClientFamily(bot)).toBeNull();
    expect(uaFamily(bot)).toBe('браузер');
    expect(ruClientFamily('salesforce-agent/1')).toBeNull();
    // Адрес в заголовке — не самоназвание, в обоих реестрах.
    expect(chinaClientFamily('Mozilla/5.0 (compatible; DeepSeekBot/1.0; +https://www.deepseek.com/bot)')).toBeNull();
    expect(chinaClientFamily('dsh-mcp-client/0.2.0 (+https://github.com/deepseek-ai/deepseek-harness)')).toBe('deepseek');
    expect(ruClientFamily('tbank-ai/2')).toBe('t-bank-ai');
  });

  it('прежние роды не сдвинулись', () => {
    expect(uaFamily('Claude-User/1.0')).toBe('claude');
    expect(uaFamily('QwenCode/0.3.1 (node)')).toBe('qwen-code');
    expect(uaFamily('curl/8.4.0')).toBe('curl');
  });

  it('маркеры реестров РФ и КНР не пересекаются: один клиент — один регион', () => {
    for (const f of RU_CLIENT_FAMILIES) for (const m of f.markers) expect(chinaClientFamily(m), m).toBeNull();
    for (const f of CHINA_CLIENT_FAMILIES) for (const m of f.markers) expect(ruClientFamily(m), m).toBeNull();
  });
});

describe('метка региона — по самоназванию, не по стране', () => {
  it('клиент РФ → «РФ», КНР по-прежнему «КНР», прочие — null', () => {
    expect(clientRegion('yandex-ai')).toBe(RU_REGION_LABEL);
    expect(clientRegion('GigaChat', 'python')).toBe(RU_REGION_LABEL);
    expect(clientRegion(null, 'gigachat')).toBe(RU_REGION_LABEL);
    // Имя клиента, которое не совпадает с родом буква в букву, — через самоназвание.
    expect(clientRegion('YandexGPT-Agent/1.0', 'неизвестен')).toBe(RU_REGION_LABEL);
    expect(clientRegion('yandex-cloud-mcp-gateway')).toBe(RU_REGION_LABEL);
    expect(clientRegion('Qwen Code')).toBe(CHINA_REGION_LABEL);
    expect(clientRegion('claude-ai', 'claude')).toBeNull();
    expect(RU_REGION_LABEL).not.toBe(CHINA_REGION_LABEL);
  });
});

describe('срезы админки и перепись несут метку РФ', () => {
  it('/api/admin/analytics/mcp: «Кто звал» помечает GigaChat меткой РФ, Qwen Code — КНР', async () => {
    mockPool((sql) => {
      if (/AS client,/.test(sql) && /GROUP BY 1, 2, 3/.test(sql)) {
        return [
          { client: 'GigaChat', kind: 'представился', origin: 'external', calls: '4', caller_days: '1', last_seen: '2026-10-13 11:00' },
          { client: 'Qwen Code', kind: 'представился', origin: 'external', calls: '5', caller_days: '2', last_seen: '2026-10-13 10:00' },
          { client: 'claude', kind: 'представился', origin: 'external', calls: '313', caller_days: '40', last_seen: '2026-10-13 09:00' },
        ];
      }
      if (/AS external,/.test(sql)) return [{ external: '322', self: '0', probe: '0', self_since: null, refused_since: null }];
      return [];
    });
    vi.doMock('@/lib/auth/middleware', () => ({ requireAdmin: async () => ({ id: 'admin' }) }));
    const { GET } = await import('@/app/api/admin/analytics/mcp/route');
    const res = await GET(new NextRequest('https://vedarai.ru/api/admin/analytics/mcp'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.by_client_30d.map((c: { client: string; region: string | null }) => [c.client, c.region]))
      .toEqual([['GigaChat', 'РФ'], ['Qwen Code', 'КНР'], ['claude', null]]);
  });

  it('mcp-census: clients_ru — своя группа; в clients_china клиентов РФ нет', async () => {
    mockPool((sql) => {
      if (/AS client,/.test(sql) && !/NOT t\.ok/.test(sql)) {
        return [
          { client: 'claude', origin: 'external', calls: '313', caller_days: '40', last_seen: '2026-10-13' },
          { client: 'Qwen Code', origin: 'external', calls: '5', caller_days: '2', last_seen: '2026-10-13' },
          { client: 'yandex-cloud-mcp-gateway', origin: 'external', calls: '4', caller_days: '1', last_seen: '2026-10-13' },
        ];
      }
      if (/AS self_since/.test(sql)) return [{ self_since: null, code_since: null, refused_since: null, rows_total: '322', rows_without_code: '0' }];
      return [];
    });
    vi.stubEnv('CRON_SECRET', 'cron-test');
    const { GET } = await import('@/app/api/cron/mcp-census/route');
    const res = await GET(new NextRequest('https://vedarai.ru/api/cron/mcp-census?days=1', { headers: { Authorization: 'Bearer cron-test' } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.clients_ru).toEqual({ clients: 1, calls: 4, names: ['yandex-cloud-mcp-gateway (external, 4)'] });
    expect(body.clients_china).toEqual({ clients: 1, calls: 5, names: ['Qwen Code (external, 5)'] });
  });
});
