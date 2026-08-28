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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildDecisionCard,
  extractSection,
  fetchPr,
  GitHubUnavailableError,
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

/**
 * unavailable ≠ rejected (P0, ревью 28.08).
 *
 * 27.08 прод отдал HTTP 500 "fetch failed" на вызове GitHub API — сетевой
 * сбой, а не решение GitHub о PR. Раньше это красило прогон ТОЧНО ТАК ЖЕ,
 * как настоящий баг merge-gate: единственная попытка, generic Error, route
 * отвечал status:'failed' независимо от причины. `gh()` теперь повторяет
 * транзиентные сбои (сеть, 5xx) с задержкой и, если бюджет исчерпан, кидает
 * `GitHubUnavailableError` отдельным классом — вместо строки в сообщении,
 * которую легко перепутать с чем угодно ещё.
 */
describe('gh(): retry/backoff — сеть и 5xx повторяются, 4xx нет', () => {
  const rawPr = {
    number: 1, state: 'open' as const, merged: false, draft: false,
    title: 't', body: null as string | null, labels: [] as Array<{ name: string }>,
    head: { sha: 'sha1' }, html_url: 'https://github.com/x/y/pull/1',
    changed_files: 1, additions: 1, deletions: 0,
  };
  const okResponse = { ok: true, json: async () => rawPr } as Response;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('сетевой сбой (fetch бросает) — повтор, третья попытка успешна', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(okResponse);
    vi.stubGlobal('fetch', fetchMock);

    const promise = fetchPr('owner/repo', 1);
    await vi.runAllTimersAsync();
    const pr = await promise;

    expect(pr.number).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('5xx GitHub — тоже транзиентный, повторяется как сетевой сбой', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => 'Service Unavailable' } as Response)
      .mockResolvedValueOnce(okResponse);
    vi.stubGlobal('fetch', fetchMock);

    const promise = fetchPr('owner/repo', 1);
    await vi.runAllTimersAsync();
    const pr = await promise;

    expect(pr.number).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('бюджет retry исчерпан — GitHubUnavailableError, не generic Error', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    vi.stubGlobal('fetch', fetchMock);

    const promise = fetchPr('owner/repo', 1);
    const assertion = expect(promise).rejects.toBeInstanceOf(GitHubUnavailableError);
    await vi.runAllTimersAsync();
    await assertion;

    // Ровно 3 попытки — бюджет задан константой, не бесконечный retry.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('4xx — решение GitHub (не найден/не авторизован), НИ ОДНОГО повтора', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => 'Not Found' } as Response);
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchPr('owner/repo', 1)).rejects.toThrow(/HTTP 404/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('4xx не оборачивается в GitHubUnavailableError — это разные классы отказа', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'Bad credentials' } as Response);
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchPr('owner/repo', 1)).rejects.not.toBeInstanceOf(GitHubUnavailableError);
  });
});

describe('unavailable не путается с rejected выше по стеку', () => {
  const mergeGate = read('lib/agents/volcano/merge-gate.ts');
  const route = read('app/api/cron/volcano-merge-gate/route.ts');
  const wf = read('.github/workflows/volcano-merge-gate.yml');

  it('sweepAgentPrs ловит GitHubUnavailableError отдельно от «ошибка оценки»', () => {
    expect(mergeGate).toMatch(/if \(err instanceof GitHubUnavailableError\)/);
    expect(mergeGate).toMatch(/action: 'github_unavailable'/);
  });

  it('route: unavailable — HTTP 200 с success:false, а не 500 как настоящий сбой', () => {
    expect(route).toMatch(/err instanceof GitHubUnavailableError/);
    expect(route).toMatch(/status: 'unavailable'/);
    // 500 остаётся ТОЛЬКО для непредвиденных ошибок — unavailable-ветка его не задаёт.
    const unavailableBlock = route.slice(
      route.indexOf('if (err instanceof GitHubUnavailableError)'),
      route.indexOf('const msg = err instanceof Error'),
    );
    expect(unavailableBlock).not.toMatch(/status:\s*500/);
  });

  it('route: errors (реальная ошибка оценки) и unavailable считаются раздельно', () => {
    expect(route).toMatch(/o\.action !== 'github_unavailable'/);
    expect(route).toMatch(/unavailable\.length > 0 \? 'unavailable'/);
  });

  it('workflow: unavailable — exit 0, не красит прогон', () => {
    expect(wf).toMatch(/STATUS" = "unavailable"/);
    const skipAt = wf.indexOf('STATUS" = "unavailable"');
    const exitAt = wf.indexOf('exit 0', skipAt);
    const nextFailAt = wf.indexOf('exit 1', skipAt);
    expect(exitAt).toBeGreaterThan(skipAt);
    expect(exitAt).toBeLessThan(nextFailAt);
  });
});
