/**
 * Гард фантомных колонок: SQL в коде ссылается только на колонки, существующие
 * в миграциях (Эволюция 2.0, пакет B, владелец 08.08).
 *
 * Прецеденты класса: operator_bookings.guests_count (#1007 — 500 на слотах
 * групповых туров) и operator_tours.tour_type (роут time-slots не работал
 * НИКОГДА: колонки нет ни в одной из 339 миграций; похоронен в #1008).
 * Ни tsc, ни тесты без БД такое не ловят — только сверка с миграциями.
 *
 * Реестр консервативен (lib/database/schema-registry.ts): DROP игнорируется,
 * RENAME оставляет оба имени, VIEW — wildcard, таблицы вне миграций не
 * проверяются. Ложный «фантом» на живой колонке дороже пропущенного.
 *
 * Осознанные исключения — в ALLOWLIST с причиной.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import {
  buildSchemaRegistry,
  findPhantomRefs,
  applyDdl,
  type SchemaRegistry,
} from '@/lib/database/schema-registry';

const ROOT = process.cwd();

/**
 * БАЗОВАЯ ЛИНИЯ ДОЛГА (первый прогон гарда, 08.08.2026): ссылки на колонки,
 * которых нет в DDL репозитория. Это НЕ разрешение — это замороженный список
 * известного долга: гард не даёт ему расти, а снимать записи — по одной,
 * проверяя каждую (реальная колонка, добавленная в прод руками, → миграция;
 * фантом → фикс кода). Пять записей /api/tours уже сняты в этом же PR —
 * они держали листинг в вечном degraded.
 * Новая запись здесь ЗАПРЕЩЕНА без миграции или явного решения владельца.
 */
/**
 * 01.09.2026, заход удаления: сняты 35 записей. 29 стояли за файлами мёртвого
 * модуля трансферов (#1496), 6 — за app/api/admin/operators/verify (шаг 3,
 * последний читатель отсутствующей на проде operators). Правило «снимать по
 * одной, проверяя каждую» здесь исполнено буквально: файла нет — ссылаться
 * некому. Оставлять было бы хуже: список долга, где треть записей про
 * несуществующие файлы, перестаёт говорить, сколько долга есть на самом деле.
 */
const BASELINE = new Set<string>([
  "app/api/ai/knowledge-base/route.ts → partners.contact_info",
  "app/api/ai/knowledge-base/route.ts → partners.specialization",
  "app/api/eco-points/route.ts → eco_points.co2_saved_kg",
  "app/api/eco-points/route.ts → eco_points.total_points",
  "app/api/eco-points/route.ts → eco_points.trees_equivalent",
  "app/api/eco-points/route.ts → eco_points.updated_at",
  "app/api/guide/map/route.ts → operator_tours.guide_id",
  "app/api/guide/map/route.ts → operator_tours.location",
  "app/api/guide/map/route.ts → partners.specializations",
  "app/api/guide/tours/route.ts → operator_tours.includes_equipment",
  "app/api/guide/tours/route.ts → operator_tours.includes_guide",
  "app/api/hub/operator/notifications/route.ts → users.full_name",
  "app/api/hub/operator/profile/route.ts → partners.features",
  "app/api/import/asset/route.ts → assets.bytes",
  "app/api/import/asset/route.ts → assets.key",
  "app/api/import/asset/route.ts → assets.mime",
  "app/api/import/asset/route.ts → assets.source_url",
  "app/api/operator/analytics/route.ts → tour_payments.amount",
  "app/api/operator/guides/route.ts → partners.specializations",
  "app/api/operator/profile/route.ts → operator_settings.id",
  "app/api/operator/profile/settings/route.ts → operator_settings.id",
  "app/api/operator/tours/[id]/generate-tags/route.ts → operator_tours.images",
  "app/api/operators/[slug]/route.ts → partners.faq",
  "app/api/operators/[slug]/route.ts → partners.features",
  "app/api/operators/[slug]/route.ts → partners.gallery",
  "app/api/operators/[slug]/route.ts → partners.reviews_data",
  "app/api/operators/[slug]/route.ts → partners.season_info",
  "app/api/payments/webhook/route.ts → operator_bookings.booking_type",
  "app/api/payments/webhook/route.ts → transfer_schedules.from_location",
  "app/api/payments/webhook/route.ts → transfer_schedules.to_location",
  "app/api/reviews/my/route.ts → reviews.images",
  "app/api/tours/[id]/availability/route.ts → operator_bookings.start_date",
  "app/api/tours/[id]/availability/route.ts → operator_tours.min_group_size",
  "app/api/tours/[id]/book/route.ts → operator_tours.min_group_size",
  "app/api/trip/plan/route.ts → operator_tours.coordinates",
  "app/api/trip/plan/route.ts → operator_tours.season",
  "app/api/webhooks/cloudpayments/route.ts → transfer_bookings.amount",
  "app/api/webhooks/cloudpayments/route.ts → transfer_bookings.currency",
  "app/api/webhooks/cloudpayments/route.ts → transfer_payments.error_message",
  "app/api/webhooks/cloudpayments/route.ts → transfer_payments.transaction_id",
  "lib/agents/agencies/operator-agency.ts → operator_tours.created_via",
  "lib/agents/evo/rescue-agent.ts → partners.is_active",
  "lib/agents/execution/initiative-executor.ts → ai_actions_log.agent_id",
  "lib/agents/execution/initiative-executor.ts → ai_actions_log.details",
  "lib/agents/sdk/tourist-tools.ts → users.company_name",
  "lib/agents/tools/board-executor-tools.ts → ai_actions_log.agent_name",
  "lib/agents/tools/board-executor-tools.ts → ai_actions_log.result",
  "lib/auth/guide-helpers.ts → operator_tours.difficulty_level",
  "lib/auth/guide-helpers.ts → operator_tours.guide_id",
  "lib/auth/guide-helpers.ts → operator_tours.location",
  "lib/auth/guide-helpers.ts → partners.bio",
  "lib/auth/guide-helpers.ts → partners.experience_years",
  "lib/auth/guide-helpers.ts → partners.languages",
  "lib/auth/guide-helpers.ts → partners.specializations",
  "lib/auth/guide-helpers.ts → partners.total_earnings",
  "lib/eco/compensation.ts → partners.is_active",
  "lib/events/agent-bus.ts → ai_actions_log.agent_id",
  "lib/events/agent-bus.ts → ai_actions_log.status",
  "lib/notifications/tour-channel-post.ts → operator_tours.location",
  "lib/octo/service.ts → operator_tours.gallery",
  "lib/octo/service.ts → operator_tours.hero_image",
  "lib/planner/compose.ts → users.company_name",
  "lib/search/tour-recommend.ts → operator_tours.eco_points_reward",
  "lib/search/tour-recommend.ts → operator_tours.images",
  "lib/services/operators/lead-processor.service.ts → lead_proposals.bear_risks",
  "lib/services/operators/lead-processor.service.ts → lead_proposals.bull_signals",
  "lib/services/operators/lead-processor.service.ts → lead_proposals.call_strategy",
  "lib/services/operators/lead-processor.service.ts → lead_proposals.conversion_prob",
  "lib/services/operators/lead-processor.service.ts → lead_proposals.recommended_action",
  "lib/services/operators/lead-processor.service.ts → lead_proposals.verdict_urgency",
  "lib/services/operators/support.service.ts → agents.category",
  "lib/services/operators/support.service.ts → agents.description",
  "lib/services/operators/support.service.ts → agents.status",
]);
const ALLOWLIST = BASELINE;

function sqlLiteralsOf(src: string): string[] {
  const lits = src.match(/`(?:[^`\\]|\\.)*`/gs) ?? [];
  return lits.filter(
    (l) => /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b/i.test(l) && /\b(FROM|INTO|SET)\b/i.test(l),
  );
}

describe('парсер DDL миграций', () => {
  const reg: SchemaRegistry = { tables: new Map(), views: new Set(), created: new Set() };
  applyDdl(
    `CREATE TABLE IF NOT EXISTS demo_bookings (
       id SERIAL PRIMARY KEY,
       participants INT NOT NULL,
       booking_status VARCHAR(20) DEFAULT 'new',
       CONSTRAINT demo_valid CHECK (participants > 0),
       UNIQUE (id, booking_status)
     );
     ALTER TABLE demo_bookings ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
     ALTER TABLE demo_bookings RENAME COLUMN paid_at TO paid_at_ts;
     CREATE OR REPLACE VIEW demo_view AS SELECT * FROM demo_bookings;`,
    reg,
  );

  it('колонки CREATE TABLE и ADD COLUMN попадают в реестр, констрейнты — нет', () => {
    const cols = reg.tables.get('demo_bookings')!;
    expect([...cols].sort()).toEqual(['booking_status', 'id', 'paid_at', 'paid_at_ts', 'participants']);
  });

  it('view регистрируется как wildcard', () => {
    expect(reg.views.has('demo_view')).toBe(true);
  });

  it('ловит оба реальных фантома 08.08 на SQL похороненного time-slots', () => {
    const DEAD_SQL = `
      SELECT id, title AS name, max_participants AS max_group_size, tour_type, is_active
      FROM operator_tours t
      WHERE t.id = $1 AND t.deleted_at IS NULL`;
    const DEAD_SQL2 = `
      SELECT td.id, ($2::integer - COALESCE(SUM(b.guests_count), 0)) as spots_left
      FROM tour_dates td
      LEFT JOIN operator_bookings b ON b.operator_tour_id = $1`;
    const real = buildSchemaRegistry();
    const phantoms1 = findPhantomRefs(DEAD_SQL, real).map((r) => `${r.table}.${r.column}`);
    const phantoms2 = findPhantomRefs(DEAD_SQL2, real).map((r) => `${r.table}.${r.column}`);
    expect(phantoms1).toContain('operator_tours.tour_type');
    expect(phantoms2).toContain('operator_bookings.guests_count');
  });

  it('живой SQL эндпоинта /slots фантомов не содержит', () => {
    const src = readFileSync(join(ROOT, 'app/api/tours/[id]/slots/route.ts'), 'utf-8');
    const real = buildSchemaRegistry();
    for (const lit of sqlLiteralsOf(src)) {
      expect(findPhantomRefs(lit, real)).toEqual([]);
    }
  });
});

describe('весь SQL кодовой базы — только существующие колонки', () => {
  it('app/ и lib/ не ссылаются на колонки, которых нет в миграциях', () => {
    const reg = buildSchemaRegistry();
    const files = execSync(`git ls-files 'app/**/*.ts' 'lib/**/*.ts'`, { cwd: ROOT, encoding: 'utf-8' })
      .trim().split('\n').filter(Boolean);

    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(ROOT, f), 'utf-8');
      if (!/`/.test(src)) continue;
      for (const lit of sqlLiteralsOf(src)) {
        for (const ref of findPhantomRefs(lit, reg)) {
          const key = `${f} → ${ref.table}.${ref.column}`;
          if (!ALLOWLIST.has(key)) offenders.push(key);
        }
      }
    }

    const unique = [...new Set(offenders)];
    expect(
      unique,
      `SQL ссылается на колонки, которых нет в миграциях (фантомы класса tour_type/guests_count):\n${unique.join('\n')}\n` +
      `Если колонка реально существует — проверь парсер/добавь миграцию; осознанное исключение — в ALLOWLIST с причиной.`,
    ).toEqual([]);
  });
});

/**
 * Старшинство источников DDL (22.08.2026).
 *
 * Реестр читает два каталога, и они не равны: `migrations/` накатывается на
 * прод, `lib/database/*.sql` — нет. Пока они просто объединялись, мёртвое
 * объявление ручалось за живые колонки, и гард фантомов молчал на настоящей
 * ошибке: `tour_availability.tour_id` (миграция 040 знает только
 * `operator_tour_id`) стояла в двух местах и валила инструмент оператора
 * `my_tours` на каждом вызове.
 */
describe('источники DDL не равны: миграция старше базового файла', () => {
  it('повторный CREATE TABLE ниже по списку колонок не добавляет', () => {
    const reg: SchemaRegistry = { tables: new Map(), views: new Set(), created: new Set() };
    // Каталог-источник (роль migrations/).
    applyDdl(`CREATE TABLE demo_slots (id BIGSERIAL, owner_tour_id BIGINT, date DATE);`, reg);
    const authoritative = new Set(reg.created);
    // Каталог ниже (роль lib/database/*.sql): та же таблица, другая форма.
    applyDdl(
      `CREATE TABLE IF NOT EXISTS demo_slots (id UUID, tour_id UUID, spots INT);
       ALTER TABLE demo_slots ADD COLUMN IF NOT EXISTS note TEXT;`,
      reg,
      authoritative,
    );
    const cols = reg.tables.get('demo_slots')!;
    expect([...cols].sort()).toEqual(['date', 'id', 'note', 'owner_tour_id']);
    // ALTER из младшего источника применился, CREATE — нет.
    expect(cols.has('note')).toBe(true);
    expect(cols.has('tour_id')).toBe(false);
    expect(cols.has('spots')).toBe(false);
  });

  it('tour_availability знает форму миграции 040, а не schema.sql', () => {
    const reg = buildSchemaRegistry();
    const cols = reg.tables.get('tour_availability')!;
    expect(cols.has('operator_tour_id')).toBe(true);
    // Форма из lib/database/schema.sql: tour_id UUID → tours(id). На проде её
    // нет (миграция 812 поймала id как BIGSERIAL), и знать её реестр не должен.
    expect(cols.has('tour_id')).toBe(false);
    expect(cols.has('available_spots')).toBe(false);
  });

  it('живой SQL по заездам ссылается на реальную колонку', () => {
    const reg = buildSchemaRegistry();
    for (const f of [
      'lib/agents/sdk/operator-tools.ts',
      'lib/services/operators/operator-tour-scraper.ts',
    ]) {
      const src = readFileSync(join(ROOT, f), 'utf-8');
      for (const lit of sqlLiteralsOf(src)) {
        expect(findPhantomRefs(lit, reg), `${f}: фантом в SQL`).toEqual([]);
      }
      expect(src, `${f}: ta.tour_id — колонки нет`).not.toMatch(/tour_availability[^`]*\btour_id\b/s);
    }
  });

  it('отказ вставки заезда не глушится пустым catch', () => {
    const src = readFileSync(join(ROOT, 'lib/services/operators/operator-tour-scraper.ts'), 'utf-8');
    // Пустой catch и держал эту вставку мёртвой: «column does not exist»
    // выглядел как «оператор не публикует дат» (§4.0). Правило про ЗАПИСЬ
    // в базу, а не про весь файл: битый href — это правда «не ссылка»,
    // и его catch законен.
    const at = src.indexOf('INSERT INTO tour_availability');
    expect(at).toBeGreaterThan(0);
    const around = src.slice(at, at + 1600);
    expect(around, 'отказ записи заезда проглочен').not.toMatch(/catch\s*(\([^)]*\))?\s*\{\s*(\/\*[\s\S]*?\*\/|\/\/[^\n]*)?\s*\}/);
    expect(around).toMatch(/console\.error\([\s\S]*?SQLSTATE/);
  });
});
