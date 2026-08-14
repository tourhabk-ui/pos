/**
 * IDOR на детальном роуте лида (разведка кабинета оператора, Рост-5):
 * «Проверки владения лидом нет — любой оператор может открыть/изменить
 * чужой лид по id». Список /api/leads скоупил лиды всегда (свои + ничейные),
 * а /api/leads/[id] — нет: requireOperator пускал ЛЮБОГО оператора к ЛЮБОМУ
 * лиду с телефоном и почтой туриста. Перед показом отчёта по лидам партнёрам
 * дыра закрыта — сторож держит закрытой.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const DETAIL = readFileSync(join(ROOT, 'app/api/leads/[id]/route.ts'), 'utf-8');
const LIST = readFileSync(join(ROOT, 'app/api/leads/route.ts'), 'utf-8');

describe('владение лидом: /api/leads/[id]', () => {
  it('GET и PATCH оба применяют скоуп владения к SQL', () => {
    // Оба запроса несут хвост условия ${scope.cond} — не только один из них.
    const scoped = DETAIL.match(/\$\{scope\.cond\}/g) ?? [];
    expect(scoped.length).toBeGreaterThanOrEqual(2);
    expect(DETAIL).toMatch(/UPDATE leads SET \$\{sets\.join\(', '\)\} WHERE id = \$\$\{idx\}\$\{scope\.cond\}/);
    expect(DETAIL).toMatch(/FROM leads WHERE id = \$1\$\{scope\.cond\}/);
  });

  it('формула владения та же, что в списке: свои ИЛИ ничейные', () => {
    // Одна мера в одном виде: оператор видит (operator_id = $ OR operator_id IS NULL)
    // и в списке, и в детали — иначе список покажет лид, а деталь его «потеряет».
    const FORMULA = /operator_id = \$\$?\{?[\w.]*\}? OR operator_id IS NULL/;
    expect(DETAIL).toMatch(FORMULA);
    expect(LIST).toMatch(FORMULA);
    // Резолв партнёра одинаковый: partners.user_id → partners.id.
    expect(DETAIL).toMatch(/SELECT id FROM partners WHERE user_id = \$1/);
    expect(LIST).toMatch(/SELECT id FROM partners WHERE user_id = \$1/);
  });

  it('админ без скоупа, оператор без партнёрской записи — только ничейные', () => {
    expect(DETAIL).toMatch(/user\.role === 'admin'.*\{ cond: '', vals: \[\] \}/);
    expect(DETAIL).toMatch(/AND operator_id IS NULL/);
  });

  it('чужой лид неотличим от несуществующего: 404, не 403', () => {
    // 403 на чужом id раскрыл бы существование лида; в роуте 403 быть не должно
    // (право роли проверяет middleware, роут отвечает только 404).
    expect(DETAIL).not.toMatch(/status: 403/);
    expect(DETAIL).toMatch(/'Лид не найден' \}, \{ status: 404/);
  });

  it('DELETE остаётся только админским', () => {
    const deleteFn = DETAIL.slice(DETAIL.indexOf('export async function DELETE'));
    expect(deleteFn).toMatch(/requireAdmin\(request\)/);
  });
});
