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
import { LandingContent } from '@/components/landings/LandingContent';
import {
  FEATURED_GUIDE_PATHS,
  LANDINGS,
  featuredGuideLandings,
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
  it('полный и компактный блок — 15–20 главных ссылок, указатель на хабах держит сирот', () => {
    const featured = featuredGuideLandings();
    expect(featured.length).toBeGreaterThanOrEqual(15);
    expect(featured.length).toBeLessThanOrEqual(20);
    expect(featured.length).toBe(FEATURED_GUIDE_PATHS.length);
    expect(featured.map((l) => l.path)).toEqual([...FEATURED_GUIDE_PATHS]);

    const full = renderToStaticMarkup(<KamchatkaGuide variant="full" />);
    const compact = renderToStaticMarkup(<KamchatkaGuide variant="compact" />);
    const index = renderToStaticMarkup(<KamchatkaGuide variant="index" />);
    const footer = renderToStaticMarkup(<Footer />);
    expect(full).toContain('data-kamchatka-guide="full"');
    expect(compact).toContain('data-kamchatka-guide="compact"');
    expect(index).toContain('data-kamchatka-guide="index"');
    expect(footer).toContain('data-kamchatka-guide="compact"');
    expect(full).toContain('Гид по Камчатке');
    expect(footer).toContain('Гид по Камчатке');
    const featuredHref = (slug: string) => featured.some((l) => l.slug === slug);
    for (const slug of ORPHANS) {
      const href = `href="${landingBySlug(slug).path}"`;
      expect(index, slug).toContain(href);
      if (featuredHref(slug)) {
        expect(full, slug).toContain(href);
        expect(compact, slug).toContain(href);
        expect(footer, slug).toContain(href);
      } else {
        expect(full, slug).not.toContain(href);
        expect(footer, slug).not.toContain(href);
      }
    }
    expect(renderToStaticMarkup(<Footer showGuide={false} />)).not.toContain('data-kamchatka-guide');
  });

  it('главная и подвал берут короткий блок, хабы — полный указатель', () => {
    const imp = "from '@/components/landings/KamchatkaGuide'";
    const home = readFileSync(join(ROOT, 'app/page.tsx'), 'utf-8');
    const articles = readFileSync(join(ROOT, 'app/articles/page.tsx'), 'utf-8');
    const when = readFileSync(join(ROOT, 'app/kogda-ehat-na-kamchatku/page.tsx'), 'utf-8');
    const footer = readFileSync(join(ROOT, 'components/layout/Footer.tsx'), 'utf-8');
    expect(home).toContain(imp);
    expect(home).toContain('variant="full"');
    expect(home).toMatch(/<\/main>[\s\S]*<KamchatkaGuide variant="full"/);
    expect(home).toContain('showGuide={false}');
    expect(articles).toContain(imp);
    expect(articles).toContain('variant="index"');
    expect(when).toContain(imp);
    expect(when).toContain('variant="index"');
    expect(footer).toContain(imp);
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

  it('шаблон посадочной рендерит блок «Читайте также»', () => {
    const src = readFileSync(join(ROOT, 'components/landings/LandingContent.tsx'), 'utf-8');
    expect(src).toContain("from '@/components/landings/KamchatkaGuide'");
    const html = renderToStaticMarkup(
      <LandingContent landing={landingBySlug('splav-na-kamchatke')} tours={[]} />,
    );
    expect(html).toContain('data-related-landings');
    expect(html).toContain('Читайте также');
  });
});

