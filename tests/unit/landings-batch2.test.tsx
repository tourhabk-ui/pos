/**
 * Посадочные Сыщика, вторая партия (21.11, lib/landings/texts-batch2.ts).
 * Держится: 10 новых адресов со своими страницами; блок туров из базы, цен
 * и сезонов туров в тексте нет; факты, которые не подтвердились, сняты;
 * старые страницы по теме ведут на посадочные.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { render, cleanup, screen } from '@testing-library/react';

import { LANDING_TEXTS_BATCH2 } from '@/lib/landings/texts-batch2';
import { landingBySlug, LANDING_CROSS_LINKS } from '@/lib/landings/landings';
import { tourMatchesSpec, type LandingBlockTour } from '@/lib/landings/tours';
import { landingJsonLd } from '@/components/landings/LandingContent';
import { LandingCrossLink } from '@/components/landings/LandingCrossLink';

afterEach(cleanup);

const SLUGS = [
  'chto-privezti-s-kamchatki', 'gornolyzhnye-bazy-kamchatki', 'heli-ski-kamchatka', 'kamchatskaya-kukhnya-gde-poest',
  'nepogoda-otmenili-vertolet', 'novyj-god-na-kamchatke', 'propusk-ustoj-m-vilyuchinskij-pereval',
  'putevka-na-rybalku-gosuslugi41', 'stoit-li-ekhat-na-kamchatku', 'tolbachik-samostoyatelno',
];

const tour = (o: Partial<LandingBlockTour>): LandingBlockTour => ({
  id: '1', slug: 'tur', title: 'Тур', base_price: '10000', price_unit: 'per_person', duration_hours: '8',
  operator_name: 'Оператор', operator_slug: null, operator_public: null,
  season_start: null, season_end: null, next_open_date: null, any_day_open: null, ...o,
});

describe('вторая партия посадочных', () => {
  it('10 новых адресов, у каждого страница и блок туров', () => {
    expect(LANDING_TEXTS_BATCH2.map((l) => l.slug).sort()).toEqual(SLUGS);
    for (const s of SLUGS) {
      const l = landingBySlug(s);
      expect(l.type, s).toBe('new');
      expect(l.path, s).toBe(`/${s}`);
      expect(existsSync(join(process.cwd(), 'app', s, 'page.tsx')), s).toBe(true);
      expect(l.tours.kind, s).not.toBe('none');
    }
  });

  it('в тексте нет цен и сезонов туров: они только в блоке из базы', () => {
    for (const l of LANDING_TEXTS_BATCH2) {
      const t = l.before + l.after;
      expect(t, l.slug).not.toMatch(/\d\s?(₽|руб)/);
      expect(t, l.slug).not.toMatch(/\|\s*\d{2}\.\d{2}\.\d{4}\s*—/);
      expect(t, l.slug).not.toMatch(/с сезоном \d/);
    }
  });

  it('снятое при сверке с источниками не вернулось', () => {
    const all = LANDING_TEXTS_BATCH2.map((l) => l.before + l.after).join('\n');
    // Плоский Толбачик — 3085 м по KVERT ИВиС ДВО РАН (3140 — только как оговорка про Википедию).
    expect(landingBySlug('tolbachik-samostoyatelno').before).toMatch(/высотой 3085 м/);
    expect(all).not.toMatch(/73 га/);
    expect(all).not.toMatch(/семи чудес/);
    // Банкет 7-дневного тура: у оператора — доплата, обязателен при датах на 31.12.
    expect(landingBySlug('novyj-god-na-kamchatke').after).toMatch(/банкет не входит в стоимость/);
  });

  it('блок туров отбирает по полям тура', () => {
    expect(tourMatchesSpec(tour({ title: 'Новогодние вулканы Камчатки' }), landingBySlug('novyj-god-na-kamchatke').tours)).toBe(true);
    expect(tourMatchesSpec(tour({ title: 'К гамулам на Вилючинский перевал' }), landingBySlug('propusk-ustoj-m-vilyuchinskij-pereval').tours)).toBe(true);
    expect(tourMatchesSpec(tour({ title: 'Морская прогулка' }), landingBySlug('propusk-ustoj-m-vilyuchinskij-pereval').tours)).toBe(false);
  });

  it('Article с датой ревизии и FAQPage', () => {
    const putevka = landingBySlug('putevka-na-rybalku-gosuslugi41');
    const ld = landingJsonLd(putevka) as { '@graph': Array<Record<string, unknown>> };
    expect(String(ld['@graph'].find((n) => n['@type'] === 'Article')!.dateModified)).toMatch(new RegExp('^' + putevka.date));
    expect(ld['@graph'].some((n) => n['@type'] === 'FAQPage')).toBe(true);
  });

  it('перелинковка: зима → Новый год, хаб рыбалки → путёвка, перевал и парк → пропуск', () => {
    expect(LANDING_CROSS_LINKS['/articles/zima'].href).toBe('/novyj-god-na-kamchatke');
    expect(LANDING_CROSS_LINKS['/hub/fishing'].href).toBe('/putevka-na-rybalku-gosuslugi41');
    for (const p of ['/places/vilyuchinskij-pereval', '/routes/vilyuchinskij-pereval-marshrut', '/park/vilyuchinsky']) {
      expect(LANDING_CROSS_LINKS[p].href, p).toBe('/propusk-ustoj-m-vilyuchinskij-pereval');
    }
    render(<LandingCrossLink path="/park/vilyuchinsky" />);
    expect(screen.getByRole('link').getAttribute('href')).toBe('/propusk-ustoj-m-vilyuchinskij-pereval');
  });
});
