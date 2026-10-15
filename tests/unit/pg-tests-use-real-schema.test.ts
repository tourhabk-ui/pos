/**
 * Интеграционный тест судит запрос на схеме ПРОДА, а не на выдуманной.
 *
 * ── Повод (аудит 15.10, находка P2-10, пункт 1.8) ─────────────────────────
 *
 * pg-тест доказывает форму SQL тем, что её исполняет сервер (урок 42P08,
 * CLAUDE.md §4). Но сервер судит запрос против той схемы, что ему дали. Если
 * таблицы написаны в тесте руками, тест доказывает, что запрос работает на
 * рукописной таблице, — а не на прод. Первые два переведённых файла это
 * показали сразу: у `place-nearby` рукописный `merged_into_id` был text (у
 * прода uuid), места заводились без `location_type` (прод не примет —
 * places_shape_check), а общий параметр имени и slug давал 42P08 на прод-типах;
 * у `park-routes` не было `kamchatka_routes.category`, которая у прода NOT NULL.
 *
 * Отсюда правило: pg-файл берёт схему из шаблона (`tests/helpers/pg-schema.ts`
 * — baseline прода + миграции новее границы снимка, граница — из шапки
 * baseline). Файлы, которые пока строят схему сами, перечислены ниже с
 * причиной. Список только сокращается: переведённый файл обязан из него уйти
 * (запись самоустаревает, как KNOWN_UNPRODUCED), а новый файл с рукописной
 * схемой — красный.
 *
 * Регулярка по исходнику здесь — только для запретов («этого быть не
 * должно»: свой bootstrap, своя граница, рукописная таблица у файла на
 * шаблоне). Граница проверяется вызовом на настоящем каталоге.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { baselineBoundary } from '../helpers/pg-schema';
import { migrationNumber, sortMigrations } from '@/lib/database/migration-order';

const INTEGRATION = join(process.cwd(), 'tests/integration');
const PG_FILES = readdirSync(INTEGRATION).filter((f) => f.endsWith('.pg.test.ts')).sort();

/**
 * Текст файла без комментариев: запреты судят код, а шапки файлов законно
 * рассказывают историю («прежде здесь звали bootstrap-from-baseline.js»).
 */
const code = (f: string) => readFileSync(join(INTEGRATION, f), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const usesTemplate = (f: string) => /\bcreateTestDatabase\(/.test(code(f));

/**
 * Долг 15.10: файлы, которые строят схему сами. Только сокращается.
 *
 * Причина у каждой записи своя — «заведено руками» и «так задумано» разные
 * состояния. Переводить по одному файлу за PR (дорожная карта, пункт 1.8).
 */
const OWN_SCHEMA: Record<string, string> = {
  'agent-kernel.pg.test.ts':
    'долг: миграции ядра плюс рукописная operator_tours в общей базе kernel_test',
  'alert-dedup.pg.test.ts':
    'долг: external_alerts вырезается регуляркой из текста миграций 070/687/1102/1124',
  'booking-access.pg.test.ts':
    'долг: рукописная operator_bookings плюс миграция 943',
  'kuzmich-retrieval.pg.test.ts':
    'долг: рукописные places и kamchatka_routes в своей схеме плюс миграция 942',
  'ledger-check-recent-order.pg.test.ts':
    'долг: миграция 925 в общей схеме public; делит safety_decision_events с safety-ledger',
  'route-slug-on-write.pg.test.ts':
    'долг: рукописные places и kamchatka_routes плюс функции миграции 1237',
  'safety-ledger.pg.test.ts':
    'долг: миграция 925 в общей схеме public; делит safety_decision_events с ledger-check-recent-order',
  'safety-status-feed.pg.test.ts':
    'долг: external_alerts из текста миграций и рукописные location_real_time_status/_migrations',
  'schema-registry-census.pg.test.ts':
    'так задумано: перепись реестра судится на синтетических таблицах (живая, пустая, с заглавными в имени)',
  'sos-active-visibility.pg.test.ts':
    'долг: рукописная sos_events в своей схеме',
  'timestamp-iso.pg.test.ts':
    'так задумано: таблиц прода не трогает, временная таблица-проба пояса сессии',
  'transfers.pg.test.ts':
    'долг: рукописные partners/users/places/kamchatka_routes плюс миграция 926',
};

describe('pg-тесты строят схему из шаблона прода', () => {
  it('выборка не пуста — иначе всё ниже проверяет пустоту', () => {
    expect(PG_FILES.length).toBeGreaterThan(0);
    expect(PG_FILES.filter(usesTemplate).length).toBeGreaterThan(0);
  });

  it('каждый pg-файл либо на шаблоне, либо записан в долг с причиной', () => {
    const unexplained = PG_FILES.filter((f) => !usesTemplate(f) && !(f in OWN_SCHEMA));
    expect(
      unexplained,
      'новый pg-файл строит схему сам: возьмите createTestDatabase из tests/helpers/pg-schema.ts',
    ).toEqual([]);
  });

  it('долг самоустаревает: переведённый или удалённый файл уходит из списка', () => {
    const stale = Object.keys(OWN_SCHEMA).filter((f) => !PG_FILES.includes(f) || usesTemplate(f));
    expect(stale, 'файл переведён на шаблон или удалён — уберите его из OWN_SCHEMA').toEqual([]);
  });

  it('у каждой записи долга названа причина', () => {
    for (const [f, why] of Object.entries(OWN_SCHEMA)) {
      expect(why.trim().length, f).toBeGreaterThanOrEqual(20);
    }
  });

  it('файл на шаблоне не пишет таблиц руками', () => {
    for (const f of PG_FILES.filter(usesTemplate)) {
      expect(code(f), f).not.toMatch(/CREATE\s+(TEMP(ORARY)?\s+|UNLOGGED\s+)?TABLE\b/i);
    }
  });

  it('свой bootstrap и своя граница снимка запрещены — ритуал один, в хелпере', () => {
    for (const f of PG_FILES) {
      const s = code(f);
      expect(s, `${f}: baseline поднимает хелпер`).not.toContain('bootstrap-from-baseline');
      expect(s, `${f}: миграции доигрывает хелпер`).not.toMatch(/['"]migrate\.ts['"]|database\/migrate\.ts/);
      expect(s, `${f}: граница читается из шапки baseline`).not.toMatch(/FIRST_AFTER_BASELINE|>=\s*'?863\b/);
    }
  });
});

describe('граница снимка — из шапки baseline, сверена с каталогом', () => {
  const b = baselineBoundary();
  const files = sortMigrations(readdirSync(join(process.cwd(), 'migrations')).filter((f) => f.endsWith('.sql')));

  it('первый номер после снимка — следующий за последней миграцией снимка', () => {
    expect(b.firstAfter).toBe((migrationNumber(b.lastMigration) ?? NaN) + 1);
  });

  it('доигрываются все миграции новее снимка и только они', () => {
    const last = migrationNumber(b.lastMigration)!;
    expect(b.replay.length, 'новее снимка ничего — значит граница уехала за каталог').toBeGreaterThan(0);
    expect(b.replay.every((f) => (migrationNumber(f) ?? -1) > last)).toBe(true);
    expect(
      files.filter((f) => (migrationNumber(f) ?? -1) > last),
      'миграция новее снимка выпала из доигрывания — шаблон был бы без неё',
    ).toEqual(b.replay);
  });

  it('самая новая миграция каталога попадает в шаблон', () => {
    expect(b.replay[b.replay.length - 1]).toBe(files[files.length - 1]);
  });
});
