/**
 * Честные цифры эволюции. Регрессия (первая): `getEvoStats` считал
 * `evo_growth_issues.status = 'fixed'` — статус, который НЕ ставит ни один
 * путь пайплайна, поэтому «Исправлено» на админ-дашборде было вечным 0
 * (та же болезнь мёртвых цифр, что чинили на главной).
 *
 * Регрессия (вторая, 30.08): та же болезнь вернулась ДРУГИМ писателем.
 * `syncClosedIssues()` в `app/api/cron/evo-report/route.ts` завёл свой
 * статус `fixed` для находок, закрытых человеком на GitHub как `completed`
 * — а словарь дашборда его по-прежнему не знал. Находки писались исправно,
 * но пропадали из счётчика «Исправлено»: писатель и читатель статусов
 * разошлись молча. Первая версия этого теста ловила лишь ОДНОГО писателя
 * (`admin/evo/issues`) — второй остался вне проверки, поэтому регрессия и
 * прошла незамеченной. Список сканируемых писателей теперь заведён явно,
 * а не подразумевается по памяти.
 *
 * Инвариант: дашборд считает только по статусам, которые реально пишут
 * writer'ы (evolution-loop / feedback-loop / growth-agent / evo-report /
 * admin issues). Тест статический (без БД): читает исходники и сверяет
 * словари.
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

  // Каждый писатель evo_growth_issues/evo_evolution_log — поимённо, а не
  // «и так все знают, кто пишет». Именно пропуск одного писателя из этого
  // списка (evo-report) дал вторую регрессию: тест проверял admin/evo/issues
  // и не видел статус, заведённый в другом файле.
  const WRITER_FILES = [
    'app/api/admin/evo/issues/route.ts',
    'app/api/cron/evo-report/route.ts',
  ];

  it.each(WRITER_FILES)('словари статусов покрывают то, что пишет %s', (relPath) => {
    const src = read(relPath);
    // Все литералы status = '...' / IN ('...') из писателя обязаны быть в словарях.
    const literals = [...src.matchAll(/status[^\n]*?'([a-z_]+)'/g)].map(m => m[1]);
    expect(literals.length, `${relPath}: не нашёл ни одного литерала status — регэксп разошёлся с кодом`)
      .toBeGreaterThan(0);
    for (const lit of literals) {
      const known = WRITTEN_ISSUE_STATUSES.has(lit) || WRITTEN_LOG_STATUSES.has(lit);
      expect(known, `${relPath} пишет статус '${lit}', которого нет в словарях`).toBe(true);
    }
  });

  it('evo-report больше не заводит отдельный статус fixed', () => {
    // Регрессия 30.08: syncClosedIssues() писал 'fixed' — словарь дашборда
    // его не знал, и находки, закрытые человеком на GitHub, пропадали из
    // счётчика «Исправлено» при том, что писались исправно.
    const src = read('app/api/cron/evo-report/route.ts');
    expect(src).not.toMatch(/'fixed'/);
  });
});
