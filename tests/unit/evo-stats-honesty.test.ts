/**
 * Честные цифры эволюции. Регрессия: `getEvoStats` считал
 * `evo_growth_issues.status = 'fixed'` — статус, который НЕ ставит ни один
 * путь пайплайна, поэтому «Исправлено» на админ-дашборде было вечным 0
 * (та же болезнь мёртвых цифр, что чинили на главной).
 *
 * Инвариант: дашборд считает только по статусам, которые реально пишут
 * writer'ы (evolution-loop / feedback-loop / growth-agent / admin issues).
 * Тест статический (без БД): читает исходники и сверяет словари.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { EVO_ISSUE_STATUSES, EVO_LOG_STATUSES } from '@/lib/agents/evo/feedback-loop';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

// Все статусы, которые writer'ы РЕАЛЬНО присваивают evo_growth_issues.
// Собрано из кода: growth-agent вставляет 'open' (дефолт), loop — accepted/
// suggested, feedback — rejected, admin/evo/issues — rejected/ignored/accepted.
const WRITTEN_ISSUE_STATUSES = new Set([
  'open', 'suggested', 'accepted', 'rejected', 'ignored',
]);
// evo_evolution_log: loop пишет 'pending', evo-apply — in_progress/complete,
// feedback — merged/rejected, admin — merged/rejected.
const WRITTEN_LOG_STATUSES = new Set([
  'pending', 'in_progress', 'merged', 'complete', 'rejected',
]);

describe('evo-stats honesty — дашборд не считает несуществующие статусы', () => {
  const feedbackSrc = read('lib/agents/evo/feedback-loop.ts');

  it('getEvoStats больше не фильтрует по фантомному issue.status = fixed', () => {
    // Именно этот FILTER давал вечный 0 в «Исправлено» (комментарий-упоминание
    // фантома допустим — ловим только реальный SQL-FILTER).
    expect(feedbackSrc).not.toMatch(/FILTER\s*\(\s*WHERE\s+status\s*=\s*'fixed'\s*\)/i);
  });

  it('объявленный словарь статусов issue совпадает с тем, что реально пишут writer’ы', () => {
    for (const s of EVO_ISSUE_STATUSES) {
      expect(WRITTEN_ISSUE_STATUSES.has(s)).toBe(true);
    }
    // и наоборот — не потеряли ни одного реального статуса
    expect(new Set(EVO_ISSUE_STATUSES)).toEqual(WRITTEN_ISSUE_STATUSES);
  });

  it('объявленный словарь статусов лога совпадает с тем, что реально пишут writer’ы', () => {
    for (const s of EVO_LOG_STATUSES) {
      expect(WRITTEN_LOG_STATUSES.has(s)).toBe(true);
    }
    expect(new Set(EVO_LOG_STATUSES)).toEqual(WRITTEN_LOG_STATUSES);
  });

  it('«resolved» на дашборде — это merged+complete лога, честное «исправлено»', () => {
    // Считаем реально уехавшее, а не issue.status='fixed'.
    expect(feedbackSrc).toMatch(/IN\s*\(\s*'merged',\s*'complete'\s*\)[\s\S]*?AS\s+resolved/);
  });

  it('словари статусов покрывают то, что читает admin/evo/issues (writer второй линии)', () => {
    const issuesSrc = read('app/api/admin/evo/issues/route.ts');
    // Все литералы status = '...' / IN ('...') из admin-роута обязаны быть в словарях.
    const literals = [...issuesSrc.matchAll(/status[^\n]*?'([a-z_]+)'/g)].map(m => m[1]);
    for (const lit of literals) {
      const known = WRITTEN_ISSUE_STATUSES.has(lit) || WRITTEN_LOG_STATUSES.has(lit);
      expect(known, `admin/evo/issues пишет статус '${lit}', которого нет в словарях`).toBe(true);
    }
  });
});
