/**
 * Сторож трёх исходов у тестов, которые зовут внешнюю программу (аудит 15.10,
 * W3-china). Без python3 сторож моста зеленел, ничего не проверив; теперь
 * вне CI он пропускается с причиной в имени, а в CI падает. Проверяется
 * вызовом на граничных данных, без настоящего отсутствия программы.
 */
import { describe, it, expect } from 'vitest';
import { binaryGate, externalBinary, isCi } from '../helpers/external-binary';

describe('внешняя программа для сторожа: проверить, пропустить с причиной или отказать', () => {
  it('исход по двум фактам', () => {
    expect(binaryGate(true, true)).toBe('run');
    expect(binaryGate(true, false)).toBe('run');
    expect(binaryGate(false, true)).toBe('fail');
    expect(binaryGate(false, false)).toBe('skip');
  });

  it('CI — как его объявляет GitHub Actions', () => {
    expect(isCi({ CI: 'true' })).toBe(true);
    expect(isCi({ CI: '1' })).toBe(true);
    expect(isCi({})).toBe(false);
    expect(isCi({ CI: '' })).toBe(false);
    expect(isCi({ CI: 'false' })).toBe(false);
    expect(isCi({ CI: '0' })).toBe(false);
  });

  it('в CI без программы — отказ с названной причиной, а не тихий зелёный', () => {
    const b = externalBinary('python3', { CI: 'true' }, false);
    expect(b.skip).toBe(false);
    expect(b.title('мост')).toBe('мост');
    expect(() => b.require('имя клиента моста')).toThrow(/python3 не найден в CI: имя клиента моста не проверить/);
  });

  it('вне CI без программы — пропуск, и причина в имени теста', () => {
    const b = externalBinary('jq', {}, false);
    expect(b.skip).toBe(true);
    expect(b.title('сводка')).toMatch(/^сводка \[пропуск вне CI: jq не найден/);
    expect(() => b.require('сводку')).not.toThrow();
  });

  it('программа есть — проверка идёт и в CI, и вне его', () => {
    for (const env of [{ CI: 'true' }, {}]) {
      const b = externalBinary('python3', env, true);
      expect(b.skip).toBe(false);
      expect(b.title('мост')).toBe('мост');
      expect(() => b.require('мост')).not.toThrow();
    }
  });
});
