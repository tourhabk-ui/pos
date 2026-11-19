/**
 * Файл подтверждения Search Console отдаётся как есть (задача индексации, 19.11).
 *
 * Google подтверждает права на сайт, читая https://vedarai.ru/<имя>.html: код
 * 200 и ровно та строка, что в файле, который выдала консоль. Файл лежит в
 * public/, Next отдаёт его статикой. Что может его сломать: правка содержимого
 * (лишний перевод строки), редирект или rewrite раньше файла, Disallow в
 * robots.txt. Всё это судится здесь — вызовом правил, а не по тексту.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'user-agent': 'Googlebot' }) }));
vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn(async () => ({ rows: [] })) } }));

const NAME = 'google843db3823a4a26c8.html';
const PATH = `/${NAME}`;
const EXPECTED = `google-site-verification: ${NAME}`;

const { match } = require('next/dist/compiled/path-to-regexp') as {
  match: (src: string) => (path: string) => unknown;
};
const config = require(join(process.cwd(), 'next.config.js')) as {
  redirects: () => Promise<Array<{ source: string; has?: unknown[] }>>;
  rewrites: () => Promise<{ beforeFiles?: Array<{ source: string; has?: unknown[] }> }>;
};

describe('файл подтверждения Google', () => {
  it('лежит в public/ байт в байт, как его выдала консоль', () => {
    const body = readFileSync(join(process.cwd(), 'public', NAME), 'utf8');
    expect(body).toBe(EXPECTED);
  });

  it('ни редирект, ни rewrite до файла не перехватывают адрес на vedarai.ru', async () => {
    // Правила с условием `has` срабатывают только на чужом хосте
    // (tourhab.ru, www, сайты партнёров) — запрос к vedarai.ru их не задевает.
    const unconditional = (rules: Array<{ source: string; has?: unknown[] }>) =>
      rules.filter((r) => !r.has || r.has.length === 0);
    const redirects = unconditional(await config.redirects());
    const before = unconditional((await config.rewrites()).beforeFiles ?? []);
    expect(redirects.length).toBeGreaterThan(0);
    for (const r of [...redirects, ...before]) {
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
