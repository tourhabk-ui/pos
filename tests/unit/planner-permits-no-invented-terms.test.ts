/**
 * Разрешения зон в плане — без сроков оформления, у которых нет источника
 * (#3552 п.6, слово владельца 20.11 «карт-бланш»).
 *
 * До 20.11 турист читал критическим предупреждением «Оформление за 30 дней»
 * (Кроноцкий, погранзона) и «за 14 дней» (Курильское озеро), а у чисел в коде
 * не было ни источника, ни даты (§4.0). Требование разрешения остаётся;
 * сопровождение сотрудником заповедника — по его правилам, со ссылкой.
 */
import { describe, it, expect } from 'vitest';
import { zonePermitWarnings } from '@/lib/planner/engine';
import { ACTIVITY_CONSTRAINTS } from '@/lib/planner';
import { KRONOKI_RULES_URL } from '@/lib/seo/query-landings';

const NO_TERM = /\bза\s+\d+\s+(дн|сут|недел)/i;

describe('разрешения зон в плане', () => {
  it('зона плана — критично, разрешение названо, срока-числа нет', () => {
    const w = zonePermitWarnings(new Set(['northern', 'southern', 'eastern']), []);
    expect(w).toHaveLength(3);
    expect(w.every((x) => x.type === 'permit' && x.severity === 'critical')).toBe(true);
    for (const x of w) {
      expect(x.message).not.toMatch(NO_TERM);
      expect(x.message).toContain('Срок оформления у нас не записан');
    }
    expect(w[0]!.message).toContain('Кроноцкий государственный заповедник');
    expect(w[0]!.message).toContain(KRONOKI_RULES_URL);
    expect(w[1]!.message).toContain('Курильского озера');
  });

  it('зона вне плана — одна справочная строка, тоже без сроков', () => {
    const w = zonePermitWarnings(new Set(['avachinsky']), ['avachinsky', 'eastern', 'northern']);
    expect(w).toEqual([{
      type: 'permit', severity: 'info',
      message: 'Если захотите добавить зоны, которых нет в этом плане, им нужны свои разрешения: '
        + 'Восточная зона — Пограничная зона ФСБ; Северная зона — Кроноцкий государственный заповедник.',
    }]);
  });

  it('у занятий требование разрешения без выдуманного срока', () => {
    for (const c of Object.values(ACTIVITY_CONSTRAINTS)) {
      if (c.requiresPermit) expect(c.requiresPermit).not.toMatch(NO_TERM);
    }
  });
});
