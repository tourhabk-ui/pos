/**
 * Перелинковка тематических посадочных (Сыщик 22.11): блок «Гид по Камчатке»
 * на главной, в /articles и в подвале, плюс «Читайте также» на посадочных.
 * Ссылки берутся из реестра LANDINGS, без второй копии списка.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';

import { Footer } from '@/components/layout/Footer';
import { KamchatkaGuide, RelatedLandings } from '@/components/landings/KamchatkaGuide';
import {
  LANDINGS,
  guideAnchor,
  guideLandings,
  landingBySlug,
  relatedLandings,
} from '@/lib/landings/landings';

const ROOT = process.cwd();

/** Шесть сирот из ночного аудита 22.11: входящих ссылок не было. */
const ORPHANS = [
  'chto-privezti-s-kamchatki',
  'gornolyzhnye-bazy-kamchatki',
  'heli-ski-kamchatka',
  'kamchatskaya-kukhnya-gde-poest',
  'splav-na-kamchatke',
  'svyaz-i-internet-na-kamchatke',
] as const;

describe('гид по Камчатке — реестр', () => {
  it('собирается из LANDINGS, без месячных страниц и без второй копии слагов', () => {
    const src = readFileSync(join(ROOT, 'lib/landings/landings.ts'), 'utf-8');
    expect(src).toMatch(/LANDINGS\.filter\(\(l\) => !isMonthLanding\(l\)\)/);
    const guide = guideLandings();
    const paths = new Set(LANDINGS.map((l) => l.path));
    expect(guide.length).toBeGreaterThanOrEqual(21);
    for (const l of guide) {
      expect(paths.has(l.path), l.path).toBe(true);
      expect(l.slug.startsWith('kamchatka-v-') && !l.slug.includes('vulkany'), l.slug).toBe(false);
    }
    expect(guide.some((l) => l.slug === 'kamchatka-v-iyule')).toBe(false);
    expect(guide.some((l) => l.slug === 'kogda-ehat-na-kamchatku')).toBe(true);
  });

  it('подпись ссылки — часть H1 или title до двоеточия', () => {
    const bears = landingBySlug('medvedi-kamchatki');
    const anchor = guideAnchor(bears);
    expect(bears.h1.startsWith(anchor) || bears.title.startsWith(anchor)).toBe(true);
    expect(anchor.includes(':')).toBe(false);
    expect(anchor.length).toBeGreaterThan(0);
    for (const l of guideLandings()) {
      const a = guideAnchor(l);
      expect(l.h1.startsWith(a) || l.title.startsWith(a), l.slug).toBe(true);
    }
  });
});

describe('гид по Камчатке — блок', () => {
  it('в полном и компактном блоке есть все шесть сирот', () => {
    const full = renderToStaticMarkup(<KamchatkaGuide variant="full" />);
    const compact = renderToStaticMarkup(<KamchatkaGuide variant="compact" />);
    const footer = renderToStaticMarkup(<Footer />);
    expect(full).toContain('data-kamchatka-guide="full"');
    expect(compact).toContain('data-kamchatka-guide="compact"');
    expect(footer).toContain('data-kamchatka-guide="compact"');
    expect(full).toContain('Гид по Камчатке');
    expect(footer).toContain('Гид по Камчатке');
    for (const slug of ORPHANS) {
      const href = `href="${landingBySlug(slug).path}"`;
      expect(full, slug).toContain(href);
      expect(compact, slug).toContain(href);
      expect(footer, slug).toContain(href);
    }
  });

  it('главная и /articles ставят полный блок; подвал — компактный', () => {
    const home = readFileSync(join(ROOT, 'app/page.tsx'), 'utf-8');
    const articles = readFileSync(join(ROOT, 'app/articles/page.tsx'), 'utf-8');
    const footer = readFileSync(join(ROOT, 'components/layout/Footer.tsx'), 'utf-8');
    expect(home).toMatch(/<KamchatkaGuide variant="full" \/>/);
    expect(articles).toMatch(/<KamchatkaGuide variant="full" \/>/);
    expect(footer).toMatch(/<KamchatkaGuide variant="compact" \/>/);
  });
});

describe('читайте также на посадочных', () => {
  it('3–5 ссылок, без самой страницы, подписи из H1 или title', () => {
    for (const l of LANDINGS) {
      const rel = relatedLandings(l, 5);
      expect(rel.length, l.slug).toBeGreaterThanOrEqual(3);
      expect(rel.length, l.slug).toBeLessThanOrEqual(5);
      expect(rel.some((r) => r.path === l.path), l.slug).toBe(false);
    }
    const html = renderToStaticMarkup(
      <RelatedLandings landing={landingBySlug('splav-na-kamchatke')} />,
    );
    expect(html).toContain('Читайте также');
    expect(html).toContain('data-related-landings');
    expect(html).not.toContain('href="/splav-na-kamchatke"');
  });

  it('шаблон посадочной ставит блок «Читайте также»', () => {
    const src = readFileSync(join(ROOT, 'components/landings/LandingContent.tsx'), 'utf-8');
    expect(src).toMatch(/<RelatedLandings landing=\{landing\} \/>/);
  });
});
