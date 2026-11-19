// @vitest-environment node
/**
 * Подвал русской посадочной ведёт на страницы-ответы о цене и сезоне (#3539):
 * до этого на них вели только меню и сами страницы друг на друга. Сторож —
 * рендером: ссылки видны на русской посадочной, их нет на английской, и
 * каждая ведёт на существующую страницу из карты сайта.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryLandingView, TRIP_GUIDE_LINKS } from '@/components/seo/QueryLanding';
import { landingByKey } from '@/lib/seo/query-landings';

describe('подвал посадочной — страницы о цене и сезоне', () => {
  it('русская посадочная ссылается на обе страницы, английская — нет', () => {
    const ru = renderToStaticMarkup(<QueryLandingView landing={landingByKey('ru-geysers')} tours={[]} />);
    for (const g of TRIP_GUIDE_LINKS) {
      expect(ru).toContain(`href="${g.path}"`);
      expect(ru).toContain(g.label);
    }
    const en = renderToStaticMarkup(<QueryLandingView landing={landingByKey('en-bears')} tours={[]} />);
    for (const g of TRIP_GUIDE_LINKS) expect(en).not.toContain(`href="${g.path}"`);
  });

  it('ссылка ведёт на страницу, которая есть', () => {
    for (const g of TRIP_GUIDE_LINKS) {
      expect(existsSync(join(process.cwd(), 'app', g.path.slice(1), 'page.tsx'))).toBe(true);
    }
  });
});
