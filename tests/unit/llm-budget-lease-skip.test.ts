/**
 * Пропуск аренды бюджета не должен выглядеть успехом в сводке GitHub.
 * Журнал прогона его и раньше не писал. Врала галочка workflow: HTTP 200
 * и строка OK. Аренда остаётся: второй планировщик работу не дублирует.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { llmBudgetVerdict } from '../../scripts/llm-budget-step.mjs';

describe('сводка шага бюджета', () => {
  it('lease_held — предупреждение и SKIP, не OK, шаг зелёный', () => {
    const v = llmBudgetVerdict(200, JSON.stringify({
      success: true,
      skipped: 'lease_held',
      agent_id: 'llm-budget',
      window_min: 60,
    }));
    expect(v.exitCode).toBe(0);
    expect(v.measured).toBe(false);
    expect(v.lines.join('\n')).toContain('::warning::');
    expect(v.lines).toContain('SKIP lease_held');
    expect(v.lines).not.toContain('OK');
  });

  it('настоящий замер — OK', () => {
    const v = llmBudgetVerdict(200, JSON.stringify({ ok: true, status: 'ok', spent_usd: 1 }));
    expect(v).toMatchObject({ exitCode: 0, measured: true });
    expect(v.lines).toContain('OK');
  });

  it('порог не задан — предупреждение, но это не пропуск аренды', () => {
    const v = llmBudgetVerdict(200, JSON.stringify({ ok: false, status: 'not_configured' }));
    expect(v.exitCode).toBe(0);
    expect(v.measured).toBe(false);
    expect(v.lines.join('\n')).toContain('::warning::');
    expect(v.lines).toContain('OK');
  });

  it('не 200 — отказ', () => {
    const v = llmBudgetVerdict(502, '');
    expect(v.exitCode).toBe(1);
    expect(v.lines).toContain('FAIL 502');
  });

  it('workflow зовёт этот шаг и больше не печатает OK на любой 200', () => {
    const wf = readFileSync(join(process.cwd(), '.github/workflows/cron-llm-budget.yml'), 'utf8');
    expect(wf).toContain('node scripts/llm-budget-step.mjs');
    expect(wf).not.toContain('echo "OK"');
  });
});
