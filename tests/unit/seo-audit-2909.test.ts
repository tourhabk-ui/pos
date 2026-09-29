/**
 * Находки SEO-аудита 29.09 (docs/seo/audit-2026-09-29.md), починенные быстрыми
 * правками, не возвращаются. Каждый блок называет находку.
 *
 * Сторож читает исходники: robots, sitemap, llms.txt и метаданные собираются
 * детерминированно, их поведение видно из кода.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

describe('Н5: служебные страницы закрыты для всех ботов, а не только для «*»', () => {
  const robots = code('app/robots.ts');
  it('у каждой группы один и тот же список запретов', () => {
    const groups = (robots.match(/userAgent:/g) ?? []).length;
    const shared = (robots.match(/disallow:\s*DISALLOW\b/g) ?? []).length;
    expect(groups).toBeGreaterThan(20);
    expect(shared).toBe(groups);
  });
  it('в списке — кабинет, API, вход, страница заявки, виджеты', () => {
    const list = robots.match(/const DISALLOW = \[([^\]]*)\]/)?.[1] ?? '';
    for (const p of ['/hub/', '/api/', '/auth/', '/booking-success/', '/widget/']) expect(list).toContain(`'${p}'`);
  });
  it('и на самих страницах noindex — robots.txt только просит не обходить', () => {
    for (const f of ['app/auth/layout.tsx', 'app/auth/login/page.tsx', 'app/booking-success/[id]/page.tsx', 'app/widget/layout.tsx']) {
      expect(code(f), f).toMatch(/robots:\s*\{\s*index:\s*false/);
    }
  });
});

describe('Н13: посадочная «Рыбалка» из шапки индексируется', () => {
  it('/hub/fishing перекрывает noindex кабинета и объявляет canonical', () => {
    const src = code('app/hub/fishing/page.tsx');
    expect(src).toMatch(/robots:\s*\{\s*index:\s*true/);
    expect(src).toMatch(/canonical:\s*'\/hub\/fishing'/);
    expect(code('app/robots.ts')).toMatch(/'\/hub\/fishing'/);
  });
});

describe('Н3/Н10: нет захардкоженных ссылок /routes/{uuid}', () => {
  const UUID_ROUTE = /\/routes\/[0-9a-f]{8}-[0-9a-f]{4}-/;
  it('сквозной JSON-LD layout не ссылается на маршруты по UUID', () => {
    expect(code('app/layout.tsx')).not.toMatch(UUID_ROUTE);
  });
  it('llms.txt: места — из places, ссылки /places/, без VIEW agent_route_knowledge', () => {
    const src = code('app/llms.txt/route.ts');
    expect(src).not.toMatch(UUID_ROUTE);
    expect(src).not.toMatch(/FROM agent_route_knowledge/);
    expect(src).toMatch(/FROM places/);
    expect(src).toMatch(/\$\{BASE\}\/places\/\$\{r\.ref\}/);
  });
});

describe('Н9: sitemap не предлагает адресов с 404 и 308', () => {
  const src = code('lib/seo/sitemap-entries.ts');
  it('операторы — только публичные (страница без is_public отвечает 404)', () => {
    expect(src).toMatch(/category = 'operator'[\s\S]{0,200}is_public = TRUE/);
  });
  it('слитые места не попадают (они отвечают 308)', () => {
    expect(src).toMatch(/FROM places[\s\S]{0,200}NOT_MERGED\('places'\)/);
  });
  it('справочник рыб и посадочная рыбалки — в sitemap', () => {
    expect(src).toMatch(/\$\{BASE\}\/fish`/);
    expect(src).toMatch(/FISH_SPECIES\.map/);
    expect(src).toMatch(/\$\{BASE\}\/hub\/fishing`/);
  });
});

describe('Н12: хлебные крошки тура ведут на каталог, а не на редирект', () => {
  it('JSON-LD и видимые крошки', () => {
    expect(code('lib/seo/tour-structured-data.ts')).not.toMatch(/siteUrl\}\/marketplace/);
    expect(code('app/marketplace/tours/[id]/_TourDetailClient.tsx')).not.toMatch(/href=\{`\/marketplace\?activity_type/);
  });
});

describe('Н14: og:url не наследуется от главной', () => {
  it('корневой layout не ставит openGraph.url, главная ставит свой', () => {
    const layout = code('app/layout.tsx');
    const og = layout.slice(layout.indexOf('openGraph:'), layout.indexOf('twitter:'));
    expect(og).not.toMatch(/\burl:\s*BASE_URL/);
    expect(code('app/page.tsx')).toMatch(/openGraph:\s*\{\s*url:\s*'\/'/);
  });
});
