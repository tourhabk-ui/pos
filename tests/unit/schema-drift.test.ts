/**
 * Сверка «объявлено миграцией — есть на базе».
 *
 * Проверка нужна отдельно от аудита по именам файлов, потому что тот слеп к
 * файлу, который записан применённым, а откатился. Именно так 22.08 у
 * `operator_bookings` пропали пять колонок при пустых `unapplied` и
 * `failures`, и вместе с ними — создание брони с сайта.
 *
 * Сторож проверяет РАЗБОР И СВЕРКУ на выдуманных примерах, а не текущее
 * состояние репозитория: правило должно держаться и после того, как
 * конкретные миграции уедут в историю.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDeclarations, diffAgainstActual } from '@/lib/db/schema-drift';

const actualOf = (o: Record<string, string[]>) =>
  new Map(Object.entries(o).map(([t, cols]) => [t, new Set(cols)]));

describe('разбор объявлений', () => {
  it('берёт колонки из CREATE TABLE и не принимает за них ограничения', () => {
    const d = parseDeclarations([{
      name: '001_init.sql',
      sql: `CREATE TABLE bookings (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL,
  CONSTRAINT bookings_user_fk FOREIGN KEY (user_id) REFERENCES users(id),
  UNIQUE (id, user_id)
);`,
    }]);
    expect([...d.tables.get('bookings')!.keys()].sort()).toEqual(['id', 'user_id']);
  });

  it('берёт колонки из ADD COLUMN, в том числе IF NOT EXISTS', () => {
    const d = parseDeclarations([{
      name: '065_hotfix.sql',
      sql: `ALTER TABLE operator_bookings ADD COLUMN IF NOT EXISTS tour_id INT;
            ALTER TABLE operator_bookings ADD COLUMN total_amount INT;`,
    }]);
    expect([...d.tables.get('operator_bookings')!.keys()].sort()).toEqual(['total_amount', 'tour_id']);
  });

  it('приписывает колонку ПЕРВОМУ объявившему файлу', () => {
    // Потерялось действие того файла, который её заводил, а не того, кто
    // позже написал ADD COLUMN IF NOT EXISTS поверх.
    const d = parseDeclarations([
      { name: '040_first.sql', sql: 'ALTER TABLE t ADD COLUMN c TEXT;' },
      { name: '900_later.sql', sql: 'ALTER TABLE t ADD COLUMN IF NOT EXISTS c TEXT;' },
    ]);
    expect(d.tables.get('t')!.get('c')).toBe('040_first.sql');
  });

  it('понимает public. и кавычки в имени', () => {
    const d = parseDeclarations([{
      name: 'x.sql',
      sql: 'ALTER TABLE public."places" ADD COLUMN "slug" TEXT;',
    }]);
    expect(d.tables.get('places')?.has('slug')).toBe(true);
  });
});

describe('сверка с фактической схемой', () => {
  const declared = parseDeclarations([{
    name: '132_compat.sql',
    sql: `CREATE TABLE operator_bookings (id BIGSERIAL, operator_tour_id BIGINT);
          ALTER TABLE operator_bookings ADD COLUMN user_id UUID;
          CREATE TABLE sla_policies (id BIGSERIAL);`,
  }]);

  it('называет колонку, которой нет, и файл, который её обещал', () => {
    const r = diffAgainstActual(declared, actualOf({
      operator_bookings: ['id', 'operator_tour_id'],
      sla_policies: ['id'],
    }));
    expect(r.missing_columns).toEqual([
      { table: 'operator_bookings', column: 'user_id', declared_in: '132_compat.sql' },
    ]);
    expect(r.missing_tables).toEqual([]);
  });

  it('называет таблицу, которой нет, и не перечисляет её колонки отдельно', () => {
    // Иначе одна пропавшая таблица утопила бы отчёт в сотне «пропавших колонок».
    const r = diffAgainstActual(declared, actualOf({
      operator_bookings: ['id', 'operator_tour_id', 'user_id'],
    }));
    expect(r.missing_tables).toEqual([{ table: 'sla_policies', declared_in: '132_compat.sql' }]);
    expect(r.missing_columns).toEqual([]);
  });

  it('представление считается существующим', () => {
    // agent_route_knowledge стала VIEW (миграция 663) и не пропала. Отношения
    // приходят из information_schema.columns, где представления есть наравне
    // с таблицами, — значит объявлять их пропавшими нельзя.
    const d = parseDeclarations([{ name: '663.sql', sql: 'CREATE TABLE agent_route_knowledge (id UUID);' }]);
    const r = diffAgainstActual(d, actualOf({ agent_route_knowledge: ['id'] }));
    expect(r.missing_tables).toEqual([]);
  });

  it('сознательно убранное исключается поимённо — и только оно', () => {
    const r = diffAgainstActual(
      declared,
      actualOf({ operator_bookings: ['id', 'operator_tour_id'] }),
      new Set(['sla_policies', 'operator_bookings.user_id']),
    );
    expect(r.missing_tables).toEqual([]);
    expect(r.missing_columns).toEqual([]);
  });

  it('пустой список исключений ничего не прощает', () => {
    // Умолчание не должно давать «расхождений нет»: это ровно та тишина,
    // из-за которой пропажу не видели месяцами.
    const r = diffAgainstActual(declared, actualOf({ operator_bookings: ['id', 'operator_tour_id'] }));
    expect(r.missing_columns.length + r.missing_tables.length).toBe(2);
  });
});

describe('комментарии не читаются как объявления', () => {
  it('хвостовой комментарий со списком слов не порождает колонок', () => {
    // Первый прогон переписи на проде (22.08) выдал десяток призраков именно
    // отсюда: кусок комментария после запятой складывался со следующей
    // строкой в форму «имя тип». Перепись, ищущая враньё в схеме, врала сама.
    const d = parseDeclarations([{
      name: '151_evo.sql',
      sql: `CREATE TABLE evo_growth_scans (
  id BIGSERIAL PRIMARY KEY,
  scan_type VARCHAR(50) NOT NULL DEFAULT 'full',  -- full, code, db, security
  status VARCHAR(20) NOT NULL DEFAULT 'running'   -- running, complete, failed
);`,
    }]);
    expect([...d.tables.get('evo_growth_scans')!.keys()].sort()).toEqual(['id', 'scan_type', 'status']);
  });

  it('блочный комментарий тоже не считается', () => {
    const d = parseDeclarations([{
      name: 'x.sql',
      sql: `CREATE TABLE t (
  id BIGSERIAL PRIMARY KEY /* тут был, ловушка INT */,
  name TEXT
);`,
    }]);
    expect([...d.tables.get('t')!.keys()].sort()).toEqual(['id', 'name']);
  });

  it('комментарий перед ALTER не превращается в колонку', () => {
    const d = parseDeclarations([{
      name: 'y.sql',
      sql: `-- ADD COLUMN legacy_hint TEXT — так было раньше
ALTER TABLE t ADD COLUMN IF NOT EXISTS real_col TEXT;`,
    }]);
    expect([...d.tables.get('t')!.keys()]).toEqual(['real_col']);
  });
});

describe('список сознательно отсутствующих', () => {
  const SRC = readFileSync(join(process.cwd(), 'app/api/cron/schema-drift/route.ts'), 'utf-8');
  const LIST = SRC.slice(SRC.indexOf('const INTENTIONALLY_ABSENT'), SRC.indexOf(']);', SRC.indexOf('const INTENTIONALLY_ABSENT')));

  it('модуль поддержки внесён целиком', () => {
    // Решение владельца 22.08.2026: поддержки в продукте нет. Половинчатый
    // список хуже пустого: часть таблиц молчала бы, часть краснела, и
    // читатель не понял бы, решение это или недосмотр.
    for (const t of ['tickets', 'ticket_messages', 'sla_policies', 'sla_violations',
                     'sla_notifications', 'surveys', 'support_agents', 'feedback']) {
      expect(LIST, `${t} не внесена`).toMatch(new RegExp(`'${t}'`));
    }
  });

  it('knowledge_base_articles НЕ внесена вместе с поддержкой', () => {
    // Объявлена тем же файлом 02_support_tables.sql, но соседство по файлу —
    // не родство: её читают база знаний ИИ и rag.service. Внести её заодно
    // значило бы принять решение, которого никто не принимал.
    expect(LIST).not.toMatch(/'knowledge_base_articles'/);
  });

  it('каждая запись объяснена: у списка есть автор и дата решения', () => {
    const doc = SRC.slice(SRC.indexOf('Объявлено миграцией, отсутствует'), SRC.indexOf('const INTENTIONALLY_ABSENT'));
    expect(doc).toMatch(/Решение владельца \d{2}\.\d{2}\.\d{4}/);
  });

  it('прощает только названное — операторские таблицы в списке не появились', () => {
    // Сторож против расползания: список — исключение, а не свалка.
    for (const t of ['operator_commissions', 'operator_bookings', 'operator_tours', 'partners', 'users']) {
      expect(LIST, `${t} не должна прощаться`).not.toMatch(new RegExp(`'${t}'`));
    }
  });
});

describe('снятое позже — не расхождение', () => {
  it('колонка, удалённая другой миграцией, не числится пропавшей', () => {
    // operator_tours.tags: заведена в 040, снята в 041 (на её месте ai_tags).
    // Перепись 22.08 звала её пропавшей и тем самым подталкивала ВЕРНУТЬ то,
    // что убрали намеренно. Ложная тревога опаснее молчания.
    const d = parseDeclarations([
      { name: '040_tools.sql', sql: 'CREATE TABLE operator_tours (\n  id BIGSERIAL,\n  tags VARCHAR(255)[]\n);' },
      { name: '041_normalize.sql', sql: 'ALTER TABLE operator_tours DROP COLUMN IF EXISTS tags;' },
    ]);
    expect([...d.tables.get('operator_tours')!.keys()]).toEqual(['id']);
  });

  it('порядок важен: заведённое ПОСЛЕ удаления остаётся', () => {
    const d = parseDeclarations([
      { name: '040.sql', sql: 'CREATE TABLE t (id INT, c TEXT);' },
      { name: '041.sql', sql: 'ALTER TABLE t DROP COLUMN c;' },
      { name: '900.sql', sql: 'ALTER TABLE t ADD COLUMN c TEXT;' },
    ]);
    expect(d.tables.get('t')!.has('c')).toBe(true);
    // Виновником называется тот, кто завёл её В ПОСЛЕДНИЙ раз, а не файл 040:
    // действие 040 отменено, и искать пропажу надо в 900.
    expect(d.tables.get('t')!.get('c')).toBe('900.sql');
  });

  it('удалённая таблица перестаёт числиться объявленной', () => {
    const d = parseDeclarations([
      { name: '01.sql', sql: 'CREATE TABLE place_aliases (id INT);' },
      { name: '02.sql', sql: 'DROP TABLE IF EXISTS place_aliases;' },
    ]);
    expect(d.tables.has('place_aliases')).toBe(false);
  });
});
