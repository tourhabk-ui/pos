/**
 * Ревью безопасности #3690 (22.11): план судил, касается ли сводка его зон,
 * по догадке из названия места — и прятал тревогу, которая его касается.
 *
 *  1) сводка о дороге «Начикинский совхоз — Усть-Большерецк» записана лентой
 *     на Западную и Авачинскую (`affected_zones`), а по имени — только
 *     Западная: из авачинского плана она пропадала, и с его дня тоже;
 *  2) правка дат (plan-safety-refresh) показывала сводку без фильтра —
 *     один план говорил по-разному до и после правки;
 *  3) шапка /trip переворачивала `hasAlert: true` в зелёную галочку «сводок
 *     нет», когда заголовок не называл зону плана: землетрясение на севере
 *     «… км от Петропавловска» читалось как авачинское.
 *
 * Только вызовы функций; без базы, LLM и ПД.
 */
import { describe, it, expect } from 'vitest';
import {
  alertTouchesPlanZones, planHeaderStatus, PLAN_HEADER_NO_MATCH, recordedPlanZones,
} from '@/lib/safety/place-zones';
import {
  notesForPlanDay, warningDigest, warningsForPlanZones, warningsFromRows, type AlertWarningRow,
} from '@/lib/safety/mchs-bulletin';
import { refreshDatedSafety } from '@/lib/planner/plan-safety-refresh';
import { planSafetyScope } from '@/lib/planner/official-alerts';
import type { DayPlan } from '@/lib/planner/engine';

const NOW = Date.parse('2026-11-22T00:00:00Z');

const ROAD: AlertWarningRow = {
  alert_type: 'road_closure',
  title: 'Закрыт участок автодороги Начикинский совхоз — село Усть-Большерецк',
  description: 'Ограничено движение на участке Начикинский совхоз — Усть-Большерецк из-за метели.',
  source_url: 'https://vk.com/wall-45534680_1', external_id: 'vk_mchs/2026-11-22/r1',
  expires_iso: '2026-11-30T00:00:00Z', published_iso: '2026-11-22T00:00:00Z',
  affected_zones: ['western', 'avachinsky'],
};
const KLYUCH: AlertWarningRow = {
  alert_type: 'volcanic_eruption', title: 'Вулкан Ключевской: не приближаться', volcano_name: 'Ключевской',
  description: 'Не приближаться к вулкану Ключевской.', source_url: 'https://vk.com/wall-45534680_2',
  external_id: 'vk_mchs/2026-11-22/v1', expires_iso: '2026-11-30T00:00:00Z', published_iso: '2026-11-22T00:00:00Z',
  affected_zones: ['northern'],
};

const day = (over: Partial<DayPlan>): DayPlan => ({
  day: 1, type: 'activity' as DayPlan['type'], zone: 'avachinsky', title: 'Малкинские источники',
  description: '', activityType: 'hot_spring', priceFrom: 0, priceTo: 0,
  coords: [53.25, 158.75], defaultTransport: 'jeep' as DayPlan['defaultTransport'],
  allowedTransports: ['jeep'] as DayPlan['allowedTransports'], difficulty: 'easy' as DayPlan['difficulty'],
  childFriendly: true, minChildAge: 0, dayWarnings: [],
  ...over,
});

describe('зона сводки — та, что записала лента', () => {
  const ws = warningsFromRows([ROAD, KLYUCH], NOW);
  const road = ws.find((w) => w.kind === 'road')!;

  it('районы ленты доходят до предупреждения', () => {
    expect(road.zones).toEqual(['western', 'avachinsky']);
  });

  it('дорога, записанная на Авачинскую, остаётся в авачинском плане и на его дне', () => {
    expect(warningsForPlanZones(ws, ['avachinsky']).map((w) => w.kind)).toEqual(['road']);
    expect(notesForPlanDay('Малкинские источники', ['avachinsky'], ws)).toHaveLength(1);
  });

  it('вулкан чужой зоны по-прежнему не пишется', () => {
    expect(warningsForPlanZones(ws, ['avachinsky']).some((w) => w.place === 'Ключевской')).toBe(false);
    expect(warningsForPlanZones(ws, ['northern']).some((w) => w.place === 'Ключевской')).toBe(true);
  });

  it('повтор места объединяет районы', () => {
    const merged = warningsFromRows([{ ...ROAD, affected_zones: ['western'] }, { ...ROAD, affected_zones: ['avachinsky'] }], NOW);
    expect(merged).toHaveLength(1);
    expect(merged[0].zones?.sort()).toEqual(['avachinsky', 'western']);
  });

  it('место, названное в тексте дня, остаётся — без учёта регистра и «ё»', () => {
    const kept = warningsForPlanZones(ws, ['avachinsky'], ['ОБЛЁТ: вулкан КЛЮЧЕВСКОЙ с воздуха']);
    expect(kept.some((w) => w.place === 'Ключевской')).toBe(true);
  });

  it('зон нет — судит название; метки охвата переводятся в зоны планера', () => {
    expect(recordedPlanZones([])).toBeNull();
    expect(recordedPlanZones(['krai_koryak'])).toBeNull();
    expect(recordedPlanZones(['krai_south'])).toEqual(expect.arrayContaining(['southern', 'avachinsky', 'western']));
    expect(alertTouchesPlanZones(null, 'Вулкан Ключевской', ['avachinsky'])).toBe(false);
    expect(alertTouchesPlanZones([], 'Штормовое предупреждение', ['avachinsky'])).toBe(true);
    // День южной зоны получает и тревоги Западной (alertZonesOf).
    expect(alertTouchesPlanZones(['western'], 'Курильское озеро', ['southern'])).toBe(true);
  });
});

describe('правка дат судит сводки так же, как первая сборка плана', () => {
  it('сводка о чужом вулкане в итог правки не попадает, дорога зоны — попадает', async () => {
    const ws = warningsFromRows([ROAD, KLYUCH], NOW);
    const days = [day({ day: 1 }), day({ day: 2, title: 'Паратунка' })];
    const { warnings } = await refreshDatedSafety(days, '2026-11-24', [], true, {
      loadWarnings: async () => ({ ok: true, warnings: ws }),
      parkQuery: async <T,>() => ({ rows: [] as T[] }),
    });
    const scope = planSafetyScope(days);
    const expected = warningDigest(warningsForPlanZones(ws, scope.zones, scope.texts));
    expect(expected).toBeTruthy();
    expect(warnings).toContain(expected);
    expect(warnings.join('\n')).not.toMatch(/Ключевск/);
  });
});

describe('шапка /trip: тревога остаётся тревогой', () => {
  const quake = 'Землетрясение ML 5.1 — 420 км от Петропавловска-Камчатского';

  it('северный эпицентр с заголовком «от Петропавловска» — по зонам ленты, для северного плана', () => {
    const payload = { data: { hasAlert: true, topTitle: quake, topZones: ['northern'], feedTitles: [], feedZones: [] } };
    expect(planHeaderStatus(payload, ['northern'])).toEqual({ title: quake, hasAlert: true });
  });

  it('совпадения нет — значок тревоги и честные слова, не зелёная галочка', () => {
    const payload = { data: { hasAlert: true, topTitle: quake, topZones: ['northern'], feedTitles: [], feedZones: [] } };
    expect(planHeaderStatus(payload, ['avachinsky'])).toEqual({ title: PLAN_HEADER_NO_MATCH, hasAlert: true });
  });

  it('пункт ленты, который заголовком называет один округ, а районами — зону плана', () => {
    const payload = { data: {
      hasAlert: true, topTitle: null,
      feedTitles: ['Штормовое предупреждение в Усть-Большерецком районе'],
      feedZones: [['western', 'avachinsky']],
    } };
    expect(planHeaderStatus(payload, ['avachinsky'])?.title).toBe('Штормовое предупреждение в Усть-Большерецком районе');
  });

  it('тревог нет — спокойно; источник недоступен — блока нет', () => {
    expect(planHeaderStatus({ data: { hasAlert: false, topTitle: null, feedTitles: [] } }, ['avachinsky']))
      .toEqual({ title: null, hasAlert: false });
    expect(planHeaderStatus({ data: { unavailable: true, hasAlert: false } }, ['avachinsky'])).toBeNull();
    expect(planHeaderStatus(null, ['avachinsky'])).toBeNull();
  });
});
