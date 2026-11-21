/**
 * Посадочные Сыщика, четвёртая партия (21.11, lib/landings/texts-batch4.ts).
 * Держится: 12 новых адресов со своими страницами; цен в тексте нет;
 * пользовательского каталога нет; статус парков — по сводке Минтуризма от
 * 19.11.2026 (сводка 12.11 устарела: «Вилючинский» тоже закрыт); Паратунка —
 * карточка места; страницы партии связаны между собой; Ведар не оператор,
 * заявка — не бронь.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { render, cleanup, screen } from '@testing-library/react';

import { LANDING_TEXTS_BATCH4 } from '@/lib/landings/texts-batch4';
import { landingBySlug, LANDING_CROSS_LINKS } from '@/lib/landings/landings';
import { tourMatchesSpec, type LandingBlockTour } from '@/lib/landings/tours';
import { landingJsonLd } from '@/components/landings/LandingContent';
import { LandingCrossLink } from '@/components/landings/LandingCrossLink';
import { placeClosure } from '@/lib/routes/closures';

afterEach(cleanup);

const NEW = [
  'serfing-na-kamchatke', 'sobachi-upryazhki-kamchatka', 'gonka-beringiya', 'nalychevo-kak-dobratsya',
  'voshozhdenie-na-vulkan-gorelyj', 'klyuchevskaya-sopka-izverzhenie', 'vachkazhets-kak-dobratsya',
  'malkinskie-istochniki-kak-dobratsya', 'zelenovskie-ozerki', 'avachinskij-pereval-i-verblyud',
  'vilyuchinskij-vodopad', 'gde-ostanovitsya-na-kamchatke',
];

const tour = (o: Partial<LandingBlockTour>): LandingBlockTour => ({
  id: '1', slug: 'tur', title: 'Тур', base_price: '10000', price_unit: 'per_person', duration_hours: '8',
  operator_name: 'Оператор', operator_slug: null, operator_public: null,
  season_start: null, season_end: null, next_open_date: null, any_day_open: null, ...o,
});

const text = (slug: string) => { const l = landingBySlug(slug); return l.before + l.after; };

describe('четвёртая партия посадочных', () => {
  it('12 новых адресов со страницами', () => {
    expect(LANDING_TEXTS_BATCH4).toHaveLength(12);
    for (const s of NEW) {
      const l = landingBySlug(s);
      expect(l.type, s).toBe('new');
      expect(l.path, s).toBe(`/${s}`);
      expect(existsSync(join(process.cwd(), 'app', s, 'page.tsx')), s).toBe(true);
    }
  });

  it('в тексте нет цен и пользовательского каталога; ссылки на источники сквозные', () => {
    for (const l of LANDING_TEXTS_BATCH4) {
      const t = l.before + l.after;
      expect(t, l.slug).not.toMatch(/\d\s?(₽|руб)|рубл/);
      expect(t, l.slug).not.toMatch(/идилесом|idilesom/i);
      const listed = (t.split('## Источники')[1] ?? '').match(/^\d+\. /gm)?.length ?? 0;
      const cited = [...t.split('## Источники')[0].matchAll(/\[(\d+)\](?!\()/g)].map((m) => Number(m[1]));
      for (const n of cited) expect(n, `${l.slug} [${n}]`).toBeLessThanOrEqual(listed);
    }
  });

  it('статус парков — по сводке Минтуризма 19.11.2026, без устаревшей 12.11', () => {
    const all = LANDING_TEXTS_BATCH4.map((l) => l.before + l.after).join('\n');
    expect(all).not.toMatch(/12 ноября|12\.11\.2026|kam24\.ru\/news\/main\/20261112/);
    expect(text('nalychevo-kak-dobratsya')).toMatch(/«Вилючинский» и «Ключевской» закрыты на осенний период/);
    expect(text('vilyuchinskij-vodopad')).not.toMatch(/свободно ходить по маршрутам разрешали/);
    expect(text('klyuchevskaya-sopka-izverzhenie')).toContain('visitkamchatka.ru/news/ezhenedelnaya-svodka-o-dostupnosti-turisticheskikh-obektov-19-11/');
    expect(placeClosure('vulkan-klyuchevskaya-sopka')?.text).toMatch(/13\.11\.2026[^.]*зелён/);
  });

  it('высоты совпадают с карточками: Авачинский 2751, Мутновский 2323, Ключевская 4750', () => {
    expect(text('avachinskij-pereval-i-verblyud')).toContain('2751 м');
    expect(text('voshozhdenie-na-vulkan-gorelyj')).toContain('2323 м');
    expect(text('klyuchevskaya-sopka-izverzhenie')).toContain('4750 м');
    const all = LANDING_TEXTS_BATCH4.map((l) => l.before + l.after).join('\n');
    expect(all).not.toMatch(/2741|2322/);
  });

  it('Паратунка — карточка места', () => {
    expect(text('gde-ostanovitsya-na-kamchatke')).toContain('](/places/paratunskaya-zona-otdyha)');
    const all = LANDING_TEXTS_BATCH4.map((l) => l.before + l.after).join('\n');
    expect(all).not.toMatch(/\]\(\/(routes\/)?paratunka\)/);
  });

  it('страницы партии связаны между собой', () => {
    expect(text('nalychevo-kak-dobratsya')).toContain('](/avachinskij-pereval-i-verblyud)');
    expect(text('avachinskij-pereval-i-verblyud')).toContain('](/nalychevo-kak-dobratsya)');
    expect(text('voshozhdenie-na-vulkan-gorelyj')).toContain('](/vilyuchinskij-vodopad)');
    expect(text('vilyuchinskij-vodopad')).toContain('](/voshozhdenie-na-vulkan-gorelyj)');
    expect(text('sobachi-upryazhki-kamchatka')).toContain('](/gonka-beringiya)');
    expect(text('gonka-beringiya')).toContain('](/sobachi-upryazhki-kamchatka)');
    expect(text('malkinskie-istochniki-kak-dobratsya')).toContain('](/zelenovskie-ozerki)');
    expect(text('zelenovskie-ozerki')).toContain('](/malkinskie-istochniki-kak-dobratsya)');
    for (const s of NEW) {
      const linked = NEW.filter((o) => o !== s && text(s).includes(`](/${o})`));
      expect(linked.length, s).toBeGreaterThan(0);
    }
  });

  it('Ведар не оператор и не бронирует: заявка — не бронь', () => {
    const t = text('gde-ostanovitsya-na-kamchatke');
    expect(t).toMatch(/ни туроператором/);
    expect(t).toMatch(/Заявка на Ведаре — не бронь/);
    expect(t).not.toMatch(/Ведар[^.]*\sс бронью/);
  });

  it('старые страницы по теме ведут на посадочные', () => {
    expect(LANDING_CROSS_LINKS['/park/nalychevo'].href).toBe('/nalychevo-kak-dobratsya');
    expect(LANDING_CROSS_LINKS['/places/halaktyrskij-plyazh'].href).toBe('/serfing-na-kamchatke');
    render(<LandingCrossLink path="/park/nalychevo" />);
    expect(screen.getByRole('link').getAttribute('href')).toBe('/nalychevo-kak-dobratsya');
  });

  it('блок туров отбирает по полям тура; у Ключевской и жилья блока нет', () => {
    expect(tourMatchesSpec(tour({ title: 'Восхождение на вулкан Горелый' }), landingBySlug('voshozhdenie-na-vulkan-gorelyj').tours)).toBe(true);
    expect(tourMatchesSpec(tour({ title: 'Морская прогулка' }), landingBySlug('voshozhdenie-na-vulkan-gorelyj').tours)).toBe(false);
    expect(tourMatchesSpec(tour({ title: 'Катание на собачьих упряжках' }), landingBySlug('sobachi-upryazhki-kamchatka').tours)).toBe(true);
    expect(landingBySlug('klyuchevskaya-sopka-izverzhenie').tours.kind).toBe('none');
    expect(landingBySlug('gde-ostanovitsya-na-kamchatke').tours.kind).toBe('none');
  });

  it('Article с датой ревизии', () => {
    const ld = landingJsonLd(landingBySlug('nalychevo-kak-dobratsya')) as { '@graph': Array<Record<string, unknown>> };
    expect(String(ld['@graph'].find((n) => n['@type'] === 'Article')!.dateModified)).toMatch(/^2026-11-21/);
  });
});
