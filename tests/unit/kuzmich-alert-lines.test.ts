// @vitest-environment node
/**
 * Зоны предупреждения в контексте Кузьмича — именами, не слагами (15.10).
 *
 * Слаг («avachinsky», «krai_commander») — ключ кода, и модель могла повторить
 * его человеку. Вызовом функции строки: имена зон из того же словаря, что у
 * ленты /safety; уровень и описание — как прежде.
 */
import { describe, it, expect } from 'vitest';
import { alertContextLine } from '@/lib/kuzmich/alert-lines';
import { zoneName } from '@/lib/safety/zone-names';

describe('строка предупреждения для Кузьмича', () => {
  it('зоны — именами, ни одного слага', () => {
    const line = alertContextLine({
      title: 'Росгидромет: ветер — жёлтый уровень (юг края)',
      description: 'в прибрежных районах местами 15-20 м/с',
      severity: 1,
      affected_zones: ['avachinsky', 'eastern', 'western', 'northern', 'krai_commander'],
    });
    expect(line).toContain(`(${['avachinsky', 'eastern', 'western', 'northern', 'krai_commander'].map(zoneName).join(', ')})`);
    expect(line).toContain('Командорские острова');
    expect(line).not.toMatch(/avachinsky|krai_commander|northern/);
    expect(line.startsWith('[INFO] Росгидромет: ветер')).toBe(true);
    expect(line).toContain(': в прибрежных районах местами 15-20 м/с');
  });

  it('без зон — без скобок; уровень по важности', () => {
    expect(alertContextLine({ title: 'Цунами', description: null, severity: 3, affected_zones: [] })).toBe('[ОПАСНОСТЬ] Цунами');
    expect(alertContextLine({ title: 'Ветер', description: null, severity: 2, affected_zones: null })).toBe('[ВНИМАНИЕ] Ветер');
  });
});
