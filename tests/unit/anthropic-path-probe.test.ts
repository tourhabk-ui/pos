// @vitest-environment node
/**
 * Проба сетевого пути прод → Anthropic (03.09).
 *
 * Сторож держит: белый список хостов (проба с секретом прода не должна
 * становиться прокси на что угодно); три исхода на путь — «дошли»,
 * «не пустили», «не смог» — и 401 считается ОТКРЫТЫМ путём, потому что до
 * Anthropic дошли; секрет только заголовком; роут зовётся workflow, а не
 * объявлен ручным вторым ответом.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isAllowedBase, classify } from '@/app/api/cron/anthropic-path-probe/route';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const ROUTE = read('app/api/cron/anthropic-path-probe/route.ts');
const WF = read('.github/workflows/anthropic-path-probe.yml');

describe('белый список хостов', () => {
  it('пускает Anthropic, AI Gateway и воркеры Cloudflare', () => {
    expect(isAllowedBase('https://api.anthropic.com')).toBe(true);
    expect(isAllowedBase('https://gateway.ai.cloudflare.com/v1/acc/vedar-ai/anthropic')).toBe(true);
    expect(isAllowedBase('https://vedar-ai-relay.tourhab.workers.dev/anthropic')).toBe(true);
  });

  it('режет чужие хосты, http и мусор', () => {
    expect(isAllowedBase('https://evil.example.com/v1')).toBe(false);
    expect(isAllowedBase('http://api.anthropic.com')).toBe(false);
    expect(isAllowedBase('https://api.anthropic.com.evil.io')).toBe(false);
    expect(isAllowedBase('not a url')).toBe(false);
  });
});

describe('три исхода на путь', () => {
  it('200 — открыт; 401 — открыт без ключа; 403 — заблокирован; прочее — http', () => {
    expect(classify(200, '')).toBe('open');
    expect(classify(401, '{"type":"error","error":{"type":"authentication_error"}}')).toBe('open_no_key');
    expect(classify(403, 'Request not allowed')).toBe('blocked');
    expect(classify(500, '')).toBe('http');
  });

  it('сетевой отказ — «не смог», а не «заблокирован»; без ключа проба всё равно идёт', () => {
    expect(ROUTE).toMatch(/outcome: 'unreachable'/);
    expect(ROUTE).toMatch(/'x-api-key': apiKey \?\? 'absent'/);
    // Все «не смог» → path_exists null, не false.
    expect(ROUTE).toMatch(/path_exists: open\.length > 0 \? true : results\.every/);
  });
});

describe('периметр и запуск', () => {
  it('секрет — заголовком, сравнение постоянного времени', () => {
    expect(ROUTE).toMatch(/getCronSecret\(request\)/);
    expect(ROUTE).toMatch(/timingSafeCompare/);
    expect(WF).toMatch(/Authorization: Bearer \$CRON_SECRET/);
    expect(WF).not.toMatch(/\?secret=/);
  });

  it('workflow зовёт роут и краснеет, когда ни один путь не открыт', () => {
    expect(WF).toMatch(/\/api\/cron\/anthropic-path-probe/);
    expect(WF).toMatch(/AI Gateway гео-блок не обходит/);
    // Раннер не в РФ: его успех — контроль шлюза, а не ответ про гео-путь.
    expect(WF).toMatch(/контроль самого шлюза/);
  });

  it('ключи и аккаунт наружу не печатаются', () => {
    expect(WF).toMatch(/add-mask::\$ACCOUNT/);
    expect(WF).not.toMatch(/echo .*\$ANTHROPIC_API_KEY/);
    expect(WF).not.toMatch(/echo .*\$CLOUDFLARE_API_TOKEN/);
  });
});
