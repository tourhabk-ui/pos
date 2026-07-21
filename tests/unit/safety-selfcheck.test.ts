/**
 * Юнит-тесты синтетической safety-проверки — детерминированное ядро (без БД).
 * Это страховка страховки: если SOS-детектор или экстренные номера сломают,
 * красный тест в CI не даст смержить регресс, который лишил бы туриста в ЧП 112.
 */
import { describe, it, expect } from 'vitest';
import { runDeterministicSafetyChecks } from '@/lib/safety/safety-selfcheck';
import { withSosBlock } from '@/lib/safety/sos-detector';

describe('safety self-check — детерминированное ядро', () => {
  const checks = runDeterministicSafetyChecks();

  it('возвращает три критических проверки', () => {
    expect(checks).toHaveLength(3);
    expect(checks.every((c) => c.level === 'critical')).toBe(true);
  });

  it('все критические инварианты пройдены', () => {
    const failed = checks.filter((c) => !c.pass);
    expect(failed, failed.map((c) => `${c.id}: ${c.detail}`).join('; ')).toHaveLength(0);
  });

  it('SOS-проверка ловит выдачу 112 на ЧП', () => {
    const c = checks.find((c) => c.id === 'sos_fires_on_emergency');
    expect(c?.pass).toBe(true);
  });

  it('SOS-проверка не даёт ложных тревог на бытовых', () => {
    const c = checks.find((c) => c.id === 'sos_silent_on_benign');
    expect(c?.pass).toBe(true);
  });

  it('экстренные номера канон (112 первичный)', () => {
    const c = checks.find((c) => c.id === 'emergency_numbers_canonical');
    expect(c?.pass).toBe(true);
  });
});

describe('safety self-check — прямой инвариант SOS', () => {
  it('ЧП про медведя добавляет 112 и МЧС', () => {
    const r = withSosBlock('Спасибо за вопрос.', 'на меня вышел медведь, он рядом');
    expect(r.emergency).toBe(true);
    expect(r.text).toMatch(/(?<!\d)112(?!\d)/);
    expect(r.text).toMatch(/мчс/i);
  });

  it('бытовой вопрос про цену не триггерит SOS', () => {
    const r = withSosBlock('Тур стоит 11200 рублей.', 'сколько стоит тур на Авачинский');
    expect(r.emergency).toBe(false);
  });
});
