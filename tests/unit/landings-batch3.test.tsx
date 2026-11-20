/**
 * Посадочные Сыщика, третья партия (21.11, lib/landings/texts-batch3.ts).
 * Держится: 9 новых адресов со своими страницами и 3 апгрейда; цен в тексте
 * нет; пользовательский каталог и неподтверждённые числа сняты; Авачинский —
 * 2751 м по KVERT; новые страницы связаны между собой.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, cleanup, screen } from '@testing-library/react';

import { LANDING_TEXTS_BATCH3 } from '@/lib/landings/texts-batch3';
import { landingBySlug, landingByPath, LANDING_CROSS_LINKS } from '@/lib/landings/landings';
import { tourMatchesSpec, type LandingBlockTour } from '@/lib/landings/tours';
import { landingJsonLd } from '@/components/landings/LandingContent';
import { LandingCrossLink } from '@/components/landings/LandingCrossLink';

afterEach(cleanup);

const NEW = [
  'chto-vzyat-s-soboj-na-kamchatku', 'komandorskie-ostrova-kak-popast', 'mozhno-li-kupatsya-na-kamchatke',
  'pogoda-na-kamchatke-po-mesyacam', 'raznica-vo-vremeni-kamchatka-moskva', 'skolko-dnej-nuzhno-na-kamchatku',
  'splav-na-kamchatke', 'svyaz-i-internet-na-kamchatke', 'vulkany-kamchatki-yunesko',
];

const tour = (o: Partial<LandingBlockTour>): LandingBlockTour => ({
  id: '1', slug: 'tur', title: 'Тур', base_price: '10000', price_unit: 'per_person', duration_hours: '8',
  operator_name: 'Оператор', operator_slug: null, operator_public: null,
  season_start: null, season_end: null, next_open_date: null, any_day_open: null, ...o,
});

const text = (slug: string) => { const l = landingBySlug(slug); return l.before + l.after; };

describe('третья партия посадочных', () => {
  it('9 новых адресов со страницами и 3 апгрейда тех же URL', () => {
    expect(LANDING_TEXTS_BATCH3).toHaveLength(12);
    for (const s of NEW) {
      const l = landingBySlug(s);
      expect(l.type, s).toBe('new');
      expect(l.path, s).toBe(`/${s}`);
      expect(existsSync(join(process.cwd(), 'app', s, 'page.tsx')), s).toBe(true);
    }
    expect(landingByPath('/places/kurilskoe-ozero')?.slug).toBe('kurilskoe-ozero-kak-dobratsya');
    expect(landingByPath('/places/vulkan-mutnovskij')?.slug).toBe('vulkan-mutnovskij-zakryt');
    expect(landingByPath('/voshozhdenie-na-avachinskij-vulkan')?.type).toBe('upgrade');
    const page = readFileSync(join(process.cwd(), 'app/voshozhdenie-na-avachinskij-vulkan/page.tsx'), 'utf-8');
    expect(page).toContain("<LandingPage slug={SLUG} />");
    expect(page).not.toContain('QueryLandingView');
  });

  it('в тексте нет цен', () => {
    for (const l of LANDING_TEXTS_BATCH3) {
      expect(l.before + l.after, l.slug).not.toMatch(/\d\s?(₽|руб)/);
    }
  });

  it('пользовательский каталог и неподтверждённые числа сняты, ссылки на источники сквозные', () => {
    const all = LANDING_TEXTS_BATCH3.map((l) => l.before + l.after).join('\n');
    expect(all).not.toMatch(/идилесом|idilesom/i);
    expect(text('vulkan-mutnovskij-zakryt')).not.toMatch(/11 конус|30 кратер/);
    for (const l of LANDING_TEXTS_BATCH3) {
      const t = l.before + l.after;
      const listed = (t.split('## Источники')[1] ?? '').match(/^\d+\. /gm)?.length ?? 0;
      const cited = [...t.split('## Источники')[0].matchAll(/\[(\d+)\](?!\()/g)].map((m) => Number(m[1]));
      for (const n of cited) expect(n, `${l.slug} [${n}]`).toBeLessThanOrEqual(listed);
    }
  });

  it('Авачинский — 2751 м по KVERT, без 2741', () => {
    const t = text('voshozhdenie-na-avachinskij-vulkan');
    expect(t).toMatch(/2751/);
    expect(t).not.toMatch(/2741/);
  });

  it('новые страницы связаны: погода ↔ купание ↔ что взять, Мутновский ↔ ЮНЕСКО', () => {
    const links = (slug: string) => text(slug);
    expect(links('pogoda-na-kamchatke-po-mesyacam')).toContain('](/mozhno-li-kupatsya-na-kamchatke)');
    expect(links('pogoda-na-kamchatke-po-mesyacam')).toContain('](/chto-vzyat-s-soboj-na-kamchatku)');
    expect(links('mozhno-li-kupatsya-na-kamchatke')).toContain('](/pogoda-na-kamchatke-po-mesyacam)');
    expect(links('mozhno-li-kupatsya-na-kamchatke')).toContain('](/chto-vzyat-s-soboj-na-kamchatku)');
    expect(links('chto-vzyat-s-soboj-na-kamchatku')).toContain('](/pogoda-na-kamchatke-po-mesyacam)');
    expect(links('chto-vzyat-s-soboj-na-kamchatku')).toContain('](/mozhno-li-kupatsya-na-kamchatke)');
    expect(links('vulkan-mutnovskij-zakryt')).toContain('](/vulkany-kamchatki-yunesko)');
    expect(links('vulkany-kamchatki-yunesko')).toContain('](/places/vulkan-mutnovskij)');
  });

  it('старые страницы по теме ведут на посадочные', () => {
    expect(LANDING_CROSS_LINKS['/park/komandorskiy'].href).toBe('/komandorskie-ostrova-kak-popast');
    expect(LANDING_CROSS_LINKS['/routes/splav-po-reke-bystraya'].href).toBe('/splav-na-kamchatke');
    expect(LANDING_CROSS_LINKS['/articles/vulkany-kamchatki'].href).toBe('/vulkany-kamchatki-yunesko');
    expect(LANDING_CROSS_LINKS['/places/vulkan-avachinskij'].href).toBe('/voshozhdenie-na-avachinskij-vulkan');
    expect(LANDING_CROSS_LINKS['/routes/vulkan-mutnovskiy-874283be'].href).toBe('/places/vulkan-mutnovskij');
    render(<LandingCrossLink path="/park/komandorskiy" />);
    expect(screen.getByRole('link').getAttribute('href')).toBe('/komandorskie-ostrova-kak-popast');
  });

  it('блок туров отбирает по полям тура', () => {
    expect(tourMatchesSpec(tour({ title: 'Сплав по реке Быстрая' }), landingBySlug('splav-na-kamchatke').tours)).toBe(true);
    expect(tourMatchesSpec(tour({ title: 'Морская прогулка' }), landingBySlug('splav-na-kamchatke').tours)).toBe(false);
    expect(tourMatchesSpec(tour({ title: 'Круиз на Командорские острова' }), landingBySlug('komandorskie-ostrova-kak-popast').tours)).toBe(true);
    expect(landingBySlug('raznica-vo-vremeni-kamchatka-moskva').tours.kind).toBe('none');
  });

  it('Article с датой ревизии', () => {
    const ld = landingJsonLd(landingBySlug('splav-na-kamchatke')) as { '@graph': Array<Record<string, unknown>> };
    expect(String(ld['@graph'].find((n) => n['@type'] === 'Article')!.dateModified)).toMatch(/^2026-11-21/);
  });
});
