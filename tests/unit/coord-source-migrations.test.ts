/**
 * Миграции пишут в `coord_source` только то, что платформа умеет прочесть.
 *
 * ── Дефект ────────────────────────────────────────────────────────────────
 *
 * Колонка `places.coord_source` — свободный текст, а `CoordSource` в
 * `lib/places/coord-source.ts` — закрытый перечень. Ничто не мешало миграции
 * записать туда своё слово, и четыре записали:
 *
 *   track_fix_880 · track_fix_883 · owner_field_893 · osm_organic_930
 *
 * Ни одно не совпадает с веткой `coordSourceLabel`. До 14.09 у той функции не
 * было `default`, и она возвращала `undefined` — человек в поле читал
 * «Координата точки: undefined — не полагайтесь только на азимут и время».
 * Сейчас на границе стоит `asCoordSource`, и незнакомое сводится к `unknown`,
 * то есть к «происхождение не записано». Это уже не ложь, но всё ещё потеря:
 * происхождение записано, просто словом, которого платформа не знает.
 *
 * Поэтому мало починить читателя — надо не пускать в базу непрочитываемое.
 *
 * ── Почему здесь ЕСТЬ список исключений ───────────────────────────────────
 *
 * Первая редакция этого сторожа обходилась без него и заявляла, что он не
 * нужен. Это было неверно, и сторож это же и показал: он покраснел на
 * миграциях 880, 883, 893 и 930, а править их НЕЛЬЗЯ — миграции идут только
 * вперёд, уже применённый файл трогать запрещено. Без списка правило просто
 * неисполнимо.
 *
 * Список устроен так, чтобы не стать свалкой: каждая запись называет не
 * только старое значение, но и миграцию, которая его ПОЧИНИЛА, и тест
 * проверяет, что починка действительно существует в каталоге. Запись без
 * починки красная. Новое слово сюда просто так не добавить — придётся
 * написать и миграцию, приводящую его к перечню, а если ты уже её пишешь,
 * проще сразу взять значение перечня.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { asCoordSource } from '@/lib/places/coord-source';

const MIGRATIONS = join(process.cwd(), 'migrations');

/**
 * Исторические значения вне перечня и миграция, приводящая их к нему.
 * Может только СОКРАЩАТЬСЯ: новые записи означают новый долг, а не новое право.
 */
const LEGACY_VALUES: Record<string, { writtenBy: string; repairedBy: string }> = {
  track_fix_880:   { writtenBy: '880', repairedBy: '967' },
  track_fix_883:   { writtenBy: '883', repairedBy: '967' },
  owner_field_893: { writtenBy: '893', repairedBy: '967' },
  osm_organic_930: { writtenBy: '930', repairedBy: '960' },
};

function files(): string[] {
  return readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
}

/**
 * Присваивания coord_source в миграциях.
 *
 * Сравнения отсеиваются по строке: `WHERE coord_source = '...'` и
 * `AND coord_source = '...'` — это ПОЧИНКА старого значения, она обязана его
 * упоминать, и считать её нарушением значило бы запретить чинить.
 */
function assignedValues(): Array<{ file: string; value: string }> {
  const out: Array<{ file: string; value: string }> = [];
  for (const file of files()) {
    const body = readFileSync(join(MIGRATIONS, file), 'utf-8').replace(/^\s*--.*$/gm, ' ');
    for (const line of body.split('\n')) {
      const m = /coord_source\s*=\s*'([^']*)'/.exec(line);
      if (!m) continue;
      if (/\b(WHERE|AND|OR)\b/i.test(line.slice(0, m.index))) continue;
      out.push({ file, value: m[1] });
    }
  }
  return out;
}

describe('coord_source в миграциях — только из перечня', () => {
  it('новое значение вне перечня не заводится', () => {
    const bad = assignedValues()
      .filter(({ value }) => asCoordSource(value) !== value)
      .filter(({ value }) => !(value in LEGACY_VALUES));
    expect(
      bad.map((b) => `${b.file}: '${b.value}'`),
      'значение вне перечня CoordSource: на карточке оно прочитается как ' +
        '«происхождение не записано». Возьмите значение перечня — или заведите ' +
        'новое в lib/places/coord-source.ts вместе с подписью человеку',
    ).toEqual([]);
  });

  it('проверка не пустая — присваивания в миграциях есть', () => {
    // Иначе тест зеленел бы на сломанном разборе: ноль находок неотличим от
    // нуля нарушений (§4.0).
    expect(assignedValues().length).toBeGreaterThan(0);
  });
});

describe('у каждого исторического значения есть починка', () => {
  const all = files().join('\n');

  it('миграция-починка существует в каталоге', () => {
    for (const [value, { repairedBy }] of Object.entries(LEGACY_VALUES)) {
      expect(all, `для '${value}' обещана починка ${repairedBy}, а файла нет`)
        .toMatch(new RegExp(`^${repairedBy}_`, 'm'));
    }
  });

  it('починка действительно упоминает это значение', () => {
    // Иначе список превратился бы в перечень обещаний: номер стоит, а строки
    // в миграции нет — ровно то, от чего правило 10.09.
    for (const [value, { repairedBy }] of Object.entries(LEGACY_VALUES)) {
      const file = files().find((f) => f.startsWith(`${repairedBy}_`));
      expect(file, `миграция ${repairedBy} не найдена`).toBeDefined();
      const body = readFileSync(join(MIGRATIONS, file as string), 'utf-8');
      expect(body, `${file} не приводит '${value}' к перечню`).toContain(value);
    }
  });

  it('починка ставит значение ИЗ перечня', () => {
    for (const { repairedBy } of Object.values(LEGACY_VALUES)) {
      const file = files().find((f) => f.startsWith(`${repairedBy}_`)) as string;
      const body = readFileSync(join(MIGRATIONS, file), 'utf-8').replace(/^\s*--.*$/gm, ' ');
      const sets = [...body.matchAll(/SET\s+coord_source\s*=\s*'([^']*)'/g)].map((m) => m[1]);
      expect(sets.length, `${file}: нет SET coord_source`).toBeGreaterThan(0);
      for (const v of sets) expect(asCoordSource(v)).toBe(v);
    }
  });
});
