/**
 * Правки по журналу просмотров vedarai.ru за 19–21.11.2026:
 * два постоянных редиректа с битых адресов, /kuzmich в sitemap,
 * входы на посадочные четвёртой партии с хабов и родственных страниц.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { landingByPath, landingBySlug, LANDING_CROSS_LINKS } from '@/lib/landings/landings';

const ROOT = process.cwd();
const CONFIG = readFileSync(join(ROOT, 'next.config.js'), 'utf-8');
const SITEMAP = readFileSync(join(ROOT, 'lib/seo/sitemap-entries.ts'), 'utf-8');
const ACCOMMODATIONS = readFileSync(join(ROOT, 'app/accommodations/(list)/page.tsx'), 'utf-8');

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('журнал 21.11: постоянные редиректы с битых адресов', () => {
  const RULES = [
    { source: '/vulkan-mutnovskij-zakryt', destination: '/places/vulkan-mutnovskij', dir: 'app/vulkan-mutnovskij-zakryt' },
    { source: '/places/vulkan-avachinskiy', destination: '/places/vulkan-avachinskij', dir: 'app/places/vulkan-avachinskiy' },
  ] as const;

  for (const { source, destination, dir } of RULES) {
    it(`${source} → ${destination}, без папки-страницы`, () => {
      const rule = new RegExp(
        `source:\\s*'${esc(source)}',\\s*destination:\\s*'${esc(destination)}',\\s*permanent:\\s*true`,
      );
      expect(CONFIG, `нет правила для ${source}`).toMatch(rule);
      expect(existsSync(join(ROOT, dir)), `${dir} не должна существовать`).toBe(false);
    });
  }

  it('текст «Мутновский закрыт» живёт на карточке места, а не отдельным URL', () => {
    const landing = landingBySlug('vulkan-mutnovskij-zakryt');
    expect(landing.path).toBe('/places/vulkan-mutnovskij');
    expect(landing.type).toBe('upgrade');
    expect(landingByPath('/places/vulkan-mutnovskij')?.slug).toBe('vulkan-mutnovskij-zakryt');
  });
});

describe('журнал 21.11: /kuzmich в карте сайта', () => {
  it('статический список sitemap содержит /kuzmich', () => {
    expect(SITEMAP).toMatch(/`\$\{BASE\}\/kuzmich`/);
  });

  it('страница Кузьмича существует и открыта для индекса', () => {
    expect(existsSync(join(ROOT, 'app/kuzmich/page.tsx'))).toBe(true);
    const page = readFileSync(join(ROOT, 'app/kuzmich/page.tsx'), 'utf-8');
    expect(page).toMatch(/canonical:\s*'\/kuzmich'/);
    expect(page).not.toMatch(/index:\s*false/);
  });
});

describe('журнал 21.11: входы на посадочные четвёртой партии', () => {
  const text = (slug: string) => {
    const l = landingBySlug(slug);
    return l.before + l.after;
  };

  it('хаб жилья ведёт на «где остановиться»', () => {
    expect(LANDING_CROSS_LINKS['/accommodations']?.href).toBe('/gde-ostanovitsya-na-kamchatke');
    expect(ACCOMMODATIONS).toMatch(/LandingCrossLink/);
    expect(ACCOMMODATIONS).toMatch(/path="\/accommodations"/);
  });

  it('январь и хаб восхождений, а также «что посмотреть», ссылаются на новые страницы', () => {
    expect(text('kamchatka-v-yanvare')).toContain('](/sobachi-upryazhki-kamchatka)');
    expect(text('kamchatka-v-yanvare')).toContain('](/gonka-beringiya)');
    expect(text('kamchatka-v-fevrale')).toContain('](/gonka-beringiya)');
    expect(text('kamchatka-v-marte')).toContain('](/gonka-beringiya)');
    expect(text('kamchatka-s-detmi')).toContain('](/sobachi-upryazhki-kamchatka)');
    expect(text('chto-posmotret-na-kamchatke')).toContain('](/nalychevo-kak-dobratsya)');
    expect(text('chto-posmotret-na-kamchatke')).toContain('](/serfing-na-kamchatke)');
    expect(text('voshozhdeniya-na-vulkany-kamchatki')).toContain('](/voshozhdenie-na-vulkan-gorelyj)');
    expect(text('voshozhdeniya-na-vulkany-kamchatki')).toContain('](/klyuchevskaya-sopka-izverzhenie)');
    expect(text('voshozhdeniya-na-vulkany-kamchatki')).toContain('](/places/vulkan-klyuchevskaya-sopka)');
  });

  it('у каждой посадочной четвёртой партии есть вход со страницы-родственника', () => {
    const batch4 = [
      'serfing-na-kamchatke',
      'sobachi-upryazhki-kamchatka',
      'gonka-beringiya',
      'nalychevo-kak-dobratsya',
      'voshozhdenie-na-vulkan-gorelyj',
      'klyuchevskaya-sopka-izverzhenie',
      'vachkazhets-kak-dobratsya',
      'malkinskie-istochniki-kak-dobratsya',
      'zelenovskie-ozerki',
      'avachinskij-pereval-i-verblyud',
      'vilyuchinskij-vodopad',
      'gde-ostanovitsya-na-kamchatke',
    ] as const;

    const hubTexts = [
      'kamchatka-v-yanvare',
      'kamchatka-v-fevrale',
      'kamchatka-v-marte',
      'kamchatka-s-detmi',
      'chto-posmotret-na-kamchatke',
      'voshozhdeniya-na-vulkany-kamchatki',
    ].map(text).join('\n');

    const crossHrefs = new Set(Object.values(LANDING_CROSS_LINKS).map((l) => l.href));

    for (const slug of batch4) {
      const href = `/${slug}`;
      const fromCross = crossHrefs.has(href);
      const fromHub = hubTexts.includes(`](${href})`);
      expect(fromCross || fromHub, `нет входа на ${href}`).toBe(true);
    }
  });
});
