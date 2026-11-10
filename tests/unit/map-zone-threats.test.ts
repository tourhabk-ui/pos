/**
 * tests/unit/map-zone-threats.test.ts
 *
 * «Угрозы по районам» на карте (#2930): правило разбивки — вызовом на
 * граничных данных. Что держит:
 *  - район — как в сводке; без района — строкой «не указан», не во все районы;
 *  - все четыре зоны — «по всему краю», не четыре копии;
 *  - метка охвата (Командоры) — своей строкой, только когда названа;
 *  - лента не прочиталась или пришла без районов — все районы «неизвестно»,
 *    ни один не тихий;
 *  - оценка зоны — рядом, состояния не меняет; не прочиталась — не «норма».
 */
import { describe, it, expect } from 'vitest';
import { mapZoneThreats, districtStateLine, type FeedPayload } from '@/lib/safety/map-zone-threats';

const FEED: FeedPayload = {
  feedCount: 6,
  feedTitles: [
    'Штормовое предупреждение: ветер до 25 м/с',
    'Халактырский пляж: дорога перекрыта',
    'Медведи у посёлка Термальный',
    'Шторм по всему краю',
    'Волнение у Командорских островов',
  ],
  feedZones: [
    ['eastern', 'avachinsky'],
    ['avachinsky'],
    [],
    ['avachinsky', 'eastern', 'western', 'northern', 'krai_koryak'],
    ['krai_commander', 'zone_without_name'],
  ],
};

const DANGER = { ok: true, zones: [{ zone: 'avachinsky', risk_level: 'moderate' }, { zone: 'northern', risk_level: 'low' }] };

describe('разбивка ленты по районам', () => {
  const t = mapZoneThreats(FEED, DANGER);
  const d = (zone: string) => t.districts.find((x) => x.zone === zone)!;

  it('пункт — в каждом названном районе; четыре базовых района всегда в списке', () => {
    expect(t.districts.slice(0, 4).map((x) => x.zone)).toEqual(['avachinsky', 'eastern', 'western', 'northern']);
    expect(d('avachinsky').alerts).toEqual(['Штормовое предупреждение: ветер до 25 м/с', 'Халактырский пляж: дорога перекрыта']);
    expect(d('eastern').alerts).toEqual(['Штормовое предупреждение: ветер до 25 м/с']);
    expect(d('avachinsky').state).toBe('alert');
  });

  it('без района — строкой «не указан», а не во все районы', () => {
    expect(t.unzoned).toEqual(['Медведи у посёлка Термальный']);
    expect(t.districts.some((x) => x.alerts.includes('Медведи у посёлка Термальный'))).toBe(false);
  });

  it('все четыре зоны — «по всему краю», без копий по районам', () => {
    expect(t.kraiWide).toEqual(['Шторм по всему краю']);
    expect(t.districts.some((x) => x.alerts.includes('Шторм по всему краю'))).toBe(false);
  });

  it('метка охвата — своей строкой, только названная; незнакомый слаг не показывается', () => {
    expect(d('krai_commander')).toMatchObject({ name: 'Командорские острова', state: 'alert', alerts: ['Волнение у Командорских островов'] });
    expect(t.districts.some((x) => x.zone === 'zone_without_name')).toBe(false);
    expect(t.districts.some((x) => x.zone === 'krai_south')).toBe(false);
  });

  it('район без пунктов — «тревог в ленте нет», а не «безопасно»; оценка рядом', () => {
    expect(d('western')).toMatchObject({ state: 'quiet', alerts: [], risk: null });
    expect(districtStateLine(d('western'))).toBe('тревог в ленте нет');
    expect(d('northern')).toMatchObject({ state: 'quiet', risk: 'Норма' });
    expect(d('avachinsky').risk).toBe('Повышенная');
  });

  it('лента длиннее показанного — остаток назван', () => {
    expect(t.more).toBe(1);
  });
});

describe('третий исход: не знаем — ни один район не тихий', () => {
  it.each([
    ['источник недоступен', { unavailable: true } as FeedPayload],
    ['ленты нет (не прочиталась)', { feedTitles: null, feedZones: null, feedCount: null } as FeedPayload],
    ['лента без районов (старый ответ)', { feedTitles: ['Шторм'], feedCount: 1 } as FeedPayload],
    ['районы не той длины', { feedTitles: ['Шторм', 'Пепел'], feedZones: [['eastern']], feedCount: 2 } as FeedPayload],
    ['ответа нет', null],
  ])('%s', (_name, payload) => {
    const t = mapZoneThreats(payload, DANGER);
    expect(t.feedKnown).toBe(false);
    expect(t.districts.map((x) => x.state)).toEqual(['unknown', 'unknown', 'unknown', 'unknown']);
    expect(districtStateLine(t.districts[0])).toMatch(/^неизвестно/);
    expect(t.more).toBe(0);
  });

  it('оценка зон не прочиталась — не «норма»', () => {
    const t = mapZoneThreats(FEED, { ok: false, zones: [] });
    expect(t.riskKnown).toBe(false);
    expect(t.districts.every((x) => x.risk === null)).toBe(true);
    expect(mapZoneThreats(FEED, null).riskKnown).toBe(false);
  });

  it('пустая лента при живом источнике — все районы «тревог в ленте нет»', () => {
    const t = mapZoneThreats({ feedTitles: [], feedZones: [], feedCount: 0 }, DANGER);
    expect(t.feedKnown).toBe(true);
    expect(t.districts.map((x) => x.state)).toEqual(['quiet', 'quiet', 'quiet', 'quiet']);
  });
});
