/**
 * Volcano OS — merge-gate: единственный human gate (задание 27.08, ч.3–4).
 *
 * Держит края, из-за которых gate вообще заводился:
 *  - решение принимает ТОЛЬКО человек: ни workflow, ни прод не зовут
 *    merge-API; у workflow-будильника нет прав на запись;
 *  - карточка — одна (sticky-маркер), не лента комментариев;
 *  - Telegram — только о готовом PR, dedup по head_sha; отказ канала не
 *    меняет readiness;
 *  - карточка не выдумывает: Judge без пер-PR вердикта назван
 *    «не привязан», отсутствующий риск — «не описан», не «low»;
 *  - agent-PR рождается с меткой volcano-agent и секциями Риск/Откат.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildDecisionCard,
  extractSection,
  VOLCANO_CARD_MARKER,
} from '@/lib/agents/volcano/merge-gate';
import { isTransitionAllowed } from '@/lib/agents/kernel/types';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');

const basePr = {
  number: 42,
  state: 'open' as const,
  merged: false,
  draft: false,
  title: 'Тестовый agent-PR',
  body: null as string | null,
  labels: ['volcano-agent'],
  head_sha: 'abcdef1234567890',
  html_url: 'https://github.com/tourhabk-ui/pos/pull/42',
  changed_files: 3,
  additions: 120,
  deletions: 8,
};

describe('жизненный цикл code.merge', () => {
  it('новый commit снимает readiness: awaiting_merge → running разрешён', () => {
    expect(isTransitionAllowed('awaiting_merge', 'running')).toBe(true);
    expect(isTransitionAllowed('awaiting_merge', 'succeeded')).toBe(true);
    expect(isTransitionAllowed('awaiting_merge', 'rejected')).toBe(true);
  });
});

describe('extractSection: секции из тела PR', () => {
  it('находит раздел по заголовку, отсутствие — null, не пустая строка', () => {
    const body = '## Задание\nтекст\n\n## Риск\nlow: один файл\n\n## Откат\nrevert';
    expect(extractSection(body, ['Риск', 'Risk'])).toBe('low: один файл');
    expect(extractSection(body, ['Judge'])).toBeNull();
    expect(extractSection(null, ['Риск'])).toBeNull();
  });
});

describe('buildDecisionCard: одна карточка, только факты', () => {
  const card = buildDecisionCard({
    pr: basePr,
    repo: 'tourhabk-ui/pos',
    taskId: 'task-1',
    traceId: 'trace-1',
    checks: { total: 6, pending: 0, failed: 0, green: true },
    migrations: ['migrations/919_x.sql'],
  });

  it('несёт sticky-маркер, head_sha, kernel task и trace', () => {
    expect(card).toContain(VOLCANO_CARD_MARKER);
    expect(card).toContain(basePr.head_sha);
    expect(card).toContain('task-1');
    expect(card).toContain('trace-1');
  });

  it('перечисляет миграции и объём diff', () => {
    expect(card).toContain('migrations/919_x.sql');
    expect(card).toContain('+120/−8');
  });

  it('не выдумывает: Judge без вердикта — «не привязан», риск без описания — не low', () => {
    expect(card).toContain('не привязан');
    expect(card).toContain('не описан в PR');
    expect(card).not.toMatch(/Риск:\*\* low/);
  });

  it('решение — только Merge/Reject в GitHub', () => {
    expect(card).toContain('Merge или Close/Reject в GitHub');
  });
});

describe('никто не мержит, кроме человека', () => {
  it('merge-gate не зовёт merge-API GitHub', () => {
    const src = read('lib/agents/volcano/merge-gate.ts')
      .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    expect(src).not.toMatch(/\/merge['"`]/);
    expect(src).not.toMatch(/PUT.*pulls.*merge/i);
  });

  it('workflow-будильник read-only: contents: read, без записи', () => {
    // Судим по директивам YAML, не по прозе комментариев.
    const wf = read('.github/workflows/volcano-merge-gate.yml')
      .split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(wf).toMatch(/permissions:\s*\n\s*contents: read/);
    expect(wf).not.toMatch(/contents:\s*write/);
    expect(wf).toMatch(/concurrency:/);
  });

  it('endpoint: POST + CRON_SECRET + Zod, без силовых режимов', () => {
    const route = read('app/api/cron/volcano-merge-gate/route.ts');
    expect(route).toMatch(/export async function POST/);
    expect(route).toMatch(/timingSafeCompare/);
    expect(route).toMatch(/BodySchema/);
    // force-режим — это параметр запроса, а не слово в force-dynamic.
    expect(route).not.toMatch(/searchParams\.get\('force'\)|force=1|"force"/);
    expect(route).toMatch(/run_logged/);
  });
});

describe('agent-PR рождается видимым для gate', () => {
  const executor = read('lib/agents/execution/handlers/code-change-executor.ts');

  it('оба создателя PR ставят метку volcano-agent', () => {
    const labels = executor.match(/volcano-agent/g) ?? [];
    expect(labels.length).toBeGreaterThanOrEqual(2);
  });

  it('тело PR несёт секции Риск и Откат — карточке есть что цитировать', () => {
    expect(executor).toMatch(/'## Риск'/);
    expect(executor).toMatch(/'## Откат'/);
  });

  it('worker связывает PR инициативы с child-задачей code.merge', () => {
    const adapter = read('lib/agents/kernel/adapters/initiative-tasks.ts');
    expect(adapter).toMatch(/ensureCodeMergeTask/);
    expect(adapter).toMatch(/parentTaskId: task\.id/);
  });
});

describe('Telegram: только готовый PR, dedup по head_sha', () => {
  const src = read('lib/agents/volcano/merge-gate.ts');

  it('уведомление идёт владельцу и деддупится kernel-событием по head_sha', () => {
    expect(src).toMatch(/TELEGRAM_OWNER_ID/);
    expect(src).toMatch(/kind: 'telegram'/);
    expect(src).toMatch(/recordPrEventOnce/);
  });

  it('отказ Telegram не меняет readiness — фиксируется событием', () => {
    expect(src).toMatch(/telegram_failed/);
  });

  it('draft и красный CI не уведомляют: readiness требует не-draft и зелёные проверки', () => {
    expect(src).toMatch(/!pr\.draft && checks\.green/);
  });
});
