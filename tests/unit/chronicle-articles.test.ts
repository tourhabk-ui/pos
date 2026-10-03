/**
 * Сторож «Летописи Камчатки» (решение владельца 03.10): статья — справка по
 * источникам, открывается своей страницей, доступна из навигации и sitemap.
 *
 * Повод — заметка на карточке Батареи Максутова: от первого лица, с
 * выдуманной «плитой на валуне» и «12 нижними чинами». Поэтому у статьи
 * обязаны быть названные источники и голос справки, а не путевой заметки.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CHRONICLE_ARTICLES, CHRONICLE_BY_SLUG, chronicleForPlace } from '@/lib/chronicle/articles';
import { descriptionVoice } from '@/lib/places/description-voice';

const ROOT = process.cwd();
const text = (slug: string) => CHRONICLE_BY_SLUG[slug].sections
  .flatMap((s) => s.paragraphs.map((p) => (typeof p === 'string' ? p : p.quote)))
  .join('\n');

describe('статьи летописи', () => {
  it('адреса уникальны и годятся для ссылки', () => {
    const slugs = CHRONICLE_ARTICLES.map((a) => a.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of slugs) expect(s).toMatch(/^[a-z0-9-]+$/);
  });

  for (const a of CHRONICLE_ARTICLES) {
    it(`${a.slug}: у статьи названы источники со ссылками`, () => {
      expect(a.sources.length).toBeGreaterThan(0);
      for (const s of a.sources) expect(s.url).toMatch(/^https:\/\//);
    });

    it(`${a.slug}: голос справки, не путевой заметки`, () => {
      // Цитаты участников — от первого лица по природе; судится текст статьи.
      const own = a.sections.flatMap((s) => s.paragraphs.filter((p): p is string => typeof p === 'string')).join('\n');
      expect(descriptionVoice(own).voice).toBe('plain');
    });

    it(`${a.slug}: дата сверки — настоящая дата`, () => {
      expect(Number.isNaN(Date.parse(a.checkedAt))).toBe(false);
    });

    it(`${a.slug}: без эмодзи`, () => {
      expect(text(a.slug)).not.toMatch(/\p{Extended_Pictographic}/u);
    });
  }

  it('оборона 1854 связана с Батареей Максутова и Никольской сопкой', () => {
    expect(chronicleForPlace('a2b3c4d5-e6f7-4890-bcde-f01234567890').map((a) => a.slug))
      .toContain('petropavlovskaya-oborona-1854');
    expect(chronicleForPlace('51598b80-6b92-48d9-beb4-019f824524c9').length).toBeGreaterThan(0);
  });

  it('Дмитрий Максутов — младший брат Александра (источник), не наоборот', () => {
    expect(text('petropavlovskaya-oborona-1854')).toContain('Александр Максутов, старший брат Дмитрия');
  });
});

describe('страницы, навигация и sitemap', () => {
  it('оглавление и страница статьи существуют', () => {
    expect(existsSync(join(ROOT, 'app/letopis/page.tsx'))).toBe(true);
    expect(existsSync(join(ROOT, 'app/letopis/[slug]/page.tsx'))).toBe(true);
  });

  it('раздел есть в навигации и в sitemap', () => {
    expect(readFileSync(join(ROOT, 'lib/navigation/platform-links.ts'), 'utf-8')).toContain("href: '/letopis'");
    const sm = readFileSync(join(ROOT, 'lib/seo/sitemap-entries.ts'), 'utf-8');
    expect(sm).toContain('/letopis');
    expect(sm).toContain('CHRONICLE_ARTICLES.map');
  });

  it('карточка места ведёт на статью', () => {
    expect(readFileSync(join(ROOT, 'app/places/[id]/_PlaceDetailClient.tsx'), 'utf-8')).toMatch(/href=\{`\/letopis\/\$\{c\.slug\}`\}/);
  });
});
