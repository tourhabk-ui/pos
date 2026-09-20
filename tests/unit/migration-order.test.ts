/**
 * Порядок миграций — по числу, а не по строке.
 *
 * ── Что чинилось 20.09 ────────────────────────────────────────────────────
 *
 * Репозиторий подошёл к тысячной миграции, и на ней посимвольный `.sort()`
 * расходится с номером: `'1000_'` меньше `'999_'` (`'1' < '9'`) и меньше
 * `'100_'` (на четвёртом символе `'0' < '_'`). То есть тысячная миграция
 * встала бы ПЕРЕД всеми от сотой до девятьсот девяносто девятой — в том
 * числе перед теми, что заводят таблицы.
 *
 * На проде это было бы не видно: там всё до 999 уже применено, в очереди
 * одна миграция, и порядок бессмысленен. Ошибка дождалась бы чистого
 * инстанса или дня, когда в очередь разом попадут 999-я и 1000-я.
 *
 * Мест, полагавшихся на порядок или на трёхзначность номера, нашлось
 * тринадцать. Три из них — настоящие раннеры (tsx, CJS для Docker и
 * админский эндпоинт), остальные — реестр схемы, модель схемы эволюции,
 * «кто завёл таблицу», свежесть справочника и пороги baseline в
 * интеграционных тестах.
 *
 * ── Что держит этот сторож ────────────────────────────────────────────────
 *
 * 1. Само правило: числовой порядок, третий исход для имени без номера.
 * 2. Связку: ни один читатель каталога миграций не сортирует имена голым
 *    `.sort()`. Правило, написанное тринадцать раз, — это тринадцать правил.
 * 3. Копию в `scripts/migrate-standalone.js`. Она существует потому, что
 *    runner-стадия Docker — чистый CJS без tsx и сборки; копия не
 *    расходится не по обещанию, а по прогону обеих реализаций на одном
 *    списке.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  migrationNumber,
  compareMigrations,
  sortMigrations,
  unnumberedMigrations,
  isAfterBaseline,
  lastMigration,
} from '@/lib/database/migration-order';

const ROOT = process.cwd();

/** Тот самый список, на котором посимвольный порядок врёт. */
const TRICKY = [
  '999_klyuchevskoy.sql',
  '1000_next.sql',
  '040_operator_tools.sql',
  '100_hundred.sql',
  '1001_after.sql',
  '863_baseline_edge.sql',
];

describe('номер разбирается, а не отрезается', () => {
  it('четырёхзначный номер — это тысяча, а не сто', () => {
    // `'1000_x.sql'.slice(0, 3)` давало «100»: миграция уходила из-под
    // сторожа доменов id молча.
    expect(migrationNumber('1000_next.sql')).toBe(1000);
    expect(migrationNumber('999_klyuchevskoy.sql')).toBe(999);
    expect(migrationNumber('040_operator_tools.sql')).toBe(40);
  });

  it('имя без числового префикса — «не знаю», а не ноль', () => {
    expect(migrationNumber('baseline.sql')).toBeNull();
    expect(migrationNumber('_leading.sql')).toBeNull();
    expect(migrationNumber('v2_schema.sql')).toBeNull();
  });
});

describe('порядок применения', () => {
  it('тысячная идёт ПОСЛЕ девятьсот девяносто девятой', () => {
    const sorted = sortMigrations(TRICKY);
    expect(sorted.indexOf('1000_next.sql')).toBeGreaterThan(sorted.indexOf('999_klyuchevskoy.sql'));
    expect(sorted.indexOf('1001_after.sql')).toBeGreaterThan(sorted.indexOf('1000_next.sql'));
  });

  it('тысячная идёт ПОСЛЕ сотой и после сороковой', () => {
    const sorted = sortMigrations(TRICKY);
    expect(sorted.indexOf('1000_next.sql')).toBeGreaterThan(sorted.indexOf('100_hundred.sql'));
    expect(sorted.indexOf('1000_next.sql')).toBeGreaterThan(sorted.indexOf('040_operator_tools.sql'));
  });

  it('посимвольный порядок дал бы ОБРАТНОЕ — иначе сторож ничего не ловит', () => {
    // Положительный контроль: если бы числовой порядок совпадал с
    // посимвольным, проверки выше зеленели бы при любой реализации.
    const plain = [...TRICKY].sort();
    expect(plain.indexOf('1000_next.sql')).toBeLessThan(plain.indexOf('999_klyuchevskoy.sql'));
    expect(plain.indexOf('1000_next.sql')).toBeLessThan(plain.indexOf('100_hundred.sql'));
  });

  it('исходный массив не меняется', () => {
    const before = [...TRICKY];
    sortMigrations(TRICKY);
    expect(TRICKY).toEqual(before);
  });

  it('безномерные уходят в хвост и называются списком', () => {
    const mixed = ['1000_a.sql', 'baseline.sql', '999_b.sql'];
    expect(sortMigrations(mixed)[2]).toBe('baseline.sql');
    expect(unnumberedMigrations(mixed)).toEqual(['baseline.sql']);
  });

  it('буквенный суффикс держит порядок внутри номера: 144a → 144b → 144c', () => {
    // Настоящие файлы каталога: создание таблицы, индекс, посев. Разбор без
    // поддержки буквы уводил их в хвост — посев прошёл бы раньше CREATE TABLE.
    expect(sortMigrations(['144c_seed.sql', '144a_create.sql', '144b_index.sql']))
      .toEqual(['144a_create.sql', '144b_index.sql', '144c_seed.sql']);
    expect(migrationNumber('144a_create.sql')).toBe(144);
    expect(sortMigrations(['145_next.sql', '144c_seed.sql'])[0]).toBe('144c_seed.sql');
  });

  it('равные номера упорядочены по имени, а не по капризу файловой системы', () => {
    expect(sortMigrations(['991_c.sql', '991_a.sql', '991_b.sql']))
      .toEqual(['991_a.sql', '991_b.sql', '991_c.sql']);
    expect(compareMigrations('991_a.sql', '991_a.sql')).toBe(0);
  });

  it('последняя — по номеру; пусто это null, а не выдуманное имя', () => {
    expect(lastMigration(TRICKY)).toBe('1001_after.sql');
    expect(lastMigration([])).toBeNull();
  });
});

describe('порог baseline', () => {
  it('тысячная НОВЕЕ baseline 863 (строковое сравнение говорило обратное)', () => {
    expect(isAfterBaseline('1000_next.sql', 863)).toBe(true);
    expect('1000_next.sql' >= '863').toBe(false); // как было
  });

  it('до baseline — не новее; без номера — тоже не новее', () => {
    expect(isAfterBaseline('040_operator_tools.sql', 863)).toBe(false);
    expect(isAfterBaseline('863_baseline_edge.sql', 863)).toBe(true);
    expect(isAfterBaseline('baseline.sql', 863)).toBe(false);
  });
});

describe('копия в CJS-раннере не разошлась', () => {
  it('боевой накатчик сортирует тем же порядком', async () => {
    // `scripts/migrate-standalone.js` запускается из start.js в Docker, где
    // нет tsx. Копия правила там неизбежна — расхождение копии нет.
    const runner = await import(join(ROOT, 'scripts/migrate-standalone.js')) as unknown as {
      default?: { compareMigrations?: (a: string, b: string) => number };
      compareMigrations?: (a: string, b: string) => number;
    };
    const cmp = runner.compareMigrations ?? runner.default?.compareMigrations;
    expect(cmp, 'migrate-standalone.js должен экспортировать compareMigrations').toBeTypeOf('function');
    expect([...TRICKY].sort(cmp!)).toEqual(sortMigrations(TRICKY));
  });
});

describe('связка: никто не сортирует имена миграций голым sort()', () => {
  const READERS = [
    'lib/database/migrate.ts',
    'lib/database/schema-registry.ts',
    'lib/db/unmigrated-tables.ts',
    'lib/agents/evo/schema-model.ts',
    'scripts/gen-db-schema.ts',
    'tests/unit/db-schema-doc.test.ts',
  ];

  it('каждый читатель каталога миграций берёт порядок из одного модуля', () => {
    for (const rel of READERS) {
      const src = readFileSync(join(ROOT, rel), 'utf-8');
      expect(src, `${rel}: должен звать sortMigrations`).toMatch(/sortMigrations\(/);
      // Голый `.sort()` рядом с чтением каталога — ровно та ошибка, что
      // чинилась. Компаратор внутри скобок допустим.
      expect(src, `${rel}: остался голый .sort()`).not.toMatch(/\.sql'\)\)\s*\.sort\(\)/);
      expect(src, `${rel}: остался голый .sort()`).not.toMatch(/endsWith\('\.sql'\)\)\.sort\(\)/);
    }
  });

  it('боевой CJS-накатчик тоже не сортирует голым sort()', () => {
    const src = readFileSync(join(ROOT, 'scripts/migrate-standalone.js'), 'utf-8');
    expect(src).toMatch(/\.sort\(compareMigrations\)/);
    expect(src).not.toMatch(/endsWith\('\.sql'\)\)\s*\n?\s*\.sort\(\);/);
  });

  it('сторож доменов id больше не режет номер тремя символами', () => {
    const src = readFileSync(join(ROOT, 'tests/unit/migration-id-type-domain.test.ts'), 'utf-8');
    expect(src).toMatch(/migrationNumber\(f\)/);
    expect(src).not.toMatch(/Number\(f\.slice\(0,\s*3\)\)/);
  });

  it('ручной накат принимает номер длиннее трёх цифр', () => {
    const src = readFileSync(join(ROOT, 'app/api/admin/migrations/apply/route.ts'), 'utf-8');
    expect(src).toMatch(/\\d\{3,\}/);
    expect(src).not.toMatch(/regex\(\/\^\\d\{3\}\$\/\)/);
  });

  it('пороги baseline в pg-тестах сравниваются числом', () => {
    for (const rel of ['tests/integration/tourist-cabinet.pg.test.ts',
                       'tests/integration/operator-screens.pg.test.ts']) {
      const src = readFileSync(join(ROOT, rel), 'utf-8');
      expect(src, `${rel}: строковое сравнение порога`).not.toMatch(/name >= \$1/);
      expect(src, `${rel}: номер должен извлекаться из имени`).toMatch(/substring\(name from/);
    }
  });
});

describe('каталог миграций на диске', () => {
  it('у каждого файла есть разбираемый номер', () => {
    const files = require('node:fs').readdirSync(join(ROOT, 'migrations'))
      .filter((f: string) => f.endsWith('.sql'));
    expect(files.length).toBeGreaterThan(0);
    // Безномерный файл — не катастрофа (он уйдёт в хвост), но он обязан быть
    // виден, а не раствориться в списке.
    expect(unnumberedMigrations(files)).toEqual([]);
  });
});
