import { describe, it, expect } from 'vitest';
import {
  ELEMENT_GROUPS,
  EXCLUDED_TYPES,
  groupPlacesByElement,
  allElementTypes,
  knownLocationTypes,
  elementHref,
} from '@/lib/stats/element-groups';

describe('ELEMENT_GROUPS — маппинг выверен против реальных location_type', () => {
  it('ни одного фантомного типа: всё объявленное известно в LOCATION_TYPE_LABELS', () => {
    const known = new Set(knownLocationTypes());
    for (const t of allElementTypes()) {
      expect(known.has(t), `фантомный тип в стихиях: «${t}»`).toBe(true);
    }
  });

  it('каждый известный тип — РОВНО в одной стихии XOR в EXCLUDED (ничего не теряется молча)', () => {
    const inElement = new Set(allElementTypes());
    const inExcluded = new Set(EXCLUDED_TYPES);
    for (const t of knownLocationTypes()) {
      const a = inElement.has(t);
      const b = inExcluded.has(t);
      expect(a !== b, `тип «${t}»: должен быть либо в стихии, либо в EXCLUDED, ровно одно (a=${a}, b=${b})`).toBe(true);
    }
  });

  it('один тип не объявлен в двух стихиях', () => {
    const all = allElementTypes();
    expect(all.length).toBe(new Set(all).size);
  });

  it('стихий пять, у каждой непустой href', () => {
    expect(ELEMENT_GROUPS).toHaveLength(5);
    for (const g of ELEMENT_GROUPS) expect(g.href).toMatch(/^\/routes\?location_type=/);
  });
});

describe('groupPlacesByElement — сумма сходится', () => {
  it('Σ(стихии) + excluded == Σ(вход); unmappedTypes пуст при известных типах', () => {
    const byType: Record<string, number> = {};
    knownLocationTypes().forEach((t, i) => { byType[t] = i + 1; });
    const { elements, excludedCount, unmappedTypes } = groupPlacesByElement(byType);
    const total = Object.values(byType).reduce((s, n) => s + n, 0);
    const elemSum = elements.reduce((s, e) => s + e.count, 0);
    expect(unmappedTypes).toEqual([]);
    expect(elemSum + excludedCount).toBe(total);
  });

  it('неизвестный тип попадает в unmappedTypes (сигнал рассинхрона)', () => {
    const { unmappedTypes } = groupPlacesByElement({ dragon_lair: 5, volcano: 2 });
    expect(unmappedTypes).toEqual(['dragon_lair']);
  });

  it('пустые стихии не показываются', () => {
    const { elements } = groupPlacesByElement({ volcano: 3 });
    expect(elements.map((e) => e.key)).toEqual(['fire']);
  });

  it('стихия суммирует все свои типы', () => {
    const { elements } = groupPlacesByElement({ bay: 2, cape: 1, island: 3, beach: 4 });
    const ocean = elements.find((e) => e.key === 'ocean');
    expect(ocean?.count).toBe(10);
  });

  it('elementHref ведёт в location_type-фильтр, а не category', () => {
    expect(elementHref('snow')).toBe('/routes?location_type=mountain');
    expect(elementHref('ocean')).toBe('/routes?location_type=bay');
    expect(elementHref('nature')).toBe('/routes?location_type=lake');
    expect(elementHref('unknown')).toBe('/routes');
  });
});
