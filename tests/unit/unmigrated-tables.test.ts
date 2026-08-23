/**
 * Таблицы, форму которых знает только ненакатываемый файл.
 *
 * Реестр схемы читает два каталога. `migrations/` накатывается на прод при
 * каждом деплое; `lib/database/*.sql` не накатывается ничем — его читает один
 * `scripts/migrate.js`, не подключённый ни к одной npm-команде.
 *
 * 22.08 развели СТАРШИНСТВО: при двойном объявлении побеждает миграция. Это
 * закрыло случай `tour_availability`, где мёртвый файл ручался за колонку
 * `tour_id`, которой на проде нет. Но осталась половина, которой старшинство
 * не касается: таблицы, объявленные ТОЛЬКО в мёртвом каталоге. Спорить не с
 * чем — и реестр принимает их форму за объявленную, хотя проверить её нечем.
 *
 * Сторож держит три вещи: множество считается и называется вслух; оно может
 * только СОКРАЩАТЬСЯ; и перепись расхождений умеет сверить его с боевой базой,
 * потому что иначе список так и останется списком.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  unmigratedTables,
  unmigratedTableNames,
  createdTables,
  MIGRATIONS_DIR,
  UNAPPLIED_DIR,
} from '@/lib/db/unmigrated-tables';

/**
 * ПОТОЛОК ДОЛГА, замер 23.08.2026: 69 таблиц из 86, объявленных в мёртвом
 * каталоге, не имеют ни одной миграции.
 *
 * Это не разрешение, а заморозка: число может только падать. Растёт оно
 * ровно одним способом — кто-то завёл таблицу правкой `lib/database/*.sql`
 * вместо миграции, то есть создал её на своей машине и нигде больше.
 *
 * Снимается запись по одной и только фактом с прода: перепись
 * `/api/cron/schema-drift` говорит, есть ли таблица на боевой базе и совпадают
 * ли колонки. Дальше одно из двух — миграция, повторяющая боевую форму, или
 * снос мёртвого объявления вместе с кодом, который к нему обращается.
 */
const CEILING = 69;

describe('множество названо и заморожено', () => {
  it('таблиц без миграции не больше потолка', () => {
    const list = unmigratedTables();
    expect(
      list.length,
      `таблиц без миграции ${list.length} > ${CEILING}. Новая берётся ровно одним способом: ` +
      `таблицу завели правкой ${UNAPPLIED_DIR}/*.sql вместо миграции, а этот каталог на прод ` +
      `не накатывается — значит на проде её нет. Заведи миграцию. Список: ` +
      list.map((t) => t.table).join(', '),
    ).toBeLessThanOrEqual(CEILING);
  });

  it('каждая запись называет свой файл', () => {
    // Без имени файла список — обвинение без адреса: непонятно, где чинить.
    for (const t of unmigratedTables()) {
      expect(t.declared_in, `у ${t.table} нет файла`).toMatch(/\.sql$/);
    }
  });

  it('в списке нет ничего из migrations/', () => {
    const migrated = createdTables(MIGRATIONS_DIR);
    for (const t of unmigratedTables()) {
      expect(migrated.has(t.table), `${t.table} объявлена миграцией и не должна быть в списке`).toBe(false);
    }
  });
});

describe('счёт ведётся одной меркой', () => {
  it('оба каталога разбираются одним и тем же способом', () => {
    // Разные мерки дали бы разницу там, где её нет: таблица, записанная в
    // одном файле через IF NOT EXISTS, а в другом без него, — одна таблица.
    const mig = createdTables(MIGRATIONS_DIR);
    const dead = createdTables(UNAPPLIED_DIR);
    expect(mig.size).toBeGreaterThan(100);
    expect(dead.size).toBeGreaterThan(0);
    expect(unmigratedTables().length).toBe(
      [...dead.keys()].filter((t) => !mig.has(t)).length,
    );
  });

  it('имена в нижнем регистре — иначе Users и users разошлись бы', () => {
    for (const t of unmigratedTables()) {
      expect(t.table).toBe(t.table.toLowerCase());
    }
  });
});

describe('самые дорогие имена в списке названы поимённо', () => {
  it('partners, users, tours и bookings знают форму только из мёртвого файла', () => {
    // Не для красоты: на эти четыре опирается почти весь код платформы, и
    // именно они делают список не абстракцией, а риском. Упадёт этот тест —
    // значит одна из них наконец получила миграцию, и потолок пора снижать.
    const names = unmigratedTableNames();
    for (const t of ['partners', 'users', 'tours', 'bookings']) {
      expect(names.has(t), `${t} больше не в списке — снизь CEILING`).toBe(true);
    }
  });
});

describe('перепись расхождений умеет сверить список с прода', () => {
  const ROUTE = readFileSync(
    join(process.cwd(), 'app/api/cron/schema-drift/route.ts'), 'utf-8',
  );

  it('роут зовёт перепись', () => {
    expect(ROUTE).toMatch(/unmigratedTables\(\)/);
  });

  it('ответ различает «нет на проде» и «есть, но колонки расходятся»', () => {
    // Одно слово на оба случая отправило бы чинить не туда: отсутствующая
    // таблица — мёртвый код, расходящиеся колонки — недостающая миграция.
    expect(ROUTE).toMatch(/on_prod: false/);
    expect(ROUTE).toMatch(/declared_missing_on_prod/);
    expect(ROUTE).toMatch(/on_prod_not_declared/);
  });

  it('колонки прода, которых нет в объявлении, тоже считаются', () => {
    // Это будущий ложный фантом: гард однажды объявит фантомом живую колонку.
    expect(ROUTE).toMatch(/on_prod_not_declared:/);
  });

  it('роут отдаёт факты, а не вердикт', () => {
    // Мёртвый файл — смесь: partners.contact он угадал, tour_availability.tour_id
    // нет. Поле с приговором в ответе превратило бы догадку в вывод, на который
    // сошлются. Судим КОД, а не прозу: слово «врёт» в пояснении рядом как раз и
    // объясняет, почему приговора нет.
    const code = ROUTE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    expect(code).not.toMatch(/\bverdict\b/i);
  });
});
