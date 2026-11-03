/**
 * Предохранитель расхода эвала Кузьмича (03.11): за день 10 ручных запусков
 * workflow дали $69 при лимите $5. Сторож держит три замка на месте.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROUTE = readFileSync(join(process.cwd(), 'app/api/cron/kuzmich-eval/route.ts'), 'utf-8');
const WF = readFileSync(join(process.cwd(), '.github/workflows/cron-kuzmich-eval.yml'), 'utf-8');

describe('эвал не идёт чаще раза в 20 ч без force', () => {
  it('окно занимается арендой до работы и отказ — 429', () => {
    expect(ROUTE).toMatch(/const EVAL_MIN_GAP_HOURS = 20;/);
    expect(ROUTE).toMatch(/claimCronWindow\(`\$\{leaseAgent\}-cost-guard`, EVAL_MIN_GAP_HOURS \* 60/);
    expect(ROUTE).toMatch(/status: 429/);
    const guardAt = ROUTE.indexOf('cost-guard');
    const workAt = ROUTE.indexOf('runKuzmichFaithfulnessEval({ questions })');
    expect(guardAt).toBeGreaterThan(0);
    expect(guardAt).toBeLessThan(workAt);
  });
  it('отказ БД при захвате — тоже отказ (лишний прогон стоит денег)', () => {
    expect(ROUTE).toMatch(/if \(lease !== 'claimed'\)/);
  });
});

describe('workflow', () => {
  it('расписание еженедельное', () => {
    expect(WF).toMatch(/cron: '0 5 \* \* 1'/);
  });
  it('два прогона сразу не идут', () => {
    expect(WF).toMatch(/concurrency:\s*\n\s*group: kuzmich-eval\s*\n\s*cancel-in-progress: true/);
  });
  it('ручной запуск по умолчанию — только base', () => {
    expect(WF).toMatch(/default: base/);
    const steps = WF.split('- name: ').filter((s) => /вопросы о турах|живые вопросы/.test(s.split('\n')[0]));
    expect(steps.length).toBe(2);
    for (const s of steps) expect(s).toMatch(/github\.event_name == 'schedule' \|\| inputs\.sets == 'all'/);
  });
});
