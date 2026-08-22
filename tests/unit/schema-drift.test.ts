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
