/**
 * Файл подтверждения Яндекс Дзена отдаётся как есть (27.11).
 *
 * Дзен подтверждает права на сайт, читая https://vedarai.ru/zen_<код>.html:
 * код 200 и ровно та строка, что выдала форма («<meta name="zen-verification" … />»).
 * Файл лежит в public/, Next отдаёт его статикой. Что может его сломать: правка
 * содержимого (лишний перевод строки), редирект или rewrite раньше файла,
 * Disallow в robots.txt. Middleware корневые html не перехватывает: matcher
 * держит только /api, /hub, /profile, /widget, /routes, /en, /zh.
 * Всё это судится здесь — вызовом правил, а не по тексту.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'user-agent': 'Googlebot' }) }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

const CODE = 'QJsdvPGmQ0KLDTNxh4xe2d6OzyLCH0SLSW9RI5YDvLvxi2rlTxLm8veinv9x533P';
const NAME = `zen_${CODE}.html`;
const PATH = `/${NAME}`;
const EXPECTED = `<meta name="zen-verification" content="${CODE}" />`;

const { match } = require('next/dist/compiled/path-to-regexp') as {
  match: (src: string) => (path: string) => unknown;
};
const config = require(join(process.cwd(), 'next.config.js')) as {
  redirects: () => Promise<Array<{ source: string; has?: unknown[] }>>;
  rewrites: () => Promise<{
    beforeFiles?: Array<{ source: string; has?: unknown[] }>;
    afterFiles?: Array<{ source: string; has?: unknown[] }>;
  }>;
};

describe('файл подтверждения Дзена', () => {
  it('лежит в public/ байт в байт, как его выдала форма', () => {
    const body = readFileSync(join(process.cwd(), 'public', NAME), 'utf8');
    expect(body).toBe(EXPECTED);
  });

  it('ни редирект, ни rewrite не перехватывают адрес на vedarai.ru', async () => {
    // Правила с условием `has` срабатывают только на чужом хосте
    // (tourhab.ru, www, сайты партнёров) — запрос к vedarai.ru их не задевает.
    const unconditional = (rules: Array<{ source: string; has?: unknown[] }>) =>
      rules.filter((r) => !r.has || r.has.length === 0);
    const redirects = unconditional(await config.redirects());
    const rewrites = await config.rewrites();
    const before = unconditional(rewrites.beforeFiles ?? []);
    const after = unconditional(rewrites.afterFiles ?? []);
    expect(redirects.length).toBeGreaterThan(0);
    for (const r of [...redirects, ...before, ...after]) {
      expect(match(r.source)(PATH), r.source).toBe(false);
    }
  });

  it('robots.txt не закрывает адрес ни одной группе', async () => {
    const { default: robots } = await import('@/app/robots');
    const out = await robots();
    const rules = Array.isArray(out.rules) ? out.rules : [out.rules];
    const list = (v: string | string[] | undefined) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      for (const d of list(rule.disallow)) {
        const re = new RegExp('^' + d.replace(/\$$/, '').split('*')
          .map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*'));
        if (d === '') continue;
        expect(re.test(PATH), `${String(rule.userAgent)}: ${d}`).toBe(false);
      }
    }
  });
});
