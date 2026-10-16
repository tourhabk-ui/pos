/**
 * Security Review workflow (evo #795): AI-ревью диффа PR через официальный
 * экшен Anthropic — дополняет CodeQL.
 *
 * Сторож судит смысл workflow (разобранный YAML, вычисленные условия) и
 * исполняет шаг «Ревью состоялось» настоящим bash на подложенных итогах
 * экшена (CLAUDE.md §4, «сторож судит поведение, не текст»).
 *
 * 16.10: ревью PR #2537 получило 401 «Invalid API key» на отдельном секрете
 * CLAUDE_API_KEY и всё равно осталось зелёным — экшен на отказ API пишет
 * {"error": …} и выходит с 0. Решение владельца того же дня: ревью на
 * основном ключе ANTHROPIC_API_KEY; «не смог» — красный (§4.0).
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadWorkflow, stepByName, evalIf } from '../helpers/workflow-semantics';

const wf = loadWorkflow('.github/workflows/security-review.yml');
const job = wf.jobs.review;
const review = stepByName(job, 'Claude security review');
const verdict = stepByName(job, 'Ревью состоялось');
const skip = stepByName(job, 'Ключ не задан — пропуск');

const withKey = { env: { ANTHROPIC_API_KEY: 'sk-ant-test' } };
const noKey = { env: { ANTHROPIC_API_KEY: '' } };

/** Шаг «Ревью состоялось» на подложенном итоге экшена; null — файла нет. */
function runVerdict(results: string | null): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'secrev-'));
  try {
    if (results !== null) writeFileSync(join(dir, 'claudecode-results.json'), results);
    const r = spawnSync('bash', ['-e', '-c', verdict.run ?? ''], { cwd: dir, encoding: 'utf-8' });
    return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('security-review: ключ', () => {
  it('ревью идёт на основном ключе ANTHROPIC_API_KEY, отдельного CLAUDE_API_KEY нет', () => {
    expect(review.uses).toMatch(/^anthropics\/claude-code-security-review@[0-9a-f]{40}$/);
    const inputs = (review as { with?: Record<string, string> }).with ?? {};
    expect(inputs['claude-api-key']).toBe('${{ secrets.ANTHROPIC_API_KEY }}');
    expect((job as { env?: Record<string, string> }).env?.ANTHROPIC_API_KEY).toBe('${{ secrets.ANTHROPIC_API_KEY }}');
    expect(JSON.stringify(wf)).not.toContain('CLAUDE_API_KEY');
  });

  it('без ключа ревью и проверка итога не идут, идёт мягкий пропуск', () => {
    expect(evalIf(review.if, noKey)).toBe(false);
    expect(evalIf(verdict.if, noKey)).toBe(false);
    expect(evalIf(skip.if, noKey)).toBe(true);
  });

  it('с ключом идут ревью и проверка итога, пропуска нет', () => {
    expect(evalIf(review.if, withKey)).toBe(true);
    expect(evalIf(verdict.if, withKey)).toBe(true);
    expect(evalIf(skip.if, withKey)).toBe(false);
  });

  it('проверка итога стоит после ревью', () => {
    const names = (job.steps ?? []).map((s) => s.name);
    expect(names.indexOf('Ревью состоялось')).toBeGreaterThan(names.indexOf('Claude security review'));
  });
});

describe('security-review: «не смог» — красный (§4.0)', () => {
  it('отказ API ({"error": …}, ответ 16.10) — красный, причина одной строкой', () => {
    const r = runVerdict(JSON.stringify({ error: 'Security audit failed: Claude Code execution failed\nStdout: Invalid API key · Fix external API key' }));
    expect(r.code).toBe(1);
    const line = r.out.split('\n').find((l) => l.startsWith('::error::'));
    expect(line).toContain('Ревью безопасности не состоялось');
    expect(line).toContain('Invalid API key');
    // Перевод строки из текста ошибки не начал новую строку вывода — не мог стать новой командой workflow.
    expect(r.out.split('\n').some((l) => l.startsWith('Stdout:'))).toBe(false);
  });

  it('итога нет или он пуст — красный, а не «находок нет»', () => {
    expect(runVerdict(null).code).toBe(1);
    expect(runVerdict('').code).toBe(1);
    expect(runVerdict(null).out).toContain('не оставило итога');
  });

  it('итог не JSON-объект — красный', () => {
    expect(runVerdict('not json').code).toBe(1);
    expect(runVerdict('[1,2]').code).toBe(1);
  });

  it('ревью состоялось — зелёный и с находками, и без них', () => {
    const none = runVerdict(JSON.stringify({ findings: [] }));
    expect(none.code).toBe(0);
    expect(none.out).toContain('находок: 0');
    const two = runVerdict(JSON.stringify({ findings: [{ title: 'a' }, { title: 'b' }] }));
    expect(two.code).toBe(0);
    expect(two.out).toContain('находок: 2');
  });
});

describe('security-review: триггер и права', () => {
  it('pull_request, не pull_request_target — форки не получают секрет', () => {
    expect(Object.keys(wf.on)).toContain('pull_request');
    expect(Object.keys(wf.on)).not.toContain('pull_request_target');
  });

  it('постит комментарии на PR (совещательный режим)', () => {
    const inputs = (review as { with?: Record<string, string | boolean> }).with ?? {};
    expect(inputs['comment-pr']).toBe(true);
  });

  it('минимально необходимые права', () => {
    const perms = (wf as unknown as { permissions?: Record<string, string> }).permissions ?? {};
    expect(perms).toEqual({ contents: 'read', 'pull-requests': 'write' });
  });

  it('ревью по метке — только по своей', () => {
    const labeled = (name: string) => ({ github: { event: { action: 'labeled', label: { name } } } });
    expect(evalIf(job.if, labeled('security-review'))).toBe(true);
    expect(evalIf(job.if, labeled('triaged'))).toBe(false);
    expect(evalIf(job.if, { github: { event: { action: 'opened' } } })).toBe(true);
  });
});
