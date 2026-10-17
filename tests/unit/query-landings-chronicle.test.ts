// @vitest-environment node
/** Летопись на посадочных, в Article-разметке, sitemap и llms. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chronicleForTopic } from '@/lib/seo/query-landings-chronicle';
import { CHRONICLE_ARTICLES } from '@/lib/chronicle/articles';
import { llmsZhFile } from '@/lib/mcp/zh-layer';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const art = (slug: string, title: string, lead: string) => ({ ...CHRONICLE_ARTICLES[0], slug, title, lead });

describe('статьи по теме', () => {
  it('вулканы и медведи — словом целиком; «все туры» — без подборки', () => {
    const list = [
      art('v', 'Национальный парк «Вулканы Камчатки»', 'с Мутновским и Горелым'),
      art('k', 'Южно-Камчатский заказник', 'Курильское озеро с крупнейшим стадом нерки'),
      art('m', 'Маяк', 'вулканический песок и Медвежья бухта'),
    ];
    expect(chronicleForTopic('volcano', list).map((a) => a.slug)).toEqual(['v']);
    expect(chronicleForTopic('bears', list).map((a) => a.slug)).toEqual(['k']);
    expect(chronicleForTopic('all', list)).toEqual([]);
  });
  it('на реальных статьях вулканам находится «Вулканы Камчатки», медведям — Южно-Камчатский заказник', () => {
    expect(chronicleForTopic('volcano').map((a) => a.slug)).toContain('vulkany-kamchatki');
    expect(chronicleForTopic('bears').map((a) => a.slug)).toContain('yuzhno-kamchatskij-zakaznik');
  });
});

describe('поверхности летописи', () => {
  it('Article: headline, author, publisher, citation из источников, экранированный JSON-LD', () => {
    const src = read('app/letopis/[slug]/page.tsx');
    for (const k of ["'@type': 'Article'", 'headline', 'author:', 'publisher:', "citation: a.sources.map", '<JsonLd']) expect(src).toContain(k);
  });
  it('sitemap называет оглавление и каждую статью', () => {
    const src = read('lib/seo/sitemap-entries.ts');
    expect(src).toContain('/letopis`');
    expect(src).toContain('/letopis/${a.slug}');
  });
  it('llms.txt — раздел со ссылками на статьи; llms-zh.txt — ссылка на /letopis', () => {
    expect(read('app/llms.txt/route.ts')).toContain('## Летопись Камчатки');
    expect(llmsZhFile('https://vedarai.ru')).toContain('https://vedarai.ru/letopis');
  });
});
