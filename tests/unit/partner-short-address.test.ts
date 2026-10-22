// @vitest-environment node
/**
 * Короткий адрес партнёра vedarai.ru/<slug> и форма на странице оператора
 * (решение владельца 13.10: «форму можно, адрес vedarai.ru/<slug>»).
 *
 * Что держит сторож:
 *  - короткий адрес — rewrite в next.config.js на ту же страницу
 *    /operators/<slug>, а не маршрут app/[slug]: верхний динамический
 *    сегмент делает «страницей» любой односегментный адрес, и правило Next
 *    no-html-link-for-pages краснит все жёсткие <a href="/…"> проекта
 *    (17 ошибок lint на #2414), включая намеренные (field-nav-hard);
 *  - rewrite стоит в afterFiles: статические страницы и файлы public старше
 *    него, /catalog и /robots.txt он не перехватывает (beforeFiles с 22.10 —
 *    только правила домена партнёра, каждое с условием домена);
 *  - форма slug в rewrite пускает slug партнёров и не пускает точку,
 *    кириллицу, заглавные и подчёркивание — опечатки в базу не ходят;
 *  - canonical остаётся /operators/<slug>: короткий адрес — для людей и QR,
 *    в поиске страница одна;
 *  - на странице оператора есть якорь #lead-form, кнопка к нему в герое и
 *    сама форма с slug партнёра.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const CONFIG = read('next.config.js');
const OPERATOR = read('app/operators/[slug]/page.tsx');

/** Партнёры с заполненными страницами (1106, 1174, 1216, 060). */
const KNOWN_PARTNER_SLUGS = ['fishingkam', 'kamchatskaya-rybalka', 'mestechko', 'volcanoesland', 'kamchatka-rafting'];

/** Rewrite короткого адреса ровно в той форме, что в next.config.js. */
function shortAddressRewrite(): { pattern: string; destination: string } {
  const m = CONFIG.match(/\{ source: '\/:slug\(([^)]+)\)', destination: '([^']+)' \}/);
  if (!m) throw new Error('rewrite короткого адреса в next.config.js не найден');
  return { pattern: m[1], destination: m[2] };
}

describe('короткий адрес — rewrite на страницу оператора', () => {
  it('ведёт на /operators/:slug и стоит в afterFiles, а не перед файлами', async () => {
    const { destination } = shortAddressRewrite();
    expect(destination).toBe('/operators/:slug');
    // Исполнением, а не по тексту: с 22.10 rewrites() — объект, beforeFiles у
    // него — домен партнёра (fishingkam.ru). Короткий адрес обязан остаться
    // afterFiles: в beforeFiles он перехватил бы /catalog, /about, /robots.txt.
    const config = require(join(ROOT, 'next.config.js')) as { rewrites: () => Promise<unknown> };
    const r = await config.rewrites() as { beforeFiles?: Array<{ source: string; has?: unknown[] }>; afterFiles?: Array<{ source: string; destination: string }>; fallback?: unknown[] };
    const after = Array.isArray(r) ? r as Array<{ source: string; destination: string }> : r.afterFiles ?? [];
    expect(after.map((x) => x.destination)).toContain('/operators/:slug');
    const before = Array.isArray(r) ? [] : r.beforeFiles ?? [];
    expect(before.some((x) => x.source.startsWith('/:slug'))).toBe(false);
    // Правило перед файлами без условия домена подменило бы страницы Ведара.
    for (const x of before) expect(x.has?.length ?? 0, x.source).toBeGreaterThan(0);
    expect(Array.isArray(r) ? [] : r.fallback ?? []).toEqual([]);
  });

  it('форма slug: slug партнёров проходят, точка, кириллица, заглавные и подчёркивание — нет', () => {
    const re = new RegExp(`^${shortAddressRewrite().pattern}$`);
    for (const s of KNOWN_PARTNER_SLUGS) expect(re.test(s), s).toBe(true);
    for (const s of ['x.png', 'favicon.ico', 'Mestechko', 'тест', 'a_b', '', 'a', '-a', 'a/b', 'a b']) {
      expect(re.test(s), JSON.stringify(s)).toBe(false);
    }
  });

  it('верхнего динамического сегмента в app/ нет — он бы снова покраснил все жёсткие ссылки', () => {
    expect(existsSync(join(ROOT, 'app/[slug]'))).toBe(false);
    const dynamicTop = readdirSync(join(ROOT, 'app')).filter((n) => n.startsWith('['));
    expect(dynamicTop).toEqual([]);
  });

  it('slug партнёров не совпадает с именами верхних разделов сайта', () => {
    const sections = readdirSync(join(ROOT, 'app')).filter((n) => !n.startsWith('_') && !n.includes('.'));
    expect(sections.length).toBeGreaterThan(20);
    for (const s of KNOWN_PARTNER_SLUGS) expect(sections, s).not.toContain(s);
  });

  it('canonical страницы оператора остаётся /operators/<slug>', () => {
    expect(OPERATOR).toContain('alternates: { canonical: `${SITE}/operators/${profile.slug}` }');
  });
});

describe('страница оператора — форма в ящик оператора', () => {
  it('кнопка в герое ведёт к якорю, якорь на секции формы', () => {
    expect(OPERATOR).toContain('href="#lead-form"');
    expect(OPERATOR).toContain('id="lead-form"');
    expect(OPERATOR).toContain('Написать оператору');
  });

  it('форма получает slug и имя оператора', () => {
    expect(OPERATOR).toContain("import { OperatorLeadForm } from '@/components/operators/OperatorLeadForm'");
    expect(OPERATOR).toContain('<OperatorLeadForm partnerSlug={profile.slug} partnerName={profile.name} />');
  });

  it('кнопки «Забронировать» на профиле по-прежнему нет (владелец 02.10)', () => {
    const code = OPERATOR.replace(/\{\/\*[\s\S]*?\*\/\}|\/\/.*$/gm, '');
    expect(code).not.toMatch(/Забронировать/);
  });
});
