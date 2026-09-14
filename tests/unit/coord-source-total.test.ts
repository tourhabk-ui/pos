/**
 * Происхождение координаты всегда называется словами — даже незнакомое.
 *
 * ── Дефект ────────────────────────────────────────────────────────────────
 *
 * `places.coord_source` — свободный текст, а `CoordSource` был закрытым
 * перечнем из четырёх слов. Миграция, которой ни одно не подходило, писала
 * своё: 930 поставила озеру Синичкино `osm_organic_930` (координата из OSM
 * через Organic Maps — источник назван честно, слова в перечне не нашлось).
 *
 * `coordSourceLabel` — исчерпывающий switch БЕЗ `default`. TypeScript такой
 * switch принимает, потому что верит типу; база в этот тип не обязана
 * укладываться. На незнакомой строке функция возвращала `undefined`.
 *
 * Цена видна на полевом экране (`app/planning/_PlanningClient.tsx`): человеку
 * показывается «Координата точки: ${coordSourceLabel(...)} — не полагайтесь
 * только на азимут и время». С незнакомым значением он читал «Координата
 * точки: undefined». Предупреждение теряло смысл ровно там, где нужно, — и
 * ровно для той точки, чья координата и правда сомнительна.
 *
 * ── Починка ───────────────────────────────────────────────────────────────
 *
 * Не `default: return ''` и не исключение в сторож, а то, чего перечню не
 * хватало: `external` — «взята из внешнего справочника». Плюс `asCoordSource`
 * на границе чтения: `as CoordSource` там был не проверкой, а обещанием.
 *
 * Незнакомое сводится к `unknown`. Это слабее правды — в базе что-то
 * записано, — но сильнее молчания: человек видит слова, а
 * `coordIsTrustworthy` по-прежнему отвечает «нет».
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  coordSourceLabel, coordIsTrustworthy, asCoordSource, type CoordSource,
} from '@/lib/places/coord-source';

const ALL: CoordSource[] = ['surveyed', 'geocoded', 'placeholder', 'external', 'unknown'];

describe('у каждого происхождения есть слова', () => {
  it('ни одно значение перечня не даёт пустоты', () => {
    for (const s of ALL) {
      const label = coordSourceLabel(s);
      expect(label, `у ${s} нет подписи`).toBeTruthy();
      expect(label).not.toMatch(/undefined/);
    }
  });

  it('внешний справочник назван своим словом, а не «не записано»', () => {
    // Смысл значения: происхождение ИЗВЕСТНО. Свести его к unknown значило бы
    // выбросить то единственное, что мы про эту координату знаем.
    expect(coordSourceLabel('external')).toMatch(/внешн/i);
    expect(coordSourceLabel('external')).not.toBe(coordSourceLabel('unknown'));
  });
});

describe('строка из базы не проваливается в undefined', () => {
  it('известные значения проходят как есть', () => {
    for (const s of ALL) expect(asCoordSource(s)).toBe(s);
  });

  it('значение миграции 930 больше не даёт пустоты', () => {
    // Именно эта строка и лежала на проде у Синичкина.
    expect(coordSourceLabel(asCoordSource('osm_organic_930'))).toBeTruthy();
  });

  it('null, пустота и мусор сводятся к «не записано»', () => {
    for (const raw of [null, undefined, '', 'что-то своё', 'SURVEYED']) {
      expect(asCoordSource(raw)).toBe('unknown');
    }
  });

  it('доверие от этого не появляется', () => {
    // Сведение к unknown не должно случайно открыть дорогу утверждениям.
    expect(coordIsTrustworthy(asCoordSource('osm_organic_930'))).toBe(false);
    expect(coordIsTrustworthy(asCoordSource('external'))).toBe(false);
    expect(coordIsTrustworthy('surveyed')).toBe(true);
  });
});

describe('полевой экран читает базу через проверку, а не через каст', () => {
  const FIELD = readFileSync(join(process.cwd(), 'app/planning/_PlanningClient.tsx'), 'utf-8');

  it('небезопасного каста к CoordSource не осталось', () => {
    expect(FIELD).not.toMatch(/w\.coordSource as CoordSource \| null/);
  });

  it('используется asCoordSource', () => {
    expect(FIELD).toMatch(/asCoordSource\(/);
  });

  it('предупреждение по-прежнему показывается словами', () => {
    // Ради этой строки всё и чинилось.
    expect(FIELD).toMatch(/Координата точки: \$\{coordSourceLabel\(/);
  });
});
