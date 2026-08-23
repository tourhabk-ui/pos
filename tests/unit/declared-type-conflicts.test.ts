/**
 * Одна колонка — два объявления разного типа.
 *
 * Перепись расхождений (`schema-drift`) сверяет ПРИСУТСТВИЕ: объявлено — есть
 * ли. Она слепа к случаю, когда колонка есть, но не та. Между тем именно этот
 * случай дважды за сутки едва не привёл к порче живых данных: ремонтная
 * миграция 907 писалась по фактической схеме прода (`booking_id` BIGINT, а не
 * UUID из 084) ровно потому, что доигрывание исходного DDL завело бы колонку,
 * в которую не ложится существующий id.
 *
 * Опасность не в самом расхождении, а в РЕМОНТЕ вслепую: увидев «колонки
 * нет», легко доиграть исходный DDL и получить тип, несовместимый с данными
 * или с кодом. Поэтому конфликт объявлений обязан быть виден ДО ремонта.
 *
 * Список ниже заморожен и может только сокращаться. Новый конфликт — красный:
 * два ответа на один вопрос заводятся легко, а разбираются потом годами.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findTypeConflicts, normalizeType, extractType } from '@/lib/db/declared-types';

const MIGRATIONS = join(process.cwd(), 'migrations');

function migrationFiles() {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS, name), 'utf8') }));
}

/**
 * Остаток на 23.08.2026 — 24 колонки, объявленные разными базовыми типами.
 *
 * Часть из них уже сыграла: `operator_commissions.booking_id` и
 * `partners.guide_operator_id` стоят здесь потому, что миграция 907 объявила
 * ФАКТИЧЕСКИЙ тип прода вместо исходного — это не долг, а починка, и она
 * останется в списке навсегда как след.
 *
 * Часть ждёт разбора и опасна: `route_description_cache.route_id` (UUID
 * против INTEGER) — туда пишет агент-редактор; `tour_payments.booking_id`
 * (BIGINT против INTEGER) — платежи; `smart_notifications_log.user_id`
 * (INTEGER против UUID) — рассылка.
 *
 * Часть безобидна по существу (VARCHAR против TEXT), но остаётся в списке:
 * решать, что безобидно, должен человек с глазами, а не молчание сторожа.
 */
const KNOWN_CONFLICTS = [
  // Следы РЕМОНТА, а не долг: миграция объявила ФАКТИЧЕСКИЙ тип прода вместо
  // исходного. Останутся здесь навсегда — убрать их значило бы стереть след.
  //   operator_commissions.booking_id — 084 объявлял UUID, бронь BIGINT (907)
  //   partners.guide_operator_id      — 121 объявлял BIGINT, partners.id uuid (907)
  //   booking_logs.booking_id         — 019 объявлял UUID REFERENCES bookings(id);
  //                                     броня живёт в operator_bookings, её id
  //                                     bigint, а ключа на представление не
  //                                     бывает — 909
  'agent_experiments.intent',
  'agent_experiments.metric',
  'agent_experiments.name',
  'agent_experiments.status',
  'agent_experiments.winner',
  'agent_memory_edits.agent_id',
  'agent_memory_edits.edited_by',
  'booking_logs.booking_id',
  'crowd_log.agent_route_id',
  'crowd_log.guide_id',
  'external_alerts.affected_locations',
  'kuzmich_engagement_signals.tour_id',
  'kuzmich_engagement_signals.user_id',
  'location_real_time_status.agent_route_id',
  'location_safety_profile.agent_route_id',
  'operator_bookings.paid_at',
  'operator_commissions.booking_id',
  'operator_tours.includes',
  'partners.guide_operator_id',
  'route_description_cache.generated_at',
  'route_description_cache.model',
  'route_description_cache.route_id',
  'smart_notifications_log.tours_matched',
  'smart_notifications_log.user_id',
  'tour_payments.booking_id',
];

describe('объявления типов не расходятся сверх известного', () => {
  const conflicts = findTypeConflicts(migrationFiles()).filter((c) => c.base_differs);
  const keys = conflicts.map((c) => `${c.table}.${c.column}`);

  it('новых конфликтов нет', () => {
    const fresh = keys.filter((k) => !KNOWN_CONFLICTS.includes(k));
    const detail = conflicts
      .filter((c) => fresh.includes(`${c.table}.${c.column}`))
      .map((c) => `${c.table}.${c.column}: ${c.declarations.map((d) => `${d.normalized} (${d.file})`).join(' ↔ ')}`);
    expect(
      fresh,
      'колонка объявлена двумя разными типами — какой лежит на проде, ' +
      'репозиторий сказать не может, и ремонт вслепую сломает данные:\n' + detail.join('\n'),
    ).toEqual([]);
  });

  it('список только сокращается: разобранное убирается отсюда', () => {
    const gone = KNOWN_CONFLICTS.filter((k) => !keys.includes(k));
    expect(gone, `конфликт разобран — убрать из списка: ${gone.join(', ')}`).toEqual([]);
  });
});

describe('разбор не выдумывает конфликтов', () => {
  it('запятая внутри параметра типа не рвёт объявление', () => {
    // Первый прогон 22.08 дал семь призраков из тридцати двух: наивное
    // `[^,;]+` резало `DECIMAL(10,2)` до `DECIMAL(10`, и разбор объявлял
    // конфликт двух записей ОДНОГО файла. Инструмент, ищущий расхождения
    // типов, порождал их сам.
    const files = [{
      name: '001_x.sql',
      sql: `ALTER TABLE gear ADD COLUMN IF NOT EXISTS price DECIMAL(10,2) DEFAULT 0;
            CREATE TABLE gear (price DECIMAL(10,2));`,
    }];
    expect(findTypeConflicts(files)).toEqual([]);
  });

  it('повтор того же типа в разных файлах — не конфликт', () => {
    // `ADD COLUMN IF NOT EXISTS` намеренно идемпотентен и дублируется.
    const files = [
      { name: '001_a.sql', sql: 'ALTER TABLE t ADD COLUMN IF NOT EXISTS c TEXT;' },
      { name: '002_b.sql', sql: 'ALTER TABLE t ADD COLUMN IF NOT EXISTS c text NOT NULL;' },
    ];
    expect(findTypeConflicts(files)).toEqual([]);
  });

  it('ограничение внутри CREATE TABLE не принимается за колонку', () => {
    const files = [{
      name: '001_a.sql',
      sql: `CREATE TABLE t (id UUID, CONSTRAINT chk CHECK (id IS NOT NULL), UNIQUE (id));`,
    }];
    expect(findTypeConflicts(files)).toEqual([]);
  });

  it('массив и его элемент — разные типы, и это конфликт', () => {
    // Ровно случай operator_tours.includes: TEXT[] в 114, TEXT в 690.
    const files = [
      { name: '114_a.sql', sql: 'ALTER TABLE t ADD COLUMN IF NOT EXISTS c TEXT[] DEFAULT \'{}\';' },
      { name: '690_b.sql', sql: 'ALTER TABLE t ADD COLUMN IF NOT EXISTS c TEXT;' },
    ];
    const [conflict] = findTypeConflicts(files);
    expect(conflict?.base_differs).toBe(true);
  });
});

describe('написание приводится к одному виду', () => {
  it('синонимы Postgres не считаются расхождением', () => {
    expect(normalizeType('int')).toBe(normalizeType('INTEGER'));
    expect(normalizeType('BOOL')).toBe(normalizeType('boolean'));
    expect(normalizeType('DECIMAL(10,2)')).toBe(normalizeType('NUMERIC(10,2)'));
    expect(normalizeType('TIMESTAMPTZ')).toBe(normalizeType('TIMESTAMP WITH TIME ZONE'));
    expect(normalizeType('TEXT []')).toBe(normalizeType('TEXT[]'));
  });

  it('SERIAL — это INTEGER с последовательностью, а не отдельный тип', () => {
    expect(normalizeType('SERIAL')).toBe('INTEGER');
    expect(normalizeType('BIGSERIAL')).toBe('BIGINT');
  });

  it('тип обрывается на первом свойстве', () => {
    expect(extractType('VARCHAR(50) NOT NULL DEFAULT \'x\'')).toBe('VARCHAR(50)');
    expect(extractType('UUID REFERENCES users(id)')).toBe('UUID');
    expect(extractType('TIMESTAMPTZ DEFAULT NOW()')).toBe('TIMESTAMPTZ');
  });
});
