/**
 * Сторож: полевая карта открывается там, где человек (владелец 26.09: «при
 * переходе карта должна открываться на моём нахождении, а она открывает
 * вулкан Авачинский»).
 *
 * Дефектов было два, и оба держатся здесь:
 *  1. стартом был центр района пакета — у Авачинской группы это вулкан, —
 *     хотя сам район уже выбирался по точке человека;
 *  2. пересозданная карта (смена темы или района) не центрировалась на
 *     первом фиксе: флаг «уже центрировали» оставался от прежней.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fieldMapStartCenter, regionCenter } from '@/lib/map/field-base-map';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

describe('fieldMapStartCenter — по убыванию правоты', () => {
  const me = { lat: 53.02, lng: 158.65 };
  const disk = { lat: 53.05, lng: 158.6 };
  const route = { lat: 53.3, lng: 158.8 };

  it('живой фикс важнее центра района', () => {
    expect(fieldMapStartCenter({ fix: me }, 'avacha-group')).toEqual([53.02, 158.65]);
  });

  it('нет фикса — последняя точка с диска, а не маршрут и не вулкан', () => {
    expect(fieldMapStartCenter({ fix: null, lastFix: disk, route }, 'avacha-group')).toEqual([53.05, 158.6]);
  });

  it('явное действие (кнопка «Карта») важнее всего', () => {
    expect(fieldMapStartCenter({ explicit: [54, 159], fix: me }, 'avacha-group')).toEqual([54, 159]);
  });

  it('о человеке ничего не известно — начало маршрута', () => {
    expect(fieldMapStartCenter({ route }, 'avacha-group')).toEqual([53.3, 158.8]);
  });

  it('не известно ничего — только тогда центр района', () => {
    expect(fieldMapStartCenter({}, 'avacha-group')).toEqual(regionCenter('avacha-group'));
  });
});

describe('полевой экран и карта держат это правило', () => {
  it('экран отдаёт своей карте старт через fieldMapStartCenter, не центр района', () => {
    const src = read('app/planning/_PlanningClient.tsx');
    expect(src).toMatch(/center=\{fieldMapStartCenter\(\{\s*explicit: mapCenter,\s*fix: coords,\s*lastFix,/);
    expect(src).not.toMatch(/center=\{mapCenter \?\? regionCenter/);
  });

  it('каждая новая карта снова центрируется на первом фиксе', () => {
    const src = read('components/shared/VedarMap.tsx');
    const init = src.slice(src.indexOf('// ── Жизненный цикл карты'), src.indexOf('let cancelled = false;'));
    expect(init).toContain('autoCenterDoneRef.current = false;');
  });
});
