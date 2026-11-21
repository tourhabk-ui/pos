/**
 * Хабы Сыщика (21.11, lib/landings/texts-hubs.ts) и правки к ним.
 * Держится: живые числа подставляются из базы (метки {{…}}), без базы — «—»;
 * в текстах хабов нет цен и пользовательского каталога; числа туров не
 * зашиты; высоты вулканов — одним значением по KVERT; плашка Ключевской;
 * официальные сроки лова лососей; canonical статьи «когда лучше ехать» — хаб.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { LANDING_TEXTS_HUBS } from '@/lib/landings/texts-hubs';
import { LANDING_TEXTS } from '@/lib/landings/texts';
import { LANDING_TEXTS_BATCH2 } from '@/lib/landings/texts-batch2';
import { LANDING_TEXTS_BATCH3 } from '@/lib/landings/texts-batch3';
import { landingBySlug, LANDING_CANONICAL, LANDING_CROSS_LINKS, NEW_LANDINGS } from '@/lib/landings/landings';
import { fillLiveText, landingWithLiveText, pluralRu, type LiveTourRow } from '@/lib/landings/live-text';
import { placeClosure, tourClosure, routeClosure } from '@/lib/routes/closures';
import { SALMON_FISH_IDS, SALMON_OFFICIAL_SEASON } from '@/lib/fish/fish-sources';
import { TOLBACHIK_DIFFICULTY_NOTE } from '@/lib/seo/query-landings';
import { tourBlockNote } from '@/lib/landings/tours';

const rows: LiveTourRow[] = [
  { slug: 'zaporozhets-avacha-voskhozhdenie', activity_type: 'volcano', season_start: '2027-07-01', season_end: '2027-09-30' },
  { slug: 'b', activity_type: 'fishing', season_start: '2027-06-01', season_end: '2027-10-15' },
  { slug: 'c', activity_type: 'fishing', season_start: null, season_end: null },
];

describe('живые числа в тексте', () => {
  it('подставляет число туров, видов, сезон тура и виды', () => {
    expect(fillLiveText('{{tours_total|тур}}, {{tour_kinds|вид}}', rows)).toBe('3 тура, 2 вида');
    expect(fillLiveText('{{tours_total|тур}}', rows, { total: 81 })).toBe('81 тур');
    expect(fillLiveText('{{tours_kind:fishing}} / {{tours_kind:bears}}', rows)).toBe('2 / 0');
    expect(fillLiveText('{{tour_season:zaporozhets-avacha-voskhozhdenie}}', rows)).toBe('1 июля — 30 сентября');
    expect(fillLiveText('{{tour_season:net}}', rows)).toBe('тур сейчас не опубликован');
    expect(fillLiveText('{{tours_month:8|тур}}', rows)).toBe('2 тура');
    expect(fillLiveText('{{top_kinds:1}}', rows)).not.toContain('{{');
  });

  it('без базы — прочерк, а не выдуманное число', () => {
    expect(fillLiveText('{{tours_total|тур}} {{tour_season:x}}', null)).toBe('— —');
  });

  it('склонение', () => {
    expect([1, 2, 5, 11, 21, 22, 25].map((n) => pluralRu(n, 'тур'))).toEqual(['тур', 'тура', 'туров', 'туров', 'тур', 'тура', 'туров']);
  });

  it('после подстановки в хабах не остаётся меток', () => {
    for (const l of LANDING_TEXTS_HUBS) {
      const filled = landingWithLiveText(l, rows, { total: 3 });
      expect(filled.before + filled.after, l.slug).not.toMatch(/\{\{|\}\}/);
    }
  });
});

describe('хабы', () => {
  it('пять хабов; «Как добраться» заменяет текст первой партии под тем же адресом', () => {
    expect(LANDING_TEXTS_HUBS).toHaveLength(5);
    const kd = landingBySlug('kak-dobratsya-na-kamchatku');
    expect(kd.before + kd.after).toBe(LANDING_TEXTS_HUBS.find((h) => h.slug === 'kak-dobratsya-na-kamchatku')!.before + LANDING_TEXTS_HUBS.find((h) => h.slug === 'kak-dobratsya-na-kamchatku')!.after);
    expect(NEW_LANDINGS.filter((l) => l.path === '/kak-dobratsya-na-kamchatku')).toHaveLength(1);
    expect(LANDING_TEXTS.some((t) => t.slug === 'kak-dobratsya-na-kamchatku')).toBe(true);
    expect(existsSync(join(process.cwd(), 'app', 'voshozhdeniya-na-vulkany-kamchatki', 'page.tsx'))).toBe(true);
    expect(landingBySlug('voshozhdeniya-na-vulkany-kamchatki').tours).toEqual({ kind: 'topic', topic: 'volcano' });
  });

  it('без цен, без пользовательского каталога, числа туров не зашиты', () => {
    for (const l of LANDING_TEXTS_HUBS) {
      const t = l.before + l.after;
      expect(t, l.slug).not.toMatch(/\d\s?(₽|руб)/);
      expect(t, l.slug).not.toMatch(/идилесом|idilesom/i);
      expect(t, l.slug).not.toMatch(/\d+ тур(а|ов)? в каталоге/);
    }
    const choose = landingBySlug('kakie-tury-vybrat-na-kamchatke');
    expect(choose.before + choose.after).toContain('{{tours_total|тур}}');
    expect(choose.before + choose.after).not.toMatch(/81 тур/);
  });

  it('canonical статьи «когда лучше ехать» — хаб, и ссылка на хаб', () => {
    expect(LANDING_CANONICAL['/articles/kogda-luchshe-ehat-na-kamchatku']).toBe('/kogda-ehat-na-kamchatku');
    expect(LANDING_CROSS_LINKS['/articles/kogda-luchshe-ehat-na-kamchatku']?.href).toBe('/kogda-ehat-na-kamchatku');
  });
});

describe('высоты одним значением по KVERT', () => {
  it('Мутновский 2323, без 2322; без оговорок 2741 и 3140', () => {
    const all = [...LANDING_TEXTS, ...LANDING_TEXTS_BATCH2, ...LANDING_TEXTS_BATCH3, ...LANDING_TEXTS_HUBS].map((l) => l.before + l.after).join('\n');
    expect(all).not.toContain('2322');
    expect(all).not.toMatch(/2741 м/);
    expect(all).not.toMatch(/3140 м/);
    expect(landingBySlug('vulkan-mutnovskij-zakryt').before + landingBySlug('vulkan-mutnovskij-zakryt').after).toContain('2323');
  });
});

describe('Ключевская Сопка, Толбачик, лосось', () => {
  it('плашка о статусе вулкана — на месте, маршруте и турах', () => {
    const p = placeClosure('vulkan-klyuchevskaya-sopka');
    expect(p?.text).toContain('15');
    expect(p?.text).toContain('12.11.2026');
    expect(routeClosure('vulkan-klyuchevskaya-sopka-413a7499')).toBe(p);
    expect(tourClosure('volcanoesland-voskhozhdenie-klyuchevskaya-sopka')).toBe(p);
    expect(placeClosure('vulkan-avachinskij')).toBeNull();
  });

  it('метки сложности Толбачика объяснены', () => {
    expect(TOLBACHIK_DIFFICULTY_NOTE).toMatch(/разн/);
    expect(tourBlockNote({ kind: 'topic', topic: 'tolbachik' })).toContain(TOLBACHIK_DIFFICULTY_NOTE);
  });

  it('официальные сроки лова — с источниками', () => {
    expect(SALMON_FISH_IDS.has('nerka')).toBe(true);
    expect(SALMON_OFFICIAL_SEASON.text).toContain('5 июля');
    expect(SALMON_OFFICIAL_SEASON.sources.length).toBeGreaterThanOrEqual(2);
  });
});
