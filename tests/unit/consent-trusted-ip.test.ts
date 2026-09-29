/**
 * Адрес в записи согласия на ПД — только доверенный (сверка MCP 29.09).
 *
 * `buildConsentRecord` кладёт IP в доказательство согласия, и тот же адрес у
 * этих роутов держит лимит публичной записи. Первый элемент X-Forwarded-For
 * пишет сам клиент: скрипт, меняющий его с каждым запросом, обходил лимит
 * (у MCP — 5 заявок за 10 минут, единственный тормоз спама менеджерам) и
 * подделывал адрес в согласии. Доверенный порядок — `getTrustedClientIp`
 * (lib/rate-limit.ts): x-real-ip от прокси, затем cf-connecting-ip, и только
 * потом XFF.
 *
 * Сторож держит связку целиком: всякий файл, собирающий запись согласия,
 * обязан брать адрес доверенным способом — и новый такой роут попадает под
 * правило сам, без списка.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules') continue;
      walk(p, acc);
    } else if (/\.(ts|tsx)$/.test(name)) acc.push(p);
  }
  return acc;
}

const code = (p: string) => readFileSync(p, 'utf-8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

const CONSENT_WRITERS = [...walk(join(ROOT, 'app')), ...walk(join(ROOT, 'lib'))]
  .filter((f) => !f.endsWith('lib/legal/pd-consent.ts'))
  .filter((f) => /buildConsentRecord\(/.test(code(f)));

describe('запись согласия на ПД берёт доверенный IP', () => {
  it('роуты, собирающие согласие, найдены по коду', () => {
    const rel = CONSENT_WRITERS.map((f) => relative(ROOT, f));
    expect(rel).toEqual(expect.arrayContaining([
      'app/api/mcp/route.ts',
      'app/api/leads/route.ts',
      'app/api/hub/bookings/create/route.ts',
      'app/api/seat-requests/route.ts',
    ]));
  });

  for (const f of CONSENT_WRITERS) {
    it(relative(ROOT, f), () => {
      const src = code(f);
      expect(src).toMatch(/getTrustedClientIp\(/);
      expect(src, 'getClientIp берёт первый элемент XFF — его пишет клиент').not.toMatch(/\bgetClientIp\(/);
      expect(src, 'сырой X-Forwarded-For вместо доверенного порядка').not.toMatch(/x-forwarded-for['"]\)\?\.split/i);
    });
  }
});
