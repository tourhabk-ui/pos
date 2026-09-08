/**
 * Две находки аудита 08.09 об одном: стадия, которая НЕ отработала,
 * отчитывалась как отработавшая.
 *
 *   1. merge-gate: PR закрыт, задачу замкнуть не удалось (ядро отвергло
 *      переход) — а исход печатался как `completed_closed`. Задача при этом
 *      оставалась в `running` навсегда, sweep подбирал её каждые полчаса и
 *      каждые полчаса рапортовал «завершено».
 *   2. rescue-agent: обе проверки глушили исключение пустым `catch` и
 *      возвращали пустой список тревог. Наверху это неотличимо от «угроз
 *      нет»: `Promise.allSettled` видел стадию fulfilled, потому что отказ
 *      до него не доходил.
 *
 * Оба — §4.0: у проверки три исхода, и «не смог» не равен «хорошо».
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { ALLOWED_TRANSITIONS, isTransitionAllowed } from '@/lib/agents/kernel/types';

const GATE = readFileSync('lib/agents/volcano/merge-gate.ts', 'utf8');
const RESCUE = readFileSync('lib/agents/evo/rescue-agent.ts', 'utf8');
const ORCH = readFileSync('lib/agents/orchestrator.ts', 'utf8');

describe('merge-gate: отказ замыкания не выдаётся за завершение', () => {
  it('исход «не смогли замкнуть» существует отдельным именем', () => {
    expect(GATE).toContain("'completion_refused'");
  });

  it('completed_* печатается только после успеха или уже терминального состояния', () => {
    expect(GATE).toMatch(/const closedOut = done\.changed \|\| TERMINAL_STATES\.has\(done\.state\)/);
    const at = GATE.indexOf('const closedOut');
    expect(GATE.slice(at, at + 700)).toContain("action: 'completion_refused'");
  });

  it('отказ пишется в лог с задачей, состоянием и причиной', () => {
    expect(GATE).toContain('[merge-gate] задачу не удалось замкнуть');
    expect(GATE).toMatch(/state: done\.state, reason/);
  });

  it('исключение при оценке PR больше не маскируется под ожидание CI', () => {
    // 'waiting_ci' означает «PR в порядке, идёт CI». Исключение означает
    // «мы не знаем» — у него свой исход.
    expect(GATE).toContain("action: 'evaluation_failed'");
    const at = GATE.indexOf('[merge-gate] PR не оценён');
    expect(at).toBeGreaterThan(0);
    expect(GATE.slice(at, at + 300)).not.toContain("action: 'waiting_ci'");
  });
});

describe('матрица переходов ядра: закрыть можно из тех же состояний, что и влить', () => {
  it('running → rejected разрешён', () => {
    // Асимметрия и запирала задачу: из running можно было в succeeded
    // (PR влит), но не в rejected (PR закрыт) — хотя оба исхода приходят
    // из одной функции completePr и означают одно: человек решил.
    expect(isTransitionAllowed('running', 'rejected')).toBe(true);
  });

  it('везде, откуда можно в succeeded, можно и в rejected', () => {
    for (const [from, targets] of Object.entries(ALLOWED_TRANSITIONS)) {
      if (targets.includes('succeeded')) {
        expect(targets, `из ${from}`).toContain('rejected');
      }
    }
  });

  it('терминальные состояния по-прежнему не оживают', () => {
    for (const terminal of ['succeeded', 'rejected', 'failed_terminal', 'cancelled']) {
      expect(ALLOWED_TRANSITIONS[terminal]).toBeUndefined();
    }
  });
});

describe('rescue-agent: упавшая проверка называется упавшей', () => {
  it('пустых catch в проверках не осталось', () => {
    expect(RESCUE).not.toMatch(/\}\s*catch\s*\{\s*\n\s*\/\/[^\n]*\n\s*\}/);
    expect(RESCUE).toContain("logSwallowedFailure('rescue'");
  });

  it('результат скана несёт список НЕ отработавших проверок', () => {
    expect(RESCUE).toMatch(/failed_checks: string\[\]/);
    expect(RESCUE).toMatch(/interface CheckResult/);
  });

  it('отказ виден там же, где были бы тревоги', () => {
    expect(RESCUE).toContain("type: 'check_failed'");
    expect(RESCUE).toContain('не читать тишину как «спокойно»');
  });

  it('оркестратор переносит отказ проверки в свои ошибки', () => {
    expect(ORCH).toMatch(/rescue\?\.failed_checks \?\? \[\]/);
    expect(ORCH).toContain('RescueScan: проверка не отработала');
  });
});
