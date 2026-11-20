import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { articleJsonLd } from '@/lib/articles/article-jsonld';

// Второй пакет Сыщика (seomator 20.11): @id у WebSite, contactPoint у
// Organization, хлебные крошки у парка, Article ссылается на ту же организацию.
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

describe('разметка организации и сайта', () => {
  const layout = read('app/layout.tsx');
  it('у WebSite и Organization есть @id', () => {
    expect(layout).toContain('"@id": `${BASE_URL}/#website`');
    expect(layout).toContain('"@id": `${BASE_URL}/#organization`');
  });
  it('contactPoint — из реквизитов, без своих номеров', () => {
    const i = layout.indexOf('"contactPoint"');
    expect(i).toBeGreaterThan(0);
    const block = layout.slice(i, layout.indexOf('}]', i));
    expect(block).toContain('"telephone": REQUISITES.phone');
    expect(block).toContain('"email": REQUISITES.emailSupport');
    expect(block).not.toMatch(/\+7|@vedarai/);
  });
});

describe('хлебные крошки парка', () => {
  it('карточка парка выводит BreadcrumbList до /park', () => {
    const src = read('app/park/[slug]/page.tsx');
    expect(src).toContain('BreadcrumbJsonLd');
    expect(src).toContain('url: `${SITE}/park` }');
    expect(src).toContain('url: `${SITE}/park/${park.slug}` }');
  });
});

describe('Article ссылается на организацию сайта', () => {
  it('author и publisher — узел #organization', () => {
    const ld = articleJsonLd({
      url: 'https://vedarai.ru/articles/x', site: 'https://vedarai.ru', headline: 'H', description: null,
      datePublished: '2026-11-20', dateModified: '2026-11-20', faq: [],
    });
    const graph = (ld['@graph'] as Array<Record<string, unknown>> | undefined) ?? [ld];
    const article = graph.find((n) => n['@type'] === 'Article')!;
    expect((article.publisher as Record<string, unknown>)['@id']).toBe('https://vedarai.ru/#organization');
  });
});
