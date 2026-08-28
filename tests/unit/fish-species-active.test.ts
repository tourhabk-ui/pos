import { describe, it, expect } from 'vitest';
import { getActiveSpecies, FISH_SPECIES } from '@/lib/fish-species';

describe('getActiveSpecies — event-driven travel, пилот на рыбе (issue #1421)', () => {
  it('возвращает только виды, у которых месяц входит в seasonMonths', () => {
    for (const species of getActiveSpecies(7)) {
      expect(species.seasonMonths).toContain(7);
    }
  });

  it('лосось не идёт зимой — январь отдаёт только зимние виды (навага, треска), не лосося', () => {
    // Сверено по справочнику: у всех лососёвых (chavycha/nerka/kizuch/gorbuscha/
    // keta) seasonMonths лежат в мае-октябре. Навага и треска — зимние донные
    // виды, у них январь входит в seasonMonths законно.
    const january = getActiveSpecies(1);
    const salmonInJanuary = january.filter(sp =>
      ['chavycha', 'nerka', 'kizuch', 'gorbuscha', 'keta'].includes(sp.id),
    );
    expect(salmonInJanuary).toEqual([]);
  });

  it('месяц вне диапазона 1-12 не находит совпадений, а не падает', () => {
    expect(getActiveSpecies(13)).toEqual([]);
    expect(getActiveSpecies(0)).toEqual([]);
  });

  it('каждый месяц 1-12 отдаёт подмножество реального справочника', () => {
    for (let m = 1; m <= 12; m++) {
      const active = getActiveSpecies(m);
      for (const sp of active) {
        expect(FISH_SPECIES).toContainEqual(sp);
      }
    }
  });
});
