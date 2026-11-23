/**
 * Правило цены действует только после проверки (слово владельца 23.11:
 * «Наценки тоже показываются в модерации: цена тура меняется только через
 * одну дверь»; миграция 1514).
 *
 * Здесь — запреты по исходнику: считать цену по своему условию и писать
 * правило, не назвав статус. Поведение на схеме прода судит
 * tests/integration/pricing-rule-moderation.pg.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PRICING_RULE_STATUSES, livePricingRuleSql } from '@/lib/tours/pricing-rule-live';
import { repoCodeFiles } from '../helpers/repo-code';
import { insertsInto, readsFrom, writesTo } from '../helpers/sql-table';

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8');

// Весь репозиторий и запрос в любой форме, которую принимает PostgreSQL:
// перепись, которая смотрит три каталога и слова заглавными, молчит о писателе
// в `components/` или о `update only public."tour_pricing_rules"` (ревью
// безопасности PR #3804).
const SOURCES = repoCodeFiles(ROOT);
const TABLE = 'tour_pricing_rules';
const READS = readsFrom(TABLE);
const INSERTS = insertsInto(TABLE);
const WRITES = writesTo(TABLE);

type Kind =
  /** Считает цену, которую видит и платит турист: только общим условием. */
  | 'price'
  /** Показывает правила владельцу или администратору — все, с их статусом. */
  | 'listing'
  /** Перепись: считает правила по своим определениям и называет их в ответе. */
  | 'census'
  /** Очередь проверки: читает правила, ждущие решения, и решает их под замком. */
  | 'review'
  /** Дверь владельца: читает правила рода под замком, чтобы попросить новое или снятие. */
  | 'door';

const READERS: Record<string, { kind: Kind; why: string }> = {
  'lib/tours/honest-price.ts': { kind: 'price', why: 'цена карточки и цена брони' },
  'lib/services/tours/dynamic-pricing.ts': { kind: 'price', why: 'пакетный расчёт цен для каналов (OCTO)' },
  'lib/tours/operator-markup.ts': { kind: 'listing', why: 'экран «наценка на выходные» у владельца' },
  'app/api/hub/operator/pricing-rules/route.ts': { kind: 'listing', why: 'экран «скидки» у владельца' },
  'app/api/admin/pricing-rules/route.ts': { kind: 'listing', why: 'список правил у администратора' },
  'app/api/cron/pricing-rules-census/route.ts': { kind: 'census', why: 'перепись правил цены' },
  'lib/tours/pricing-rule-review.ts': { kind: 'review', why: 'очередь скидок и наценок у администратора и решение по правилу' },
  'lib/tours/pricing-rule-door.ts': { kind: 'door', why: 'просьба владельца о правиле и о его снятии' },
};

describe('условие «правило действует» — одно', () => {
  it('действует включённое и проверенное правило; псевдоним таблицы подставляется', () => {
    expect(livePricingRuleSql()).toBe("(is_active = true AND moderation_status = 'approved')");
    expect(livePricingRuleSql('pr')).toBe("(pr.is_active = true AND pr.moderation_status = 'approved')");
    expect([...PRICING_RULE_STATUSES]).toEqual(['pending', 'approved', 'rejected']);
    // Псевдоним задаёт код, но в SQL без проверки не идёт.
    expect(() => livePricingRuleSql('pr; DROP TABLE x')).toThrow();
  });

  it('статусы кода и ограничение миграции 1514 — одни и те же', () => {
    const sql = read('migrations/1514_tour_pricing_rules_moderation.sql');
    const check = /CHECK \(moderation_status IN \(([^)]+)\)\)/.exec(sql)?.[1] ?? '';
    expect(check.split(',').map((s) => s.trim().replace(/'/g, '')).sort()).toEqual([...PRICING_RULE_STATUSES].sort());
    // Прежние правила остаются действующими, новое без статуса — «на проверке».
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS moderation_status VARCHAR\(20\) NOT NULL DEFAULT 'approved'/);
    expect(sql).toMatch(/ALTER COLUMN moderation_status SET DEFAULT 'pending'/);
    // Живые правила миграция не переписывает и не удаляет.
    const body = sql.replace(/--.*$/gm, '');
    expect(body).not.toMatch(/\b(UPDATE|DELETE FROM|DROP TABLE|TRUNCATE)\b/);
  });
});

describe('перепись читателей и писателей правил цены', () => {
  it('каждый, кто читает правила, назван; названные всё ещё читают', () => {
    const found = SOURCES.filter((f) => READS.test(read(f)));
    expect(found).toEqual(Object.keys(READERS).sort());
    for (const [file, r] of Object.entries(READERS)) expect(r.why.length, file).toBeGreaterThan(5);
  });

  it('цену считают только общим условием: своего «включено» у читателя цены нет', () => {
    for (const [file, r] of Object.entries(READERS)) {
      if (r.kind !== 'price') continue;
      const src = read(file);
      expect(src, `${file}: цена считается мимо общего условия`).toMatch(/livePricingRuleSql\(/);
      // Свой `is_active = TRUE` рядом с таблицей правил пропустил бы правило «на проверке».
      const own = [...src.matchAll(readsFrom(TABLE, 'gi'))].map((m) => src.slice(m.index, m.index + 240));
      for (const chunk of own) expect(chunk, file).not.toMatch(/is_active\s*=\s*TRUE/i);
    }
  });

  it('каждый, кто пишет в таблицу правил, назван — вставка, правка, удаление', () => {
    // Запись в любой форме: UPDATE, INSERT, DELETE, MERGE, COPY; имя таблицы в
    // кавычках, со схемой, с ONLY; слова в любом регистре.
    for (const q of [
      'UPDATE tour_pricing_rules SET is_active = FALSE',
      'update only public."tour_pricing_rules" set multiplier = $1',
      'Insert Into "tour_pricing_rules" (rule_type) VALUES ($1)',
      'DELETE FROM tour_pricing_rules WHERE id = $1',
      'MERGE INTO tour_pricing_rules t USING s ON t.id = s.id',
    ]) expect(WRITES.test(q), q).toBe(true);
    for (const q of ['SELECT 1 FROM tour_pricing_rules', 'UPDATE tour_pricing_rules_log SET x = 1']) expect(WRITES.test(q), q).toBe(false);
    expect(READS.test('select 1 from public.tour_pricing_rules pr')).toBe(true);
    expect(READS.test('LEFT JOIN "tour_pricing_rules" pr ON pr.operator_tour_id = t.id')).toBe(true);

    const writers = SOURCES.filter((f) => WRITES.test(read(f)));
    // Три писателя, и у каждого своя роль: кабинеты владельца в таблицу сами
    // больше не пишут — только через дверь.
    expect(writers).toEqual([
      'app/api/admin/pricing-rules/route.ts', // администратор: правило сразу действующим, удаление
      'lib/tours/pricing-rule-door.ts',       // дверь владельца: просьба о правиле и о снятии
      'lib/tours/pricing-rule-review.ts',     // очередь проверки: решение администратора
    ]);
  });

  it('правило пишут две двери: администратор — действующим, владелец — на проверку', () => {
    const inserters = SOURCES.filter((f) => INSERTS.test(read(f)));
    // Третий писатель — третий путь цены на сайт мимо проверки.
    expect(inserters).toEqual([
      'app/api/admin/pricing-rules/route.ts',
      'lib/tours/pricing-rule-door.ts',
    ]);
    const insertsOf = (file: string) => {
      const src = read(file);
      return [...src.matchAll(insertsInto(TABLE, 'gi'))].map((m) => src.slice(m.index, m.index + 520));
    };
    for (const file of inserters) {
      for (const insert of insertsOf(file)) {
        expect(insert, `${file}: правило пишется без статуса — оно молча осталось бы «на проверке»`).toMatch(/moderation_status/);
      }
    }
    // Дверь владельца не может записать правило действующим: слова «approved» в её записи нет.
    const doorInserts = insertsOf('lib/tours/pricing-rule-door.ts');
    expect(doorInserts.length).toBeGreaterThan(0);
    for (const insert of doorInserts) {
      expect(insert).toMatch(/'pending'/);
      expect(insert).not.toMatch(/'approved'/);
    }
  });

  it('статус правила меняют только дверь администратора и очередь проверки', () => {
    // «approved» рядом с записью в таблицу правил — это право выпустить цену на сайт.
    const approvers = SOURCES.filter((f) => {
      const src = read(f);
      return [...src.matchAll(writesTo(TABLE, 'gi'))].some((m) => /'approved'/i.test(src.slice(m.index, m.index + 700)));
    });
    expect(approvers).toEqual([
      'app/api/admin/pricing-rules/route.ts',
      'lib/tours/pricing-rule-review.ts',
    ]);
  });
});
