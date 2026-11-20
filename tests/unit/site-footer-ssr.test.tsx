/**
 * Подвал сайта — в серверном HTML (Сыщик 21.11): на карточках мест, посадочных,
 * /prepare, /routes, /park, /fish его не было вовсе.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { renderToString } from 'react-dom/server';

const path = { current: '/prepare' };
vi.mock('next/navigation', () => ({ usePathname: () => path.current }));

import { showSiteFooter, OWN_FOOTER_PATHS } from '@/lib/navigation/site-footer-paths';
import { SiteFooter } from '@/components/layout/SiteFooter';
import { Footer } from '@/components/layout/Footer';

const ROOT = process.cwd();

describe('где подвал', () => {
  it('контентные страницы — да; приложения, кабинеты и страницы со своим подвалом — нет', () => {
    for (const p of ['/prepare', '/routes', '/park', '/fish', '/places/paratunskaya-zona-otdyha',
      '/kak-dobratsya-na-kamchatku', '/letopis/bystrinskij-park', '/weather', '/hub/fishing', '/park/', '/blog/some-post', '/operators/x', '/tools']) {
      expect(showSiteFooter(p), p).toBe(true);
    }
    for (const p of ['/map', '/auth/login', '/hub', '/hub/admin', '/kuzmich', '/sos', '/', '/catalog', '/en/places', '/p/abc', '/trip/t1', '/catalog/tours/x', '/widget/fishingkam', '/partner-site/fishingkam']) {
      expect(showSiteFooter(p), p).toBe(false);
    }
  });

  it('серверный рендер: ссылки подвала есть в HTML без JS', () => {
    path.current = '/prepare';
    const html = renderToString(<SiteFooter><Footer /></SiteFooter>);
    expect(html).toContain('<footer');
    expect(html).toMatch(/href="\/mcp"/);
    path.current = '/map';
    expect(renderToString(<SiteFooter><Footer /></SiteFooter>)).toBe('');
  });

  it('корневой layout ставит подвал; страницы со своим <Footer /> — ровно OWN_FOOTER_PATHS', () => {
    const layout = readFileSync(join(ROOT, 'app/layout.tsx'), 'utf-8');
    expect(layout).toMatch(/import \{ SiteFooter \} from '@\/components\/layout\/SiteFooter'/);
    expect(layout.includes('<SiteFooter><Footer /></SiteFooter>'), 'подвал в layout — внутри SiteFooter').toBe(true);
    // Кто ещё ставит <Footer /> сам — только главная и каталог (OWN_FOOTER_PATHS);
    // любой другой дал бы второй подвал поверх общего.
    const users: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const full = join(d, f);
        if (statSync(full).isDirectory()) { walk(full); continue; }
        if (!/\.tsx?$/.test(f)) continue;
        if (/from '@\/components\/(layout\/Footer|marketplace\/CatalogFooter)'/.test(readFileSync(full, 'utf-8'))) {
          users.push(relative(ROOT, full).split(sep).join('/'));
        }
      }
    };
    walk(join(ROOT, 'app'));
    walk(join(ROOT, 'components'));
    expect(users.sort()).toEqual(['app/catalog/(list)/page.tsx', 'app/catalog/tours/[id]/_TourDetailClient.tsx', 'app/layout.tsx', 'app/page.tsx', 'components/marketplace/CatalogFooter.tsx'].sort());
    expect([...OWN_FOOTER_PATHS].sort()).toEqual(['/', '/catalog', '/catalog/tours/[id]']);
  });
});
