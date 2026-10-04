/**
 * «Южная половина края» = юг Камчатки до Петропавловска (решение владельца
 * 04.10, #2195). С 29.09 такие предупреждения ложились без зон и не доходили
 * ни до одного места. Охват по широте исполняет
 * tests/integration/alert-place-scope.pg.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { mchs_zones } from '@/lib/services/safety/seismic-parser';
import { KRAI_SOUTH_MAX_LAT, KRAI_SOUTH_ZONE, namesKraiSouth } from '@/lib/safety/krai-south';
import { zoneName } from '@/lib/safety/zone-names';
import { matchOfficialAlerts } from '@/lib/agents/evo/rescue-judge';

describe('разбор фразы', () => {
  it('формы «юга края» получают метку юга', () => {
    for (const t of [
      'Прогнозируется подъем уровней воды на реках южной половины края',
      'В южной части Камчатского края ожидается сильный дождь',
      'На юге Камчатки возможны подтопления',
    ]) expect(mchs_zones(t), t).toEqual([KRAI_SOUTH_ZONE]);
  });

  it('юг края побеждает «по краю»: часть, а не весь', () => {
    expect(mchs_zones('По Камчатскому краю: подъём воды на реках южной половины края')).toEqual([KRAI_SOUTH_ZONE]);
  });

  it('названный округ точнее «юга»', () => {
    expect(mchs_zones('Подъём воды на реках южной половины края, в Усть-Большерецком округе')).toEqual(['western']);
  });

  it('«Южно-Камчатский парк» и северная половина — не юг края', () => {
    expect(namesKraiSouth('Закрыт природный парк Южно-Камчатский')).toBe(false);
    expect(namesKraiSouth('На реках северной половины края')).toBe(false);
  });

  it('граница — северная окраина Петропавловска: город внутри, Елизово снаружи', () => {
    expect(KRAI_SOUTH_MAX_LAT).toBeGreaterThanOrEqual(53.02);
    expect(KRAI_SOUTH_MAX_LAT).toBeLessThan(53.19);
  });
});

describe('приём лечит запись, лежавшую без зон', () => {
  it('UPDATE переписывает пустые зоны, если сегодня разбор их узнал', () => {
    const src = readFileSync('lib/services/safety/seismic-parser.ts', 'utf8');
    expect(src).toMatch(/cardinality\(external_alerts\.affected_zones\) = 0 AND cardinality\(\$6::text\[\]\) > 0/);
  });
});

describe('метка юга у читателей зон', () => {
  it('экран /safety называет её словами, а не ключом', () => {
    expect(zoneName(KRAI_SOUTH_ZONE)).toBe('Юг Камчатки до Петропавловска');
  });

  it('Rescue: паводок «юга края» доходит до водного тура как неразмещённый, а не мимо', () => {
    const booking = {
      id: 7, booking_date: '2026-10-05', tour_title: 'Сплав по Паратунке', participants: 4,
      activity_type: 'rafting', location_type: 'river', zone: 'avachinsky',
    };
    const alert = {
      id: 1, alert_type: 'flood', severity: 2, title: 'Подъём воды на реках южной половины края',
      description: '', affected_zones: [KRAI_SOUTH_ZONE],
      expires_at: '2026-10-06T00:00:00Z', source_url: 'https://x',
    };
    const r = matchOfficialAlerts([booking] as never, [alert] as never);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].unplaced).toBe(true);
  });
});
