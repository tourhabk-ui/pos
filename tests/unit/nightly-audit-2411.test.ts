/**
 * Ночной аудит 24.11: дубль SOS, угаданные адреса июня/сентября, sitemap.
 * Hreflang /safety ↔ /zh/safety, канон «когда ехать» и строки даты на
 * разрешении/местах уже были на main к моменту правки — сторожа ниже
 * только держат, чтобы не откатилось.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { safetyHreflang } from '@/lib/zh/pages';
import { ZH_SAFETY_GUIDE, zhGuideHreflang } from '@/lib/zh/guides';
import { LANDING_CANONICAL } from '@/lib/landings/landings';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

describe('дубль /emergency и /sos (аудит 24.11)', () => {
  it('канон /emergency — /sos, страница noindex, из sitemap убрана, URL жив', () => {
    const html = read('public/emergency.html');
    expect(html).toContain('rel="canonical" href="https://vedarai.ru/sos"');
    expect(html).toContain('name="robots" content="noindex, follow"');
    expect(read('app/emergency/route.ts')).toMatch(/X-Robots-Tag': 'noindex, follow'/);
    expect(existsSync(join(ROOT, 'app/emergency/route.ts'))).toBe(true);
    expect(existsSync(join(ROOT, 'public/emergency.html'))).toBe(true);
    const sitemap = read('lib/seo/sitemap-entries.ts');
    expect(sitemap).toMatch(/url: `\$\{BASE\}\/sos`/);
    expect(sitemap).not.toMatch(/url: `\$\{BASE\}\/emergency`/);
    // Живой шлюз не 301-им на /sos: без JS /sos не открывается офлайн.
    const config = read('next.config.js');
    expect(config).not.toMatch(/source:\s*'\/emergency'\s*,\s*destination:\s*'\/sos'/);
    expect(config).toMatch(/source:\s*'\/emergency\.html'\s*,\s*destination:\s*'\/emergency'/);
  });
});

describe('угаданные адреса июня и сентября → /plans/…', () => {
  it('постоянный редирект, папок-страниц в корне нет', () => {
    const config = read('next.config.js');
    for (const month of ['iyune', 'sentyabre'] as const) {
      const src = `/kamchatka-v-${month}`;
      const dest = `/plans/kamchatka-v-${month}`;
      expect(config).toMatch(
        new RegExp(`source:\\s*'${src.replaceAll('/', '\\/')}',\\s*destination:\\s*'${dest.replaceAll('/', '\\/')}',\\s*permanent:\\s*true`),
      );
      expect(existsSync(join(ROOT, `app/kamchatka-v-${month}`))).toBe(false);
    }
  });
});

describe('уже закрыто к 24.11 — не откатывать', () => {
  it('/safety и /zh/safety взаимно указывают ru, zh-CN и x-default', () => {
    const site = 'https://vedarai.ru';
    expect(safetyHreflang(site)).toEqual({
      ru: `${site}/safety`,
      'zh-CN': `${site}/zh/safety`,
      'x-default': `${site}/safety`,
    });
    expect(zhGuideHreflang(ZH_SAFETY_GUIDE, site)).toEqual(safetyHreflang(site));
    expect(read('app/safety/page.tsx')).toMatch(/languages:\s*safetyHreflang\(SITE\)/);
  });

  it('статья «когда ехать» канонична на посадочную и не предлагается sitemap', () => {
    expect(LANDING_CANONICAL['/articles/kogda-luchshe-ehat-na-kamchatku']).toBe('/kogda-ehat-na-kamchatku');
    const sitemap = read('lib/seo/sitemap-entries.ts');
    expect(sitemap).toMatch(/!LANDING_CANONICAL\[`\/articles\/\$\{row\.slug\}`\]/);
    expect(sitemap).toMatch(/url: `\$\{BASE\}\/kogda-ehat-na-kamchatku`/);
  });
});
