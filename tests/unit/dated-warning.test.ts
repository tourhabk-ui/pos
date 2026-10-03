import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { datedWarningEnd, datedWarningHours } from '@/lib/safety/dated-warning';
import { classifyMchsItem } from '@/lib/services/safety/seismic-parser';

// Случай 03.10: «Экстренное предупреждение на 3 октября» висело паводком 120 ч.
const PUB = new Date('2026-10-02T21:00:00Z'); // 3 октября 09:00 по Камчатке

describe('предупреждение живёт до конца названного дня', () => {
  it('«на 3 октября 2026 г.» — до 12:00 UTC 3 октября (полночь по Камчатке)', () => {
    expect(datedWarningEnd('Экстренное предупреждение на 3 октября 2026 г. (сильный дождь)', PUB)?.toISOString())
      .toBe('2026-10-03T12:00:00.000Z');
    expect(datedWarningHours('Экстренное предупреждение на 3 октября 2026 г.', PUB)).toBe(15);
  });

  it('диапазон и части суток — берётся последний день', () => {
    expect(datedWarningEnd('Предупреждение на 3-4 октября', PUB)?.toISOString()).toBe('2026-10-04T12:00:00.000Z');
    expect(datedWarningEnd('Предупреждение на ночь 3 и день 4 октября', PUB)?.toISOString()).toBe('2026-10-04T12:00:00.000Z');
  });

  it('«не знаю» — без даты, день прошёл, дальше недели, «до» вместо «на»', () => {
    expect(datedWarningEnd('Прогнозируется подъем уровней воды на реках', PUB)).toBeNull();
    expect(datedWarningEnd('Предупреждение на 1 октября', PUB)).toBeNull();
    expect(datedWarningEnd('Предупреждение на 20 октября', PUB)).toBeNull();
    expect(datedWarningEnd('Ограничения до 5 октября', PUB)).toBeNull();
    expect(datedWarningEnd('Рассчитано на 3 октября', new Date('invalid'))).toBeNull();
  });

  it('декабрь → январь следующего года', () => {
    expect(datedWarningEnd('Предупреждение на 1 января', new Date('2026-12-31T05:00:00Z'))?.toISOString())
      .toBe('2027-01-01T12:00:00.000Z');
  });
});

describe('классификатор ставит срок по названному дню', () => {
  it('паводковое «на 3 октября» — не 120 часов', () => {
    const ev = classifyMchsItem('t1', 'Экстренное предупреждение на 3 октября 2026 г. (сильный дождь)',
      'Ожидается сильный дождь, подъем уровней воды на реках южной половины края.', PUB.toUTCString(), 'https://x');
    expect(ev?.alert_type).toBe('flood');
    expect(ev?.expires_hours).toBe(15);
  });

  it('паводок без даты сохраняет свой срок', () => {
    const ev = classifyMchsItem('t2', 'Прогнозируется подъем уровней воды на реках южной половины края',
      '', PUB.toUTCString(), 'https://x');
    expect(ev?.alert_type).toBe('flood');
    expect(ev?.expires_hours).toBe(120);
  });

  it('погодное «на 3 октября», опубликованное накануне, держится весь день, а не 24 ч', () => {
    const pub = new Date('2026-10-02T06:00:00Z');
    const ev = classifyMchsItem('t3', 'Экстренное предупреждение на 3 октября (сильный дождь)',
      'Предупреждаем: ожидается сильный дождь.', pub.toUTCString(), 'https://x');
    expect(ev?.alert_type).toBe('weather');
    expect(ev?.expires_hours).toBe(30);
  });
});

describe('живые строки догоняет крон приёма', () => {
  const ingest = readFileSync('app/api/cron/safety-ingest/route.ts', 'utf8');
  it('capDatedWarnings вызывается в обоих путях приёма до пересчёта статуса', () => {
    const calls = ingest.match(/safely\('dated-cap', \(\) => capDatedWarnings\(query\)\)/g) ?? [];
    expect(calls.length).toBe(2);
    expect(ingest).toMatch(/dated_caps: datedCaps \?\? null/);
  });
  it('уборка только сокращает срок', () => {
    const cap = readFileSync('lib/services/safety/dated-warning-cap.ts', 'utf8');
    expect(cap).toMatch(/LEAST\(ea\.expires_at, v\.end_at\)/);
  });
});
