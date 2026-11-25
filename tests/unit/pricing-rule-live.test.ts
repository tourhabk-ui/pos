/**
 * Правило цены действует только после проверки (слово владельца 23.11:
 * «Наценки тоже показываются в модерации: цена тура меняется только через
 * одну дверь»; миграция 1513).
 *
 * Здесь — запреты по исходнику: считать цену по своему условию и писать
 * правило, не назвав статус. Поведение на схеме прода судит
 * tests/integration/pricing-rule-moderation.pg.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { PRICING_RULE_STATUSES, livePricingRuleSql } from '@/lib/tours/pricing-rule-live';

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(rel);
  }
  return out;
}

const SOURCES = [...walk('app'), ...walk('lib'), ...walk('scripts')];
const READS = /\b(FROM|JOIN)\s+tour_pricing_rules\b/;
const INSERTS = /\bINSERT\s+INTO\s+tour_pricing_rules\b/;

type Kind =
  /** Считает цену, которую видит и платит турист: только общим условием. */
  | 'price'
  /** Показывает правила владельцу или администратору — все, с их статусом. */
  | 'listing'
  /** Перепись: считает правила по своим определениям и называет их в ответе. */
  | 'census';

const READERS: Record<string, { kind: Kind; why: string }> = {
  'lib/tours/honest-price.ts': { kind: 'price', why: 'цена карточки и цена брони' },
  'lib/services/tours/dynamic-pricing.ts': { kind: 'price', why: 'пакетный расчёт цен для каналов (OCTO)' },
  'lib/tours/operator-markup.ts': { kind: 'listing', why: 'экран «наценка на выходные» у владельца' },
  'app/api/hub/operator/pricing-rules/route.ts': { kind: 'listing', why: 'экран «скидки» у владельца' },
  'app/api/admin/pricing-rules/route.ts': { kind: 'listing', why: 'список правил у администратора' },
  'app/api/cron/pricing-rules-census/route.ts': { kind: 'census', why: 'перепись правил цены' },
};

describe('условие «правило действует» — одно', () => {
  it('действует включённое и проверенное правило; псевдоним таблицы подставляется', () => {
    expect(livePricingRuleSql()).toBe("(is_active = true AND moderation_status = 'approved')");
    expect(livePricingRuleSql('pr')).toBe("(pr.is_active = true AND pr.moderation_status = 'approved')");
    expect([...PRICING_RULE_STATUSES]).toEqual(['pending', 'approved', 'rejected']);
    // Псевдоним задаёт код, но в SQL без проверки не идёт.
    expect(() => livePricingRuleSql('pr; DROP TABLE x')).toThrow();
  });

  it('статусы кода и ограничение миграции 1513 — одни и те же', () => {
    const sql = read('migrations/1513_tour_pricing_rules_moderation.sql');
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
    const found = SOURCES.filter((f) => READS.test(read(f))).sort();
    expect(found).toEqual(Object.keys(READERS).sort());
    for (const [file, r] of Object.entries(READERS)) expect(r.why.length, file).toBeGreaterThan(5);
  });

  it('цену считают только общим условием: своего «включено» у читателя цены нет', () => {
    for (const [file, r] of Object.entries(READERS)) {
      if (r.kind !== 'price') continue;
      const src = read(file);
      expect(src, `${file}: цена считается мимо общего условия`).toMatch(/livePricingRuleSql\(/);
      // Свой `is_active = TRUE` рядом с таблицей правил пропустил бы правило «на проверке».
      const own = [...src.matchAll(/\b(?:FROM|JOIN)\s+tour_pricing_rules\b[\s\S]{0,200}/g)].map((m) => m[0]);
      for (const chunk of own) expect(chunk, file).not.toMatch(/is_active\s*=\s*TRUE/i);
    }
  });

  it('правило не пишут, не назвав статус проверки', () => {
    const writers = SOURCES.filter((f) => INSERTS.test(read(f))).sort();
    expect(writers).toEqual([
      'app/api/admin/pricing-rules/route.ts',
      'app/api/hub/operator/pricing-rules/route.ts',
      'lib/tours/operator-markup.ts',
    ]);
    for (const file of writers) {
      const src = read(file);
      for (const m of src.matchAll(/\bINSERT\s+INTO\s+tour_pricing_rules\b[\s\S]{0,400}/g)) {
        expect(m[0], `${file}: правило пишется без статуса — оно молча осталось бы «на проверке»`).toMatch(/moderation_status/);
      }
    }
  });
});
