/**
 * Авто-PR детерминированных находок (Эволюция 3.0, п.3; владелец 08.08:
 * «эволюция»).
 *
 * Рука уже существует: claude.yml подхватывает issues с меткой agent-proposal
 * и ведёт их до draft-PR. Недоставало мостика: находки эволюции выходили в
 * Issues без метки и ждали человека. Теперь классы, где у руки в Actions есть
 * всё для фикса из репо и текста issue (whitelist isAutoRunnable), получают
 * метку при создании — и рука стартует сама.
 *
 * Границы:
 * - только детерминированные классы; модельные догадки авто-исполнять нельзя
 *   по построению (их точность — отдельная подсистема с тормозом);
 * - funnel/intel — расследования, не механический фикс; не авто;
 * - выключатель EVO_AUTOPR=1 (Actions variable): ключ руки без кредитов —
 *   метка ушла бы в мёртвую руку и плодила красные прогоны.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isAutoRunnable } from '@/lib/agents/evo/issue-reporter';

const ROOT = process.cwd();
const RUNNER = readFileSync(join(ROOT, 'scripts/evo-report-issues.js'), 'utf-8');
const REPORT_API = readFileSync(join(ROOT, 'app/api/cron/evo-report/route.ts'), 'utf-8');
const WF = readFileSync(join(ROOT, '.github/workflows/evo-report.yml'), 'utf-8');
const CLAUDE_WF = readFileSync(join(ROOT, '.github/workflows/claude.yml'), 'utf-8');

describe('isAutoRunnable: узкий whitelist', () => {
  it('«Прод 500» — детерминированный класс с фиксом в коде → авто', () => {
    expect(isAutoRunnable({ category: 'bug', title: 'Прод 500: /api/tours/[id]', model: 'deterministic' })).toBe(true);
  });

  it('модельная догадка не авто, даже с тем же заголовком', () => {
    expect(isAutoRunnable({ category: 'bug', title: 'Прод 500: /api/tours/[id]', model: 'deepseek-v4-pro' })).toBe(false);
    expect(isAutoRunnable({ category: 'bug', title: 'Прод 500: /x', model: null })).toBe(false);
  });

  it('расследования не авто: воронка, разведка, Кузьмич-евал', () => {
    expect(isAutoRunnable({ category: 'funnel', title: 'Воронка: нет визитов', model: 'deterministic' })).toBe(false);
    expect(isAutoRunnable({ category: 'intel', title: 'Разведка: что-то', model: 'deterministic' })).toBe(false);
    expect(isAutoRunnable({ category: 'bug', title: 'Кузьмич-евал: ответы расходятся с данными', model: 'deterministic' })).toBe(false);
  });
});

describe('контур: API → раннер → метка → рука', () => {
  it('evo-report отдаёт auto_runnable по каждой находке', () => {
    expect(REPORT_API).toMatch(/auto_runnable: isAutoRunnable\(f\)/);
  });

  it('раннер вешает agent-proposal только на auto_runnable и только при EVO_AUTOPR=1', () => {
    expect(RUNNER).toMatch(/AUTO_LABEL = 'agent-proposal'/);
    expect(RUNNER).toMatch(/process\.env\.EVO_AUTOPR === '1'/);
    expect(RUNNER).toMatch(/if \(autoRunnable && AUTOPR_ENABLED\) args\.push\('--label', AUTO_LABEL\);/);
  });

  it('метка авто-запуска создаётся идемпотентно перед использованием', () => {
    expect(RUNNER).toMatch(/ensureAutoLabel/);
    expect(RUNNER).toMatch(/'label', 'create', AUTO_LABEL/);
  });

  it('workflow передаёт выключатель из Actions variables', () => {
    expect(WF).toMatch(/EVO_AUTOPR: \$\{\{ vars\.EVO_AUTOPR \}\}/);
  });

  it('рука действительно слушает эту метку (claude.yml)', () => {
    expect(CLAUDE_WF).toMatch(/github\.event\.label\.name == 'agent-proposal'/);
    expect(CLAUDE_WF).toMatch(/types: \[opened, assigned, labeled\]/);
  });
});
