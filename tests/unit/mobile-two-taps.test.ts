// @vitest-environment node
/**
 * Два касания с телефона (владелец, 02.09).
 *
 * Футер был единственной дорогой к половине платформы на телефоне, и его
 * находили случайно: он вмонтирован не везде, а таб-бар несёт пять пунктов.
 * Теперь список ссылок один (lib/navigation/platform-links), его читают футер
 * и страница «Ещё» (/menu), а в шапке стоит вход на неё.
 *
 * Сторож держит три вещи:
 *   1. Каждая публичная страница из статического списка sitemap достижима с
 *      телефона за два касания: таб-бар, шапка, либо шапка → /menu → реестр.
 *      Страница, известная поисковику и неизвестная человеку, — снова долг.
 *   2. Футер и /menu читают реестр, своих списков не держат.
 *   3. Вход на /menu есть в шапке, а /menu несёт таб-бар и SOS.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PLATFORM_SECTIONS, allPlatformHrefs, PLATFORM_LINKS, LEGAL_LINKS } from '@/lib/navigation/platform-links';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');

/** Статические страницы sitemap: литералы `${BASE}/path` в sitemap-entries. */
function sitemapStaticPaths(): string[] {
  const src = strip(read('lib/seo/sitemap-entries.ts'));
  const out = new Set<string>();
  for (const m of src.matchAll(/`\$\{BASE\}(\/[a-z0-9/_-]*)`/g)) out.add(m[1]);
  return [...out].sort();
}

/** Пути таб-бара: `href: '/x'` в BottomNav. */
function bottomNavPaths(): string[] {
  const src = strip(read('components/shared/BottomNav.tsx'));
  return [...src.matchAll(/href:\s*'([^']+)'/g)].map(m => m[1].split('?')[0]);
}

/** Пути шапки: href в Header (и десктопная полоса, и значки). */
function headerPaths(): string[] {
  const src = strip(read('components/layout/Header.tsx'));
  return [...src.matchAll(/href[=:]\s*["']([^"']+)["']/g)].map(m => m[1]);
}

describe('1. две касания с телефона', () => {
  it('список sitemap найден и не пуст', () => {
    expect(sitemapStaticPaths().length).toBeGreaterThan(20);
  });

  it('каждая статическая страница sitemap достижима: таб-бар, шапка или /menu', () => {
    const reachable = new Set(['/', ...bottomNavPaths(), ...headerPaths(), ...allPlatformHrefs()]);
    const missing = sitemapStaticPaths().filter(p => !reachable.has(p));
    expect(missing, 'страница известна поисковику, но с телефона до неё нет дороги').toEqual([]);
  });

  it('вход на /menu — в шапке', () => {
    expect(headerPaths()).toContain('/menu');
  });
});

describe('2. реестр один', () => {
  it('футер читает реестр и своих списков не держит', () => {
    const src = strip(read('components/layout/Footer.tsx'));
    expect(src).toMatch(/from '@\/lib\/navigation\/platform-links'/);
    expect(src, 'в футере снова свой список ссылок').not.toMatch(/\{\s*label:\s*'[^']+',\s*href:\s*'\//);
  });

  it('/menu читает реестр', () => {
    const src = strip(read('app/menu/page.tsx'));
    expect(src).toMatch(/PLATFORM_SECTIONS/);
    expect(src).not.toMatch(/\{\s*label:\s*'[^']+',\s*href:\s*'\//);
  });

  it('в реестре нет дублей путей, у каждой ссылки — подпись и значок', () => {
    const hrefs = allPlatformHrefs();
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const s of PLATFORM_SECTIONS) for (const l of s.links) {
      expect(l.label.trim().length).toBeGreaterThan(1);
      expect(typeof l.icon).toBe('object');
    }
    expect(PLATFORM_LINKS.length + LEGAL_LINKS.length).toBe(hrefs.length);
  });

  it('пути реестра существуют как страницы', () => {
    const missing = allPlatformHrefs().filter(h => {
      const dir = join(ROOT, 'app', h.replace(/^\//, ''));
      try { readFileSync(join(dir, 'page.tsx')); return false; } catch { return true; }
    });
    expect(missing, 'реестр ведёт на страницу, которой нет').toEqual([]);
  });
});

describe('3. /menu — экран, а не список', () => {
  const src = strip(read('app/menu/page.tsx'));
  it('несёт шапку, таб-бар и SOS', () => {
    expect(src).toMatch(/<Header \/>/);
    expect(src).toMatch(/<BottomNav\b/);
    expect(src).toMatch(/<EmergencyAction\b/);
  });
  it('не индексируется: это навигация, а не контент', () => {
    expect(src).toMatch(/index:\s*false/);
  });
});
