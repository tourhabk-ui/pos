/**
 * Совет Кузьмича «сегодня здесь» — детерминированный, из данных.
 *
 * Проактивная замена пассивному блоку «спросить». Функция safety-критична:
 * турист решает идти/не идти по её тону. Сторож держит честность: красный
 * вулкан → danger «нельзя», устаревший КВЕРТ понижает уверенность (не молчит
 * зелёным), нет данных → честное «сверься», а не выдуманное «спокойно».
 */
import { describe, it, expect } from 'vitest';
import { buildPlaceAdvisory, type AdvisoryInput } from '@/lib/kuzmich/place-advisory';

const NOW = new Date('2026-08-02T12:00:00Z').getTime();
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const base: AdvisoryInput = { volcano: null, realtime: null, hazardTypes: [] };

describe('тон по обстановке', () => {
  it('красный вулкан → danger «нельзя»', () => {
    const a = buildPlaceAdvisory({ ...base, volcano: { colorCode: 'red', observedAt: daysAgo(1) } }, NOW);
    expect(a.tone).toBe('danger');
    expect(a.headline).toMatch(/нет/i);
    expect(a.lines[0]).toMatch(/красный/);
  });
  it('зелёный свежий → ok «спокойно»', () => {
    const a = buildPlaceAdvisory({ ...base, volcano: { colorCode: 'green', observedAt: daysAgo(1) } }, NOW);
    expect(a.tone).toBe('ok');
    expect(a.headline).toMatch(/спокойно/i);
  });
  it('оранжевый → caution', () => {
    expect(buildPlaceAdvisory({ ...base, volcano: { colorCode: 'orange', observedAt: daysAgo(1) } }, NOW).tone).toBe('caution');
  });
  it('реалтайм-алерт severity≥2 → danger', () => {
    const a = buildPlaceAdvisory({ ...base, realtime: { isOpen: true, activeAlerts: ['Сход селя'], alertSeverity: 3 } }, NOW);
    expect(a.tone).toBe('danger');
    expect(a.lines.join(' ')).toMatch(/Сход селя/);
  });
});

describe('честность (safety-инвариант)', () => {
  it('устаревший КВЕРТ понижает уверенность даже у зелёного', () => {
    const a = buildPlaceAdvisory({ ...base, volcano: { colorCode: 'green', observedAt: daysAgo(30) } }, NOW);
    expect(a.tone).toBe('caution'); // не ok — данные старые
    expect(a.lines[0]).toMatch(/не обновлялись/);
    expect(a.lines[0]).toMatch(/сверься на KVERT/);
  });
  it('нет живых данных → unknown, честное «сверься», не выдуманное «спокойно»', () => {
    const a = buildPlaceAdvisory(base, NOW);
    expect(a.tone).toBe('unknown');
    expect(a.headline).toMatch(/нет/i);
    expect(a.lines.join(' ')).toMatch(/сверься/);
    expect(a.lines.join(' ')).not.toMatch(/спокойно/);
  });
  it('закрыто сейчас → caution + строка', () => {
    const a = buildPlaceAdvisory({ ...base, realtime: { isOpen: false, activeAlerts: null, alertSeverity: null } }, NOW);
    expect(a.tone).toBe('caution');
    expect(a.lines.join(' ')).toMatch(/закрыто/i);
  });
});

describe('опасности места', () => {
  it('называет известные опасности, неизвестные молча пропускает', () => {
    const a = buildPlaceAdvisory({ ...base, volcano: { colorCode: 'green', observedAt: daysAgo(1) }, hazardTypes: ['bears', 'thermal', 'zzz_unknown'] }, NOW);
    const txt = a.lines.join(' ');
    expect(txt).toMatch(/медведи/); expect(txt).toMatch(/термальные зоны/);
    expect(txt).not.toMatch(/zzz_unknown/);
  });
});
