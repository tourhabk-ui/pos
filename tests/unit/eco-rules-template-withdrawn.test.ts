/**
 * Шаблонные правила режима (169/170) сняты с карточек в архив — 1273
 * (15.10, карт-бланш владельца «снять экошаблон», §0 «честность»).
 *
 * 169 и 170 записали в places.eco_rules один абзац на род территории каждому
 * месту, совпавшему по ILIKE, и карточка показывала его как правила места.
 * 1273 переносит в eco_rules_withdrawn ТОЛЬКО доказанный шаблон — текст,
 * совпавший целиком с одним из абзацев 169/170.
 *
 * Держится связка: список шаблонов в 1273 — ровно те тексты, что 169/170
 * присваивали (выражения вычисляются, а не сравниваются строкой исходника),
 * снимается только точное совпадение, ничего не удаляется. Выполнение
 * проверено на PostgreSQL сценой: шаблоны 169 и 170 ушли в архив, свои
 * правила и место без режима остались, повтор — no-op.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (f: string) => readFileSync(join(process.cwd(), 'migrations', f), 'utf-8');
const noComments = (sql: string) => sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

/** Значение SQL-выражения из строковых литералов, сцепленных `||`. */
function evalConcat(expr: string): string {
  const parts = [...expr.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
  expect(expr.replace(/'((?:[^']|'')*)'/g, '').replace(/\|\||\s/g, ''), `не только литералы: ${expr.slice(0, 80)}`).toBe('');
  return parts.join('');
}

/** Тексты, которые миграция присваивает eco_rules. */
function assignedRules(sql: string): string[] {
  return [...noComments(sql).matchAll(/UPDATE places SET eco_rules =\s*([\s\S]*?)\s*WHERE/g)].map((m) => evalConcat(m[1]));
}

const M1273 = read('1273_eco_rules_template_withdrawn.sql');
const BODY = noComments(M1273);
const TEMPLATES = (() => {
  const cte = BODY.slice(BODY.indexOf('WITH template(txt) AS ('), BODY.indexOf('UPDATE places p'));
  return [...cte.matchAll(/\(\s*('(?:[^']|'')*'(?:\s*\|\|\s*'(?:[^']|'')*')*)\s*\)/g)].map((m) => evalConcat(m[1]));
})();

describe('1273: шаблон правил режима — в архив', () => {
  it('список шаблонов — ровно тексты, которые записали 169 и 170', () => {
    const written = [...assignedRules(read('169_eco_fields.sql')), ...assignedRules(read('170_eco_content_expand.sql'))];
    expect(written).toHaveLength(6);
    expect([...TEMPLATES].sort()).toEqual([...new Set(written)].sort());
  });

  it('снимается только точное совпадение и только ещё не снятое', () => {
    expect(BODY).toMatch(/WHERE p\.eco_rules = t\.txt\s+AND p\.eco_rules_withdrawn IS NULL/);
    expect(BODY).not.toMatch(/ILIKE|LIKE '%/);
  });

  it('прячем, не удаляем: текст уходит в архив с причиной, строки не удаляются', () => {
    expect(BODY).toMatch(/SET eco_rules_withdrawn = p\.eco_rules,/);
    expect(BODY).toMatch(/eco_rules_withdrawn_reason = '[^']{20,}'/);
    expect(BODY).toMatch(/eco_rules = NULL/);
    expect(BODY).not.toMatch(/DELETE FROM|DROP COLUMN/);
    // Режим и пропуск — отдельный разбор: их миграция не трогает.
    expect(BODY).not.toMatch(/SET[\s\S]*eco_zone\s*=|eco_permit_required\s*=|eco_permit_url\s*=/);
  });

  it('исход называется вслух, откат записан', () => {
    expect(BODY).toMatch(/RAISE NOTICE '\[1273\]/);
    expect(M1273).toMatch(/-- UPDATE places\s+-- {4}SET eco_rules = eco_rules_withdrawn/);
  });
});
